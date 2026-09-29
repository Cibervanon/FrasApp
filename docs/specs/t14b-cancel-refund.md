# Spec T14b: Cancelar reserva confirmada y reembolsar

Addendum de `docs/specs/padel-template-mvp.md` (secciones 4.4, 5.2 y 7.6, checkpoint 3b) y de
la spec `t14-payment-intent.md` (que dejo escrito: "T14b consume `computeRefund` sobre
reservas `confirmed`+`paid`, y cancela contra el PaymentIntent real"). Redactada el
2026-09-29 al cierre de T14. El E2E manual con Stripe CLI queda pendiente de las keys del
usuario, igual que en T13/T14: la spec separa lo automatizable de lo manual.

## Decisiones que esta spec cierra (preguntadas, no inferidas)

Las marcadas **[ABIERTA]** se proponen con un defecto y se confirman al aprobar esta spec.

**T14b-A. `cancel` solo opera sobre reservas `confirmed`.** Una `pending_payment` esta en
mitad de un cobro: cerrarla aqui compite con el webhook de T14 por la misma transicion y
podria cancelar un pago que Stripe esta a punto de confirmar. Una `held` es un hold sin
cobro que caduca solo a los 3 minutos. Una `cancelled`/`expired` ya esta cerrada. Resto de
estados de entrada -> **409** (`transicion invalida`), con cero llamadas a Stripe. La UI no
ofrecera el boton de cancelar hasta que la reserva este confirmada (T18).

**T14b-B. Quien puede cancelar: el dueno o un gestor. Un tercero, 404.** El dueno se
comprueba por `subDeSesion` contra `bookings.user_id`; el gestor por `esGestor` (T13, RLS
real). El 404 de tercero NO revela que la reserva existe (mismo criterio que holds y
availability): un tercero que adivine un uuid no aprende nada de la base de otro club.

**T14b-C. El reembolso va contra el PaymentIntent REAL, con el importe del motor.** Se
anade `crearReembolso({ paymentIntentId, amountCents, idempotencyKey }) -> { refundId }` al
`StripeConnectClient` (patron T14-E: contrato inyectable, impl real con
`stripe.refunds.create`). `amountCents` = `refundCents` de `computeRefund`, que sale del
snapshot `bookings.price_cents`; el `payment_intent` = `bookings.stripe_payment_intent_id`.
La `Idempotency-Key` se deriva del booking (`reembolso_${bookingId}`): dos clics
concurrentes que lleguen a Stripe con la misma key reciben el MISMO refund, y Stripe
ademas rechaza por si sola un total devuelto que supere el importe original. Doble defensa.

**T14b-D. Orden atomico: PRIMERO se cancela, DESPUES el refund de Stripe.** Si el refund
falla con la reserva ya cancelada, el socio pierde el slot (que queda libre) pero conserva
la via de recuperacion: `payment_status='paid'`, `amount_refunded_cents=0` y el endpoint
`/refund` para reintentar. El orden inverso (refund primero) dejaria dinero devuelto y una
reserva ACTIVA si el cancel falla despues: peor. Test explicito del fallo de Stripe y del
re-intento por `/refund`.

**T14b-E. `/refund` es el re-intento y el gesto del gestor; no hay refund sin cancelacion.**
Opera sobre `cancelled + payment_status='paid' + amount_refunded_cents = 0` (con intent):
dueño o gestor. Si el booking ya tiene refund -> **409** (criterio de la spec: cancelar dos
veces no devuelve el doble). Si el booking esta `confirmed` -> 409: el gestor que quiera
devolver cancela primero (T14b-A le permite), y eso dispara el reembolso. Un refund sobre
una reserva sin pago (payment_status 'unpaid') cae en la misma guarda -> 409.

**T14b-F. La politica se lee de `tenant_content['cancellation_policy']`, se valida y se
calcula en servidor.** `tenantQuery` (RLS, misma via que holds) trae el jsonb del tenant;
`validateCancellationPolicy` (T2) lo valida; un club sin politica definida en la base usa
`TRAMOS_POR_DEFECTO` del motor (el test "el default y el seed no se desincronizan" ya
protege esa pareja). `hoursBefore` se calcula en servidor como el decimal de horas entre
`now()` y `starts_at` (20h30min cae en el tramo de 12h, como en la tabla). Si `starts_at`
ya ocurrio -> **422** ANTES de llamar al motor: un `hoursBefore` negativo devolveria
`null` (sin tramo) y la cancelacion saldria a cero por un bug de fecha y no por la
politica. El cuerpo NO lleva importes: un `amount_cents` o `refund_percent` del cliente se
descarta (T14-B, mismo principio).

**T14b-G. 3 estados, el snapshot manda (decision del usuario 2026-09-29).**
`payment_status` sigue el enum `'unpaid' | 'paid' | 'refunded'` de la migracion de T9: NO
se anade `partially_refunded`. Un reembolso al 50% deja `payment_status='refunded'` +
`amount_refunded_cents` + `refund_tier_hours_before` + `refund_percent_applied` en la fila;
la pantalla de "mis reservas" (T18) deriva el "50% devuelto" del snapshot, no del enum.
Sin migracion de enum y sin tocar `types.ts` de core.

**T14b-H. `refunded` SOLO cuando hay importe. Con 0 centimos, `payment_status` sigue
`'paid'`.** [ABIERTA] Un reembolso de 0 (tramo del 0% o politica sin tramo) NO se envia a
Stripe (un refund de 0 centimos es un error de su API) y NO marca `refunded`: "refunded"
implica dinero de vuelta, y decirlo sin devolver nada es mentir en la lista de reservas.
La cancelacion procede, el snapshot guarda el tramo (0% o null) para que la pantalla
explique "no viste dinero porque la politica lo dice", y `amount_refunded_cents` queda 0.
Test explicito: cancelar con 5h -> sin llamada a Stripe, snapshot escrito, payment_status
sigue 'paid'.

## El flujo completo

```
socio (o gestor) -> POST /api/bookings/[id]/cancel
  1. resolveTenant + subDeSesion            (sin sesion -> 401)
  2. leer booking por id (tenantSession)     (no existe / de otro club -> 404)
  3. titularidad: user_id == sub o esGestor  (tercero -> 404, cero efectos)
  4. estado: status == 'confirmed'           (resto -> 409)
  5. starts_at en el futuro                  (pasada -> 422)
  6. leer politica (tenant_content) + validar (sin politica -> TRAMOS_POR_DEFECTO)
  7. computeRefund(price_cents, hoursBefore) -> RefundQuote
  8. UPDATE status='cancelled', cancelled_at, refund_tier_hours_before,
     refund_percent_applied (guarda: where status='confirmed')
     -- el snapshot se escribe AQUI y no en el paso 9: si el refund de Stripe falla,
     -- el re-intento de /refund usa el snapshot y devuelve el MISMO importe, aunque
     -- pasen horas o el club cambie la politica entre medias
     -- el EXCLUDE deja de tapar: el slot vuelve
  9. si refundCents > 0: crearReembolso (Stripe) y UPDATE payment_status='refunded',
     amount_refunded_cents (guarda: where amount_refunded_cents = 0)
     -- si Stripe falla: la reserva queda cancelled+paid+snapshot+0; /refund reintenta

gestor o dueno -> POST /api/bookings/[id]/refund
  1-3. igual (401/404/404)
  4. estado: cancelled + paid + amount_refunded_cents = 0   (resto -> 409)
  5. importe del SNAPSHOT: round(price_cents * percent / 100). El motor ya corrio en
     la cancelacion; recalcular hoursBefore aqui daria otro tramo (el reloj sigue).
     percent 0 o null -> 409 sin_importe (no hay nada que devolver, la politica lo dijo)
  6. crearReembolso + UPDATE de pago (mismas guardas)
```

## Matriz de casos (endpoint cancel)

| # | caso | resultado |
|---|---|---|
| 1 | socio dueno, 25h antes | `cancelled` + `refunded` + amount = price + snapshot (24h, 100%) |
| 2 | 24h EXACTAS | 100% (limite inclusivo, `>=`) |
| 3 | 20h antes | `refunded` + amount = mitad + snapshot (12h, 50%) |
| 4 | 12h EXACTAS | 50% |
| 5 | 5h antes | `cancelled` + payment_status sigue 'paid' + snapshot (0h, 0%), SIN llamada a Stripe |
| 6 | tercero (ni dueno ni gestor) | 404 y cero efectos (no hay Stripe, no hay update) |
| 7 | gestor que no es dueno | permitido, mismo flujo que el caso 1 |
| 8 | cancelar dos veces | segundo -> 409 |
| 9 | `starts_at` ya ocurrio | 422 |
| 10 | booking `pending_payment` | 409 (T14b-A), cero llamadas a Stripe |
| 11 | refund de Stripe falla | `cancelled` + 'paid' + amount 0; `/refund` reintenta -> `refunded` |
| 12 | body con `amount_cents` del cliente | descartado: el motor manda (T14b-F) |
| 13 | sin sesion | 401 |
| 14 | tras cancelar, la pista vuelve | insert de un hold en el MISMO slot resuelve (EXCLUDE) |

## Matriz de casos (endpoint refund)

| # | caso | resultado |
|---|---|---|
| 15 | sobre `cancelled`+'paid' sin refund | `refunded`, mismo importe del motor |
| 16 | segundo refund (ya tiene) | 409 |
| 17 | sobre `confirmed` (no cancelada) | 409 (T14b-E) |
| 18 | tercero | 404 |
| 19 | sobre `cancelled` sin pago ('unpaid') | 409 (la guarda de pago no pasa) |

## Matriz de tests (desglose E1-E4, TDD: ROJO antes que implementacion)

- **E1: lib `src/lib/server/cancelaciones.ts` + tests DB.** El motor cableado a Postgres
  REAL: los 5 casos de la tabla pasando por la fila y el jsonb (no solo la funcion pura de
  T8), guardas de estado, snapshot, titularidad, 422, y el "sin politica en la base usa
  TRAMOS_POR_DEFECTO". Test de la tabla: 25h->100%, 24h->100%, 20h->50%, 12h->50%, 5h->0%.
- **E2: `POST /api/bookings/[id]/cancel` + tests.** Matriz 1-14 con el cliente falso
  inyectado (patron T13/T14), `clearTenantCache` y respuestas exactas del handler.
- **E3: `POST /api/bookings/[id]/refund` + tests.** Matriz 15-19, mismo cliente falso
  ampliado con `crearReembolso`.
- **E4: `pnpm verify` raiz + detect-changes + memorias.**

## Fuera de alcance de T14b

- La pantalla `/reservas` con el boton de cancelar (T18): aqui solo la API y sus datos.
- `audit_log` con el historial de eventos (T19): el snapshot en la fila es la auditoria
  funcional hasta entonces.
- El reembolso parcial como ESTADO (T14b-G, decidido: 3 estados).
- Reembolsos manuales con importe libre del gestor (no hay endpoint que lo pida; la
  dashboard de Stripe lo permite si algun dia hace falta).
- La cancelacion de un booking `pending_payment` (T14b-A: compite con el webhook).

## Criterios de aceptacion

- [ ] `POST /api/bookings/[id]/cancel` dispara el reembolso con `computeRefund`, leyendo
      los tramos de `tenant_content['cancellation_policy']`
- [ ] Los 5 casos de la tabla pasan de `computeRefund` hasta la fila: el importe devuelto
      por el fake coincide con el del motor
- [ ] Solo el dueno o un gestor puede cancelar; un tercero recibe 404 y cero efectos
- [ ] El snapshot (`refund_tier_hours_before`, `refund_percent_applied`) queda en el
      booking aunque el club cambie la politica despues
- [ ] `amount_refunded_cents` se actualiza y nunca supera `price_cents` (check de la base)
- [ ] `payment_status` pasa a `'refunded'` SOLO con importe (T14b-H)
- [ ] El slot se libera: test explicito de la pista que vuelve (EXCLUDE)
- [ ] Cancelar dos veces no devuelve el doble: segundo intento 409
- [ ] Cancelar una reserva ya pasada no reembolsa: 422
- [ ] El reembolso va contra el PaymentIntent real (`stripe_payment_intent_id`), con
      Idempotency-Key derivada del booking
- [ ] `POST /api/bookings/[id]/refund` reejecuta el reembolso (dueño o gestor) y 409 si ya
      esta devuelto
- [ ] Un `pending_payment` no se cancela por aqui: 409 (T14b-A)
