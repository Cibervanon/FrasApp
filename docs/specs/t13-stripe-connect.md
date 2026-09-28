# Spec T13: Stripe Connect — onboarding y `/admin/pagos`

Aprobada por el usuario el 2026-09-28. Parent: `padel-template-mvp.md` secciones 4.1, 5.2,
6.3 (pantalla 20) y 7.6. Deriva de `tasks/todo.md` T13. **Bloqueante del MVP: sin esto el
club no cobra.**

## Decisiones que esta spec cierra (preguntadas, no inferidas)

| decision | resolucion | por que |
|---|---|---|
| Identidad del gestor | Tabla nueva `tenant_members(tenant_id, user_id, role)` con `check (role = 'gestor')`: un solo rol, sin niveles de permiso | El spec madre (OQ-7) dice "sin tabla de roles", pero no define como sabe el servidor que quien llama es el gestor de un tenant. Sin eso, los endpoints de T13 no se pueden proteger. Un solo rol permitido cumple OQ-7 y cierra el hueco. Decidido con el usuario el 2026-09-28 |
| Dependencia `stripe` de npm | Se instala en el workspace de la app | La validacion de firma del webhook (`stripe.webhooks.constructEvent` y `generateTestHeaderString`) es codigo cryptografico que no se reescribe a mano. Es un cambio de lockfile: **se confirma al aprobar esta spec** |
| Stripe CLI | Instalado via winget (1.52.0) el 2026-09-28, con permiso del usuario | Para el E2E del webhook en local (`stripe listen --forward-to`). Ya operable |
| Cuenta Express repetida | Si el tenant ya tiene `stripe_account_id`, se reutiliza y se pide otro Account Link. Nunca una cuenta nueva por click | Doble-click en "Conectar" no debe crear dos cuentas. La 4 columnas de Connect ya estan en `tenants` desde la migracion de T1 |
| `return` sincroniza estado | `GET /api/stripe/connect/return?setup=complete` lee la cuenta en Stripe y actualiza los flags antes de redirigir | El webhook `account.updated` es la autoridad final, pero puede tardar. El return refresca el panel al instante con un `retrieve` de la cuenta |
| Webhook: alcance T13 | Se implementa firma + `account.updated`; cualquier otro evento responde 200 sin efectos | Los handler de `payment_intent.*` son T14. Stripe reintenta los 4xx/5xx, asi que un evento que todavia no se maneja se ACK con 200 (T14 lo engancha ahi). `account.updated` es idempotente por naturaleza: escribe booleanos |
| Comision a 0 | Se ancla `COMISION_PLATAFORMA_CENTS = 0` en el lib de stripe, con test propio, y el criterio de OQ-13 ("el PaymentIntent NO lleva application_fee_amount estando a 0") se copia a T14, donde se crea el PaymentIntent | El test de la comision necesita un PaymentIntent y ese es T14. T7 sento el precedente: los criterios que no se pueden cumplir se copian adelante, no se simulan. `STRIPE_PLATFORM_FEE_PERCENT` existe en env pero **no se consume** en T13 |
| Flag `payments` y pantalla 20 | `/admin/pagos` se muestra aunque el flag este apagado | El toggle de `payments` es pantalla 19 (`/admin/ajustes`, tarea T18d/e). El gate 503 de `charges_enabled` es del endpoint de pago y es T14. T13 no toca ninguno de los dos |
| Gestor de demo | La seed crea una persona en `auth.users` y su fila en `tenant_members` del tenant de demo | Sin gestor sembrado, `/admin/pagos` no se puede probar en desarrollo |

## Que es y que no

**Es:**

- La migracion `20260929000000_tenant_members.sql`: tabla nueva con RLS completa (regla 2
  de AGENTS), y la seed del gestor de demo.
- `src/lib/server/stripe-connect.ts`: crear/reutilizar cuenta Express, pedir Account Link,
  sincronizar el estado (charges/payouts/onboarding_completed_at) desde Stripe, y la
  constante de comision.
- `esGestor`: la comprobacion de que el `sub` de la sesion tiene fila de gestor en
  `tenant_members`, bajo el mismo viaje `tenantQuery` que el resto (la RLS ahi dentro).
- `POST /api/stripe/connect/onboard` (gestor), `GET /api/stripe/connect/return` (gestor),
  `POST /api/stripe/webhook` (firma Stripe).
- La pantalla `/admin/pagos` y su `admin/layout.tsx` minimo.

**NO es T13** (y por tanto no se toca):

- `POST /api/payments/intent`, la creacion del PaymentIntent y el 503
  `tenant_payments_not_ready`. Es T14.
- Los handler de `payment_intent.succeeded` / `payment_failed` y la idempotencia por
  `event.id` en `audit_log`. Es T14.
- El reembolso y sus tramos. Es T14b.
- El toggle de `payments` en `/admin/ajustes`. Es T18d/e.
- La verificacion criptografica del JWT de sesion. Sigue pendiente (criterio 6.2), el
  `sub` sigue atribuyendo y nada mas. Esta spec NO lo cierra.

## Modelo de datos

```sql
-- 20260929000000_tenant_members.sql
-- Quien es el gestor de un tenant. Un solo rol permitido (OQ-7): no hay niveles.
create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id),

  constraint tenant_members_role_gestor check (role = 'gestor')
);
```

- RLS con `FORCE ROW LEVEL SECURITY` y politica por operacion, `to authenticated`, con
  `using (tenant_id = public.current_tenant_id())` y `with check` en insert/update. Mismo
  patron exacto que `tenant_branding` en la migracion de T1.
- `auth.users` solo por `id` (convencion 4). En local existe el shim; en produccion la
  gestiona GoTrue, igual que `bookings.user_id`.
- **Un usuario puede ser gestor de mas de un tenant.** La PK es `(tenant_id, user_id)` y no
  hay restriccion sobre `user_id` solo: no hay motivo en la spec para prohibirlo y
  prohibirlo seria codigo para un caso que los dos tenants del harness no producen. El
  aislamiento lo sigue dando la RLS (`tenant_id` del JWT), no la tabla.

### Seed del gestor de demo

`seed.sql` inserta en `auth.users` una persona con id fijo (documentado en el propio seed,
como el id del tenant de demo) y en `tenant_members` su fila `('club-padel-demo', <id>,
'gestor')`. Idempotente con `on conflict do nothing`.

## Flujo de onboarding (pantalla 20)

1. El gestor entra en `/admin/pagos`. Servidor: si el `sub` de la cookie no tiene fila de
   gestor, redirige a `/`. Si `stripe_charges_enabled`, la pagina dice "Los cobros estan
   conectados". Si no, dice "Conectar los cobros de mi club" con un boton.
2. El boton (`ConectarCobros`, componente cliente) hace `POST /api/stripe/connect/onboard`.
3. El servidor crea (o reutiliza) la cuenta Express, pide el Account Link
   (`type: 'account_onboarding'`, `return_url` = `NEXT_PUBLIC_APP_URL + /api/stripe/connect/return?setup=complete`,
   `refresh_url` = `NEXT_PUBLIC_APP_URL + /admin/pagos?setup=refresh`) y devuelve la url.
4. El navegador sale a Stripe, el gestor completa el onboarding (test mode o real).
5. Stripe redirige a `return?setup=complete`. El servidor sincroniza el estado con
   `retrieve` (charges/payouts), actualiza `tenants` y redirige (302) a `/admin/pagos`.
6. En paralelo, el webhook `account.updated` mantiene los flags al dia, que es la
   autoridad final si el gestor cierra la pestana antes del paso 5.

## Contrato del lib `stripe-connect.ts`

```ts
// Inyeccion para testear el flujo sin llamar a la API de Stripe de verdad.
// Por defecto se construye con STRIPE_SECRET_KEY.
export interface StripeConnectClient {
  crearCuentaExpress(): Promise<{ id: string }>;
  obtenerAccountLink(accountId: string, urls: { refresh: string; return: string }): Promise<string>;
  obtenerCuenta(accountId: string): Promise<{ chargesEnabled: boolean; payoutsEnabled: boolean }>;
}

export const COMISION_PLATAFORMA_CENTS = 0;

export async function cuentaExpressOIdExistente(client, tenantId): Promise<string>;
export async function sincronizarEstadoConnect(client, accountId): Promise<{ chargesEnabled; payoutsEnabled }>;
export async function esGestor(tenantId, sub): Promise<boolean>;
```

- `cuentaExpressOIdExistente`: lee `tenants.stripe_account_id` (via `baseQuery`, la tabla
  no tiene RLS); si existe, la devuelve; si no, crea la cuenta Express y la guarda.
- `sincronizarEstadoConnect`: `obtenerCuenta`, y con sus flags actualiza la fila del
  tenant que tenga ese `stripe_account_id`. Guarda `stripe_onboarding_completed_at = now()`
  SOLO en la transicion a charges habilitado (no machaca una fecha ya puesta).
- `esGestor`: `tenantQuery(tenantId, sql con sub)` un `select 1 from tenant_members
  where user_id = $sub`. `false` si no hay fila. La RLS hace el aislamiento.

## Contratos de las rutas

### `POST /api/stripe/connect/onboard` — gestor

| caso | respuesta |
|---|---|
| Sin sesion (`sub` null) | 401 |
| Con sesion, sin fila de gestor | 403, copy accionable sin jerga |
| Gestor, sin cuenta en `tenants` | Crea la cuenta Express y el Account Link; 200 `{ accountLinkUrl }` |
| Gestor, con cuenta existente | Reutiliza; 200 `{ accountLinkUrl }` |
| Error de Stripe | 500 generico "No se pudieron conectar los cobros."; el detalle completo solo al log (criterio 6.1) |

### `GET /api/stripe/connect/return?setup=complete` — gestor

| caso | respuesta |
|---|---|
| Sin sesion / sin fila de gestor | 401 / 403 |
| Sin `stripe_account_id` en `tenants` | 302 a `/admin/pagos`, sin tocar Stripe |
| `setup=complete` con cuenta | Sincroniza estado y 302 a `/admin/pagos` |
| Cualquier otro query param | 302 a `/admin/pagos` sin sincronizar |

### `POST /api/stripe/webhook` — firma Stripe

El cuerpo se lee en bruto (`request.text()`) y se valida con
`stripe.webhooks.constructEvent(cuerpo, firmasignature, STRIPE_WEBHOOK_SECRET)`.

| caso | respuesta |
|---|---|
| Sin cabecera `stripe-signature` o firma invalida | **401** (criterio 7.6) |
| `account.updated` | Busca el tenant por `stripe_account_id` y sincroniza flags. 200 |
| `account.updated` de una cuenta sin tenant en esta base | 200 sin efectos (instancia limpia; los tests «acepta» no rompen) |
| Cualquier otro tipo de evento | 200 vacio (ack; los handlers son T14) |
| Firma valida pero error interno | 500 (Stripe reintenta) |

El webhook escribe en `tenants`, que no tiene RLS: la confianza la da la firma, no un rol.
Por eso el orden es firma PRIMERO, efecto despues. Sin firma valida no hay ninguna query.

## Auth, en resumen

- 401 = no hay `sub` en la cookie (mismo criterio que `POST /api/holds`).
- 403 = hay `sub` pero no es gestor de ESTE tenant. Un `sub` de otro tenant no ve la fila
  por la RLS de `tenant_members`, test obligatorio.
- El webhook no pasa por el gestor: pasa por la firma.

## Copy sin jerga (regla 5)

Todos los strings que ve el gestor se escriben literal en esta spec, sin terminos
tecnicos:

- Estado pendiente: **"Conectar los cobros de mi club"** + "Para que los socios puedan
  pagar, conecta los cobros con tu banco."
- Estado conectado: **"Los cobros estan conectados"**.
- 403: "No tienes permiso para gestionar los cobros de este club."
- 500 de Stripe: "No se pudieron conectar los cobros. Vuelve a intentarlo en unos
  minutos."
- La URL de onboarding la abre el boton en pestana nueva; jamas se pinta un error de
  Stripe en la pantalla.

## Matriz de casos (los tests se escriben ROJOS antes de la implementacion)

### DB — `tenant-members.db.test.ts`

| # | caso | resultado |
|---|---|---|
| 1 | RLS: el JWT de tenant A no ve filas del B, en las 4 operaciones | 0 filas / INSERT rechazado |
| 2 | `role` distinto de `'gestor'` | rechazado por el `check` |
| 3 | FK: borrar el tenant borra sus miembros (cascade) | sin huerfanos |
| 4 | FK: borrar el usuario de `auth.users` borra su fila (cascade) | sin huerfanos |
| 5 | un usuario puede ser gestor de A y de B a la vez | 2 filas, ambas legibles en su tenant |
| 6 | la PK compuesta (A, u1) y (A, u2) | dos gestores del mismo club conviven |
| 7 | las 4 politicas existen (pg_policies) | select/insert/update/delete |
| 8 | `FORCE ROW LEVEL SECURITY` activo | `relforcerowsecurity` |

### Rutas con cliente Stripe falso — `stripe-connect.route.test.ts`

| # | caso | resultado |
|---|---|---|
| 1 | onboard sin cookie | 401 |
| 2 | onboard con sesion que no es gestor | 403, copy de arriba |
| 3 | onboard gestor, sin cuenta | crea express, guarda `stripe_account_id`, 200 con `accountLinkUrl` |
| 4 | onboard gestor, con cuenta | no crea otra (1 llamada a crearCuentaExpress), 200 |
| 5 | onboard con fallo de Stripe | 500 generico; el error aparece SOLO en el log |
| 6 | return sin cookie / sin gestor | 401 / 403 |
| 7 | return sin `stripe_account_id` | 302 a /admin/pagos, cero llamadas a Stripe |
| 8 | return `setup=complete` | sincroniza (llama obtenerCuenta) y 302 |
| 9 | webhook sin cabecera de firma | 401 |
| 10 | webhook con firma invalida | 401 |
| 11 | `account.updated` firmado | actualiza charges/payouts del tenant correcto |
| 12 | `account.updated` de cuenta ajena | 200 sin efectos |
| 13 | evento `payment_intent.succeeded` | 200 sin efectos (es T14) |
| 14 | `sincronizarEstadoConnect` pinta `onboarding_completed_at` solo en la transicion | con charges ya true no machaca la fecha |

Las firmas de los tests 9-13 se generan con `stripe.webhooks.generateTestHeaderString`
(criptografia real del SDK, secreto de test) sobre un `STRIPE_WEBHOOK_SECRET` de entorno.

### Comision (anclaje)

| # | caso | resultado |
|---|---|---|
| 1 | `COMISION_PLATAFORMA_CENTS === 0` | el test falla si alguien la sube sin tocar la spec |

### UI — `/admin/pagos`

| # | caso | resultado |
|---|---|---|
| 1 | sin sesion de gestor | redirige a `/` (server) |
| 2 | `charges_enabled = false` | muestra "Conectar los cobros de mi club" |
| 3 | `charges_enabled = true` | muestra "Los cobros estan conectados" |
| 4 | el boton llama a onboard y navega a `accountLinkUrl` | componente cliente |

## Criterios de aceptacion

- [ ] `POST /api/stripe/connect/onboard` crea (o reutiliza) la cuenta Express y devuelve el
      Account Link (test de que no crea dos cuentas con dos clicks)
- [ ] `GET /api/stripe/connect/return?setup=complete` cierra el flujo (302 al panel)
- [ ] `account.updated` actualiza `stripe_charges_enabled` y `stripe_payouts_enabled`
- [ ] `POST /api/stripe/webhook` rechaza peticiones sin firma valida (401)
- [ ] `/admin/pagos` muestra "Conectar los cobros de mi club" y luego "Los cobros estan
      conectados" (test de que el panel refleja el estado real de Connect)
- [ ] Copy sin jerga. Cero palabras tecnicas en pantalla (los strings de esta spec)
- [ ] `COMISION_PLATAFORMA_CENTS = 0` con test que falla si cambia
- [ ] La migracion nueva tiene `tenant_id` + RLS completa (regla 2)
- [ ] Test primero: la matriz de arriba escrita y en rojo antes de la implementacion
- [ ] `pnpm verify` entero en verde

## Criterios 7.6 que T13 NO cumple, y por que

> Si `stripe_charges_enabled = false`, `POST /api/payments/intent` devuelve 503
> `tenant_payments_not_ready`.

El endpoint de pago es T14. Copiado ahi.

> El PaymentIntent se crea con `transfer_data.destination = tenants.stripe_account_id` y
> sin `application_fee_amount` estando `STRIPE_PLATFORM_FEE_PERCENT` a 0.

Es T14. T13 deja el anclaje `COMISION_PLATAFORMA_CENTS = 0` para que T14 lo importe y no
pueda divergir del argumento de venta. El criterio completo (con el test sobre el
PaymentIntent) se copia a T14.

### Que SI deja preparado T13 para T14

- `tenants.stripe_account_id` poblado tras el onboarding (T14 lo lee para el
  `transfer_data.destination`).
- `COMPROBAR_CUENTA`: el 503 de T14 consultara `tenants.stripe_charges_enabled`, que ya
  mantienen el return y el webhook.

## Verificacion

- `pnpm test:db` (los 2 ficheros nuevos + los 12 previos verdes), `pnpm test`, typecheck,
  lint, encoding, cobertura de core = 100%.
- E2E manual con Stripe CLI (test mode):
  1. `stripe listen --forward-to localhost:3000/api/stripe/webhook` y copiar su
     `whsec_...` a `STRIPE_WEBHOOK_SECRET` del entorno de la terminal.
  2. `pnpm dev`, entrar en `/admin/pagos` como gestor de demo, completar el onboarding
     (cuenta de test real), volver.
  3. Comprobar que el panel dice "Los cobros estan conectados" y que `tenants` tiene
     `charges=true`.
  4. `stripe trigger account.updated` y comprobar que el webhook lo procesa (estado
     idempotente).
- GitNexus: `detect-changes` antes de commitear, `impact` sobre `esGestor`/`sincronizarEstadoConnect`.

## Dependencias

- Instalar `stripe` en `apps/padel-template/package.json` (workspace de terreno; el core
  no lo toca). Cambio de lockfile, confirmado al aprobar esta spec.
- `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `NEXT_PUBLIC_APP_URL` ya estan en
  `.env.example` y `.env.local`; no se anade ninguna variable nueva.
- Stripe CLI: ya instalado.

## Ficheros

- `apps/padel-template/supabase/migrations/20260929000000_tenant_members.sql` (nuevo)
- `apps/padel-template/supabase/seed.sql` (gestor de demo)
- `apps/padel-template/src/lib/server/stripe-connect.ts` (nuevo)
- `apps/padel-template/src/lib/tenant-members.db.test.ts` (nuevo)
- `apps/padel-template/src/app/api/stripe/connect/onboard/route.ts` (nuevo) y su
  `route.db.test.ts`
- `apps/padel-template/src/app/api/stripe/connect/return/route.ts` (nuevo)
- `apps/padel-template/src/app/api/stripe/webhook/route.ts` (nuevo)
- `apps/padel-template/src/app/admin/layout.tsx` (nuevo)
- `apps/padel-template/src/app/admin/pagos/page.tsx` (nuevo)
- `apps/padel-template/src/app/admin/pagos/ConectarCobros.tsx` (nuevo, cliente)
- `.env.example` (sin cambios, todo documentado ya)