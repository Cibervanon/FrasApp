# Spec T14: PaymentIntent con destino al club y webhook idempotente

Addendum de `docs/specs/padel-template-mvp.md` (secciones 5.2, 6.2 y 7.6) y de la spec
`t13-stripe-connect.md` (que dijo: "los de `payment_intent.*` entran en T14"). Aprobada el
2026-09-28 junto al cierre de T13 C4. El E2E manual con Stripe CLI queda pendiente de las
keys del usuario, igual que el C5 de T13: la spec separa lo automatizable de lo manual.

## Decisiones que esta spec cierra (preguntadas, no inferidas)

Las dos marcadas **[ABIERTA]** se proponen con un defecto y se confirman al aprobar esta
spec.

**T14-A. `POST /api/payments/intent ` es el UNICO endpoint de T14 que crea el cobro.** Recibe
`{ hold_id }` y hace dos cosas atomicas: transiciona el booking `held -> pending_payment` y
crea el PaymentIntent. **No hay `POST /api/bookings` en T14**: el pending_payment lo crea
este endpoint sobre el hold de T11. La tabla 5.1 de la spec principal lista
`POST /api/bookings` ("confirma: hold -> pending_payment + PaymentIntent"); T14 lo absorbe
como comportamiento del intent para no tener dos rutas que compiten por la misma transicion.
Si la pantalla de confirmar (T18a) necesitara un endpoint de booking separado, se decide
alli; para el dinero, uno solo.

**T14-B. El importe lo calcula el servidor, y se lee de `bookings.price_cents` (snapshot de
T12), nunca de la peticion.** El POST se valida con un esquema estricto: solo `hold_id`. Un
`amount_cents`, `price` o `total` en el body es descartado (zod lo quita), y el intent se
crea SIEMPRE con el snapshot. Test explicito: body con importe distinto -> el intent usa el
del snapshot.

**T14-C. Cobrar antes de comprobar la capacidad de cobro es un error de diseno.** El
endpoint mira `estadoConnectDelTenant(tenantId)` ANTES de llamar a Stripe. Sin
`stripe_account_id` o con `charges_enabled = false`: **503 `tenant_payments_not_ready`** y
cero llamadas al cliente de Stripe (el fake cuenta las llamadas en el test). Ese 503 es el
aviso de la pantalla "el club esta configurando los pagos" (6.2), nunca un error de Stripe
crudo.

**T14-D. `application_fee_amount` ausente mientras la comision sea 0.** El PaymentIntent se
crea con `transfer_data.destination = tenants.stripe_account_id` y SIN `application_fee_amount`
porque `COMISION_PLATAFORMA_CENTS = 0` (OQ-13, importado de T13). Test anclado: si alguien
anade `application_fee_amount` sin tocar la spec, revienta. El dinero va directo al club.

**T14-E. El webhook de T13 se extiende, no se duplica.** Misma ruta, misma primacia de la
firma, mismo patron de respuesta: `payment_intent.succeeded`, `payment_intent.payment_failed`
y `account.updated` se manejan; cualquier otro evento -> 200 ack. Las transiciones SOLO se
ejecutan desde el estado `pending_payment`:

| evento | transicion | notas |
|---|---|---|
| `payment_intent.succeeded` | `pending_payment -> confirmed`, `payment_status='paid'`, `confirmed_at=now()` | Nunca resucita un `cancelled`/`expired`: si el booking no esta en `pending_payment`, 200 sin efectos |
| `payment_intent.payment_failed` | `pending_payment -> cancelled`, `cancelled_at=now()`, `payment_status` sigue `'unpaid'` | El slot se libera porque el `EXCLUDE` solo bloquea held/pending_payment/confirmed |

El binding del evento al booking es por `bookings.stripe_payment_intent_id`: el indice
unico parcial de la migracion (T14-F) garantiza a lo sumo una fila. El webhook busca por
`baseQuery` (lo autoriza la firma, como `account.updated`).

**T14-F. Idempotencia por ESTADO, y no por `event.id` en `audit_log` **[ABIERTA]**. La spec
principal (5.2, punto 3) dice "idempotencia por `event.id` guardado en `audit_log`", pero
`audit_log` es de T19 y todavia no existe. Proposito para T14: la guarda de estado —
reprocesar un evento cuyo efecto ya esta escrito es un no-op (un `confirmed`+`paid` que se
re-escribe no toca nada; un `cancelled` tratado de nuevo no cancela dos veces). El criterio de
aceptacion que se testea es el de la spec ("reprocesar el mismo `event.id` no duplica
efectos", 3 veces el mismo id) y la guarda de estado lo cumple sin tabla nueva. Cuando T19
cree `audit_log`, se apunta tambien del webhook para historial; la idempotencia funcional
sigue siendo la guarda de estado. Si prefieres `audit_log` antes (tabla de eventos procesados
en T14), se hace, pero duplica trabajo con T19.

**T14-G. El contrato de T13 se extiende.** `StripeConnectClient` (en `stripe-connect.ts`)
gana `crearPaymentIntent` y `recuperarPaymentIntent`. El cliente real de `crearClienteStripe()`
los implementa con `stripe.paymentIntents.create/retrieve`: `amount + currency` del booking,
`transfer_data.destination`, `automatic_payment_methods.enabled`, y una `Idempotency-Key`
derivada del booking para que un reintento del POST no cree dos intents. El navegador NUNCA
confirma la reserva: a lo sumo confirma el pago (Stripe Elements, T18a); la reserva la
confirma solo el webhook. `client_secret` viaja al cliente pero no se persiste.

## Que es y que no

**SI es de T14:** la migracion de coherencia de pagos, el endpoint de intent (con su
transicion de estado), las ramas de `payment_intent.*` del webhook, y los tests de todo ello
con el cliente Stripe falso. La verificacion automatizable (verify completo + detect-changes)
tambien.

**NO es de T14:** el formulario de tarjeta ni el boton "Pagar 24,00 EUR" (Stripe Elements +
`@stripe/stripe-js` + la key publicable de Stripe son de T18a); el reembolso ni la
cancelacion de reservas (T14b); el 3D Secure en PWA standalone (T20, dispositivo real); la
tabla `audit_log` (T19); el E2E manual con Stripe CLI (pendiente de las keys, como el C5 de
T13).

## Modelo de datos: migracion `20260930000000_payments_intent.sql`

`bookings` ya tiene todas las columnas (T9): `stripe_payment_intent_id`,
`payment_status`, `confirmed_at`, `cancelled_at`. La migracion de T14 NO anade columnas:
anade coherencia que el flujo de pagos necesita y nadie garantizaba:

```sql
-- un PaymentIntent es de UNA reserva. El indice es parcial y escalado por tenant.
create unique index bookings_stripe_payment_intent_uidx
  on public.bookings (tenant_id, stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- pending_payment sin intent es un cobro imposible de confirmar.
alter table public.bookings add constraint bookings_pending_payment_needs_intent
  check (status <> 'pending_payment' or stripe_payment_intent_id is not null);

-- pending_payment siempre esta sin pagar. Nada entra en pending_payment ya pagado.
alter table public.bookings add constraint bookings_pending_payment_unpaid
  check (status <> 'pending_payment' or payment_status is not distinct from 'unpaid');

-- confirma el webhook, y el webhook solo confirma pagando.
alter table public.bookings add constraint bookings_confirmed_is_paid
  check (status <> 'confirmed' or payment_status is not distinct from 'paid');
```

`is not distinct from` es la forma FINAL (E1 la endurecio tras un test rojo): con `= 'unpaid'`,
una fila con `payment_status` NULL deja el check en NULL y Postgres lo DEJA pasar. El test
"pending_payment sin payment_status (NULL)" es el que obliga a esta forma, y es la unica
que cubre el agujero.

`bookings_confirmed_is_paid` es compatible con T15 (partido abierto inserta `confirmed` +
`paid` de una pieza). El `application_fee_amount` es 0 por defecto de la columna (T9) y no
se envia en el intent mientras la comision sea 0.

## Contrato del endpoint

### `POST /api/payments/intent` — autenticado (socio)

Body: `{ "hold_id": "uuid" }`. El `stripe_account_id` y los flags se leen de `tenants` del
tenant del JWT. La reserva se busca con `tenantQuery` (RLS): titular = `sub` del JWT.

| caso | respuesta |
|---|---|
| Sin sesion (`sub` null) | 401 |
| `hold_id` de otro socio o inexistente | 404, sin confirmar existencia |
| Booking en `expired` (hold caducado) | 409 `hold_expired` |
| Sin `stripe_account_id` en `tenants` | 503 `tenant_payments_not_ready`, cero llamadas a Stripe |
| `stripe_charges_enabled = false` | 503 `tenant_payments_not_ready`, cero llamadas a Stripe |
| Booking en `held`, todo correcto | Transiciona a `pending_payment` (`payment_status='unpaid'`, `hold_expires_at` a null) y crea el intent; 200 `{ payment_intent_id, client_secret }` |
| Booking ya en `pending_payment` (doble-click) | "Recupera": `recuperarPaymentIntent` y 200 con el MISMO id y su `client_secret`; `crearPaymentIntent` se llama 1 sola vez |
| Booking ya en `confirmed` (doble-click tras webhook) | 200 `{ payment_intent_id, estado: "paid" }` sin pedir secret nuevo |
| Cualquier otro estado | 409 |
| Error de Stripe | 500 generico al cliente; detalle solo al log |

El importe del intent sale de `bookings.price_cents` (snapshot de T12/T5). El body con
cualquier importe se descarta. La transicion y la creacion del intent: primero se crea el
intent (Stripe), luego se marca la fila. Si el update falla tras crear el intent, queda un
intent huerfano sin cargar: el proximo POST crea otro y usa ese; la `Idempotency-Key`
derivada del booking evita que un reintento del MISMO POST duplique.

## Contratos del webhook (ramas nuevas de `manejarWebhook`)

Firma primero (401 sin cabecera o invalida), igual que T13. Busqueda por
`stripe_payment_intent_id` con `baseQuery`:

| caso | respuesta |
|---|---|
| `payment_intent.succeeded` y booking en `pending_payment` | `confirmed` + `paid` + `confirmed_at`. 200 |
| `payment_intent.succeeded` sin booking (otra instancia) | 200 sin efectos |
| `payment_intent.succeeded` sobre booking `cancelled`/`expired`/`confirmed` | 200 sin efectos (no resucita; el replay idempotente paga aqui) |
| `payment_intent.payment_failed` y booking en `pending_payment` | `cancelled` + `cancelled_at`. El slot queda libre por el EXCLUDE. 200 |
| `payment_intent.payment_failed` reiterado o sobre booking ya terminal | 200 sin efectos |
| Evento desconocido (`payment_intent.*` no manejado u otros) | 200 vacio (ack) |
| `account.updated` | Igual que T13 (no regresion) |
| Firma valida pero error interno | 500 (Stripe reintenta) |

## Matriz de casos (los tests se escriben ROJOS antes de la implementacion)

Todo con cliente Stripe falso (el patron de T13) y Postgres real, nunca mocks para RLS.

### DB — `bookings.payments-intent.db.test.ts`

1. `pending_payment` sin `stripe_payment_intent_id` -> rechaza `bookings_pending_payment_needs_intent`
2. `pending_payment` con `payment_status != 'unpaid'` -> rechaza `bookings_pending_payment_unpaid`
3. `confirmed` con `payment_status != 'paid'` -> rechaza `bookings_confirmed_is_paid`
4. `confirmed` + `'paid'` sigue entrando (no es un check que rompa T15)
5. El mismo `stripe_payment_intent_id` en dos bookings del MISMO tenant -> violacion del indice unico
6. El mismo intent id en dos tenants distintos -> se inserta (el indice es por tenant; control negativo)

### Endpoint — `src/app/api/payments/payments-intent.route.db.test.ts`

7. Sin sesion -> 401
8. `hold_id` de otro socio -> 404
9. Hold caducado (`expired`) -> 409
10. Tenant sin cuenta Express -> 503, el fake no recibe llamadas
11. `charges_enabled=false` -> 503, el fake no recibe llamadas
12. Camino feliz: intent con `amount = price_cents`, `currency='eur'`,
    `transfer_data.destination = stripe_account_id`, SIN `application_fee_amount`; booking
    en `pending_payment`, `payment_status='unpaid'`, `hold_expires_at` null; 200 con id + secret
13. Body con `amount_cents` distinto -> el intent usa el snapshot (el importe del cliente se descarta)
14. Doble POST del mismo hold -> el segundo "recupera": mismo id y secret, `crear` llamado 1 vez
15. Booking ya `confirmed` -> 200 `estado='paid'`
16. `COMISION_PLATAFORMA_CENTS > 0` -> falla (anclaje: si alguien sube la comision, los tests lo dicen)

### Webhook — se extiende `stripe-connect.route.db.test.ts`

17. `succeeded` desde `pending_payment` -> `confirmed` + `paid` + `confirmed_at`
18. El MISMO `event.id` (`succeeded`) enviado 3 veces -> UN solo efecto (confirmed_at estable)
19. `succeeded` sin booking por ese intent -> 200 ack sin cambios
20. `succeeded` sobre booking `cancelled` -> no resucita, queda `cancelled`
21. `payment_failed` desde `pending_payment` -> `cancelled` + `cancelled_at`, `payment_status='unpaid'`
22. El MISMO `event.id` (`payment_failed`) 3 veces -> un solo efecto
23. `payment_failed` sobre booking ya `confirmed` -> no toca
24. Evento desconocido (`payment_intent.amount_capturable_updated`) -> 200 ack sin efectos
25. Tras `payment_failed`, un nuevo hold sobre la misma pista entra (el slot se libero)
26. `account.updated` sigue funcionando (regresion)
27. Sin firma o firma invalida -> 401 (regresion)

## Criterios de aceptacion (del plan, sin cambios)

- [ ] El importe lo calcula el servidor. Un importe del cliente se descarta
- [ ] `transfer_data.destination` = `tenants.stripe_account_id`
- [ ] **No lleva `application_fee_amount` mientras la comision sea 0**
- [ ] Si `stripe_charges_enabled = false`: 503 `tenant_payments_not_ready`, no un error crudo de Stripe
- [ ] El webhook sin firma valida devuelve 401
- [ ] `payment_intent.succeeded` -> `confirmed` + `paid`
- [ ] Reprocesar el mismo `event.id` no duplica efectos
- [ ] `payment_intent.payment_failed` -> `cancelled` y libera el slot

## Que SI deja preparado T14 para T14b

T14b (cancelar + reembolsar) consume `computeRefund` sobre reservas `confirmed`+`paid`, y
cancela contra el PaymentIntent real (`stripe_payment_intent_id` ya esta en la fila y es
unico). El `payment_status` guarda la base: `unpaid` -> `paid` -> `refunded`. T14 termina con
el flujo de cobro completo: hold -> pending_payment -> (webhook) -> confirmed/paid, o si el
pago falla, cancelled y slot libre.

## Verificacion

**Automatizable (en esta spec):** red-green en las matrices 1-27, `pnpm verify` raiz en
verde (encoding, typecheck, lint, unitarios, `test:db`, build) y `gitnexus detect-changes`
con sus 4 flujos revisados. Todo con el cliente falso.

**Manual, pendiente de las keys del usuario (junto al C5 de T13):** runbook en test mode —
`stripe listen --forward-to http://localhost:3000/api/stripe/webhook`, crear un hold y un
intent reales por la UI, pagar con tarjeta de control (4242 4242 4242 4242) con el 3D Secure
de la prueba, y confirmar que el webhook confirma la reserva; y un `payment_failed` con la
tarjeta de rechazo (4000 0000 0000 0002) para ver el slot liberarse.

## Dependencias

- T13 (cuenta Express, `COMISION_PLATAFORMA_CENTS`, firma del webhook, `estadoConnectDelTenant`)
- T12 (`bookings.price_cents` snapshot; el motor de precios ya resolvio al crear el hold)
- T11 (el hold con su fila `held`)
- T8/T14c: no para el dinero, si para la pantalla de confirmar (T18a)
- T15: depende de T14 (sus bookings nacen `confirmed`+`paid`, compatibles con los checks)

## Ficheros

- `supabase/migrations/20260930000000_payments_intent.sql` (nuevo)
- `apps/padel-template/src/lib/server/stripe-connect.ts` (extiende `StripeConnectClient`)
- `apps/padel-template/src/app/api/payments/intent/route.ts` (nuevo)
- `apps/padel-template/src/app/api/stripe/webhook/route.ts` (ramas nuevas)
- `apps/padel-template/src/lib/bookings.payments-intent.db.test.ts` (nuevo)
- `apps/padel-template/src/app/api/payments/payments-intent.route.db.test.ts` (nuevo)
- `apps/padel-template/src/app/api/stripe/stripe-connect.route.db.test.ts` (se extiende)