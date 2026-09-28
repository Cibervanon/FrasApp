# Tareas: padel-template MVP

Plan: `tasks/plan.md` · Spec: `docs/specs/padel-template-mvp.md`

**Reglas de ejecucion**
- **Un commit por tarea.** Nunca dos tareas en un commit.
- **TDD obligatorio** en toda tarea marcada `[TDD]`. Toca `tenant_id`, RLS, precios o reservas.
- **Postgres real, nunca mocks**, para RLS y `EXCLUDE`.
- Empezar cada tarea releyendo la seccion de la spec que le corresponde.
- **Preguntar al usuario** ante: fallo de test, cambio que afecte a mas de un tenant, o
  decision de arquitectura no cubierta por la spec.

Leyenda: `[TDD]` = test-first obligatorio · `[SEG]` = requiere revision de seguridad

---

## Fase 0: Fundaciones

### [x] T0: Monorepo Turborepo + tooling
**Spec:** seccion 9 (estructura), 8 (comandos), 10 (estilo)

**Descripcion:** Turborepo con `packages/ui`, `packages/core`, `packages/config-schema`,
`apps/padel-template`. TypeScript estricto, Tailwind, Vitest, Playwright. `.env.example`
versionado con los **9** nombres de variable de la seccion 9, sin valores reales.

**Criterios de aceptacion:**
- [ ] `pnpm install`, `pnpm build`, `pnpm typecheck` y `pnpm lint` pasan en limpio
- [ ] `strict: true` y `noUncheckedIndexedAccess: true` activos
- [ ] `.env.example` existe con las **9** variables. `.env.local` en `.gitignore`
- [ ] Los 3 packages tienen `package.json` con `exports` correctos y se importan entre si
- [ ] Un test smoke en cada package, para que `pnpm test` tenga algo que correr desde T0

**Verificacion:** `pnpm build` · `pnpm typecheck` · test de limites de capas (vacio en esta
tarea, se relleno en T6a: `ui` no importa `@supabase/*`, `core` no importa `react`)

**Depende de:** nada · **Alcance:** XS

---

### [x] T1: Migracion inicial de tenancy `[TDD]` `[SEG]`
**Spec:** secciones 4.1, 7.1

**Descripcion:** `tenants`, `tenant_branding`, `tenant_features`, `tenant_content` con RLS
completa. `tenants` incluye las 4 columnas de Stripe Connect y `min_player_age` con
`check` entre 14 y 21 y default 18. `tenants` **no** lleva RLS de tenant (es la tabla de
identidad), las otras tres si.

**Criterios de aceptacion:**
- [ ] Las 4 tablas existen con `tenant_id` en la clave primaria donde corresponda
- [ ] Las 3 tablas de negocio tienen `FORCE ROW LEVEL SECURITY` y politica por operacion
- [ ] `tenants.min_player_age` con `check (min_player_age between 14 and 21)`, default 18
- [ ] Las 4 columnas de Stripe Connect en `tenants`: `stripe_account_id`,
      `stripe_charges_enabled`, `stripe_payouts_enabled`, `stripe_onboarding_completed_at`
- [ ] Seed con 1 tenant de demo, su fila de branding, y una fila por cada uno de los
      **7** `feature_key` de la spec
- [ ] `tenant_content['cancellation_policy']` sembrado con los 3 tramos por defecto,
      **cada uno con su `label`** (lo ve el socio)
- [ ] `config-schema` valida la fila que devuelve la BD: los 7 `feature_key`, el branding
      de 8 columnas y los tramos `hours_before` / `refund_percent` / `label`

**Nota:** `stripe_application_fee_cents` **no** es de `tenants`. Vive en `bookings`
(seccion 4.2) y se crea en T9. Este criterio estaba aqui por error y se ha quitado.

**Verificacion:** `pnpm db:reset` sin error · test de integracion: un JWT de tenant A no lee
ninguna fila de tenant B en las 3 tablas con RLS

**Depende de:** T0 · **Alcance:** M

---

### [x] T2: `packages/core` tipos + `config-schema` Zod
**Spec:** secciones 4, 9 (regla de capas), 10

**Descripcion:** Tipos del dominio (`Court`, `PricingRule`, `Booking`, `CancellationPolicy`,
`PriceQuote`) y el contrato Zod de lo configurable por tenant. `core` sin React, sin Next,
sin Supabase, sin `Date.now()`.

**Criterios de aceptacion:**
- [x] `packages/core` no importa `react`, `next`, `@supabase/*` ni llama a `Date.now()`
- [x] `CancellationPolicy` valida que los tramos esten ordenados y sin solapes
- [x] El schema Zod rechaza un `primary_color` que no sea un color valido
- [x] `vitest` corre en `packages/core` sin cargar Next ni base de datos

**Verificacion:** `pnpm test --filter @fras/core` · `grep -r "@supabase" packages/core` no
devuelve nada

**Depende de:** T0 · **Alcance:** M

**Nota:** el nombre del paquete es `@frasapp/core`, no `@fras/core`; el comando real es
`pnpm --filter @frasapp/core test`. El guard de limites de capas es
`packages/core/src/boundaries.test.ts`, y tiene control negativo propio: se comprobó que
detecta un `import` de React, un `Date.now()` y un `Math.random()` plantados en `src/`.

---

### Checkpoint 0
- [x] `pnpm install` y `pnpm build` limpios
- [x] `pnpm db:reset` aplica migraciones sin error
- [x] Un JWT de tenant A no lee nada de tenant B en las **3 tablas con RLS**
      (`tenant_branding`, `tenant_features`, `tenant_content`). `tenants` es la tabla de
      identidad y **no** lleva RLS de tenant, asi que queda fuera de esta comprobacion
- [x] `core` tiene tests y corre sin browser
- [x] **Revision humana antes de seguir** (checkpoint cerrado en `0b6d5e6`)

---

## Fase 1: Tenancy y catalogo

### [x] T3: Harness de test de integracion contra Postgres real
**Spec:** seccion 11

**Descripcion:** Utilidad que levanta un Postgres de test, aplica migraciones, crea tenants
A y B, y emite JWTs de ambos. Todo test de RLS pasa por aqui.

**Criterios de aceptacion:**
- [x] `withTenant('a', fn)` ejecuta `fn` con un JWT de tenant A contra Postgres real
- [x] Los tests corren en serie contra una base compartida, sin colarse entre si
- [x] El harness falla ruidosamente si la extension `btree_gist` no esta disponible

**Verificacion:** `db-harness.db.test.ts` confirma que A no ve B, y `pnpm verify` en verde.

**Depende de:** T1 · **Alcance:** S

**Nota:** el harness vive en `apps/padel-template/src/test/db-harness.ts` y tiene su
propio test, `db-harness.db.test.ts`, con 14 casos. Los 13 tests de RLS ahora pasan por
el harness en vez de abrir su propia conexion.

**Algo anadido que no estaba pedido:** `scripts/check-encoding.mjs`, enganchado al
principio de `pnpm verify`. El motivo esta en `findings.md`. En corto: mi comprobacion
de codificacion manual buscaba solo CJK, dejo pasar mojibake durante T1 entera, y cuando
por fin la mejore casi escribo un hallazgo FALSO porque la consola de PowerShell
convierte una enye correcta en caracteres de dibujo de caja. El script mira BYTES y esta
probado con control negativo: se planta mojibake y CJK y se comprueba que los detecta.

---

### [x] T4: Migracion `courts` + `court_blocks` con RLS
**Spec:** secciones 4.2, 4.4.1

**Descripcion:** `courts` con `unique (tenant_id, name) where deleted_at is null`, y
`court_blocks` como overlay de disponibilidad que no genera reservas.

**Criterios de aceptacion:**
- [x] Ambas tablas con `tenant_id not null`, RLS completa y `FORCE ROW LEVEL SECURITY`
- [x] `courts.min_duration_min <= default_duration_min <= max_duration_min` con `check`
- [x] `court_blocks` con `check (ends_at > starts_at)`
- [x] Un JWT de tenant A no lee ni escribe filas de `court_blocks` de tenant B

**Ademas de lo pedido, y por que:**
- [x] FK **compuesta** `(tenant_id, court_id) -> courts (tenant_id, id)`. La de la spec
      (`references courts(id)`) deja que A bloquee una pista de B. Probado con control
      negativo: con la de la spec el INSERT tiene exito y cae 1 test de 56.
- [x] `unique (tenant_id, id)` en `courts`, que es lo que hace posible esa FK
- [x] `court_type`, `surface` y `reason` promovidos de comentario a `check`
- [x] `check` de jugadores 2-4, precio no negativo, duracion minima positiva, nombre no
      vacio y `image_path` con el mismo formato que `tenant_branding_logo_path_format`
- [x] `surface` sigue siendo nullable como dice la spec
- [x] Sin `EXCLUDE` en `court_blocks`: el solape de dos mantenimientos no es un problema.
      El `EXCLUDE` es el de `bookings`, en T9

**Verificacion:** `pnpm db:reset` · `pnpm verify` completo en verde · 56 tests de
integracion en 3 ficheros, en serie, de los que 29 son nuevos

**Depende de:** T3 · **Alcance:** S

**Correccion de plan:** la extension `btree_gist` la instala la migracion
`20260926000000_extensions.sql`, no el harness. El harness la comprueba y falla con un
mensaje que dice `pnpm db:reset`. T3 la creaba, y eso hacia que un `create extension` de
un test pareciera parte del despliegue.

---

### [x] T5: Endpoints de pistas y disponibilidad v1 (sin precios)
**Spec:** seccion 5.1, 7.2

**Descripcion:** `GET /api/courts` y `GET /api/availability?court_id&date`. Slots de 90 min
no solapados, con `court_blocks` aplicado como overlay. **Sin precios todavia**: el motor
no existe.

**Criterios de aceptacion:**
- [x] Devuelve slots de 90 min no solapados entre las 8:00 y las 22:00
- [x] Un `court_block` en una franja oculta esos slots del dia
- [x] `court_id` de un tenant ajeno devuelve 404, no 403 (no se confirma su existencia)
- [x] El `tenant_id` se resuelve en servidor desde el host. Un `tenant_id` en la query se
      ignora

**Progreso:** cerrada, partida en cuatro bloques porque T6 consume esta API y conviene no
dejarla a medio hacer. **T5a** (`tenant.ts` + `db.ts`, la capa de RLS real, commit
`3984e17`), **T5b** (`computeAvailability` pura en `core`, 20 tests, commit `bf64269`),
**T5c** (`GET /api/courts`, 17 tests DB, commit `9fe8ae2`) y **T5d**
(`GET /api/availability?court_id&date`, 27 tests DB). Total 60 tests unit y 113 tests DB
contra Postgres real, `pnpm verify` en verde y las dos rutas marcadas como dinamicas
(server-rendered on demand) en el build.

El criterio de `tenant_id` estaba comprobado desde T5c, contra un `tenant_id` de un club que
existe y tiene pistas de verdad, y la respuesta es identica con y sin el. T5d lo repite
porque aqui el handler SI lee la query: si leyera el `tenant_id`, la pista del otro club se
encontraria y el endpoint devolveria el horario de un club entero.

**Verificacion:** tests de endpoint · `curl` con un `tenant_id` inventado en la query

**Depende de:** T4 · **Alcance:** M

---

### [x] T6: Pantallas 1-2 + branding del tenant
**Spec:** secciones 6.1 (pantallas 1-2), 6.3, 7.1

**Descripcion:** `/` y `/pistas`, con colores, logo y nombre leidos de `tenant_branding`.
**Cero** literals de marca en el codigo.

**Criterios de aceptacion:**
- [x] Cambiar `tenant_branding.primary_color` cambia la app sin tocar codigo
- [x] **Test automatico que falla si aparece un hex de color o un nombre de club en
      `packages/ui` o en componentes**
- [x] Test de limites de capas: `ui` no importa `@supabase/*`; `core` no importa `react`
- [x] La pantalla `/admin` no existe todavia. No se implementa aqui

**Progreso:** cerrada, partida en tres bloques. **T6a** (guard de literales de marca en la
app, limites de capas en `ui`, respaldo neutro acromatico en `oklch`, commit `7318417`),
**T6b** (`resolveBranding()` con el rol del club y RLS real, `font_family` validado en vez de
texto libre, `ResolvedTenant.name`, control negativo que quita la politica y tumba 7 de 12
tests, commit `f25b9a9`) y **T6c** (`readableForeground` en `core`, `brandStyle` con los
tres colores y la fuente, `CourtList`, `readAboutClub`, layout dinamico con `generateMetadata`
y `lang`, `/` y `/pistas`, commit `88f4d6c`). 126 tests unit, 129 tests DB contra Postgres
real, `pnpm verify` entero en verde y las cuatro rutas del build como dinamicas.

**Logo fuera de T6, y no por falta de tiempo.** La spec guarda `logo_path`,
`favicon_path` y `hero_image_path` como rutas de Storage pero no dice en ningun sitio como
se convierten en una URL, y no hay bucket, ni cliente de Storage, ni politicas de storage
en la migracion. Decidido con el usuario: se resuelve en `/admin/marca` (T12), donde hay
que subir ficheros. Las pantallas se identifican por el nombre del club, que esta en
`tenants`. Anotado en `findings.md`.

**Lo que T6c arreglo sin que nadie lo pidiera:** `/` era una ruta ESTATICA en el build, y con
el layout leyendo la marca eso hornea el HTML de un club concreto dentro del `.next` y
ademas obliga a la build a necesitar base de datos. `force-dynamic` lo quita.

**Verificacion:** tests de componente · test de ausencia de marca · ver 2 tenants con
branding distinto en paralelo

**Depende de:** T2, T5 · **Alcance:** M

---

### Checkpoint 1
- [ ] Aislamiento por tenant verificado **tabla por tabla**, no solo el ejemplo
- [ ] Un `court_block` oculta los slots de ese dia
- [ ] Cero literales de marca en codigo
- [ ] Test de limites de capas en verde
- [ ] **Revision humana antes de seguir**

---

## Fase 2: Logica de negocio pura

### [x] T7: `resolvePrice` con TDD `[TDD]`
**Hecho:** implementación completa, 135 tests, cobertura 100 %, `pnpm verify` verde. Pasa a T8.
**Spec:** secciones 4.3, 4.4, 7.3, 10

**Descripcion:** Motor de precio dinamico como funcion **pura** en `packages/core`. Recibe
`startsAt` como dato. Precedencia: `court` > `court_type` > `global`; dentro del mismo
scope, mayor `priority`; empate, la de `valid_from` mas reciente. Sin regla aplicable cae a
`courts.base_price_cents`.

**Criterios de aceptacion:**
- [ ] **Test primero.** Los tests se escriben y fallan antes de la implementacion
- [ ] Es pura: sin `Date.now()`, sin `fetch`, sin Supabase, sin estado global
- [ ] Mismos datos de entrada -> mismo precio, siempre
- [ ] Nunca devuelve `null`. Sin regla aplicable cae a `base_price_cents`
- [ ] `player_multiplier` con 3 jugadores devuelve `precio_regla * 3`
- [ ] 100% de cobertura en el fichero

**Verificacion:** `pnpm test --filter @fras/core` · tabla de casos completa: solape de reglas,
franja que cruza medianoche, empate de prioridad, regla fuera de `valid_from/to`,
`day_of_week` vacio = todos, regla de `court` que no corresponde a la pista

**Depende de:** T2 · **Alcance:** M

---

### [x] T8: `computeRefund` con TDD `[TDD]`
**Hecho:** funcion pura con el tipo del dominio (`RefundInput`), 151 tests en `packages/core`,
cobertura 100 % en `refund.ts`, guard de `boundaries` verde y `pnpm verify` completo. El draft
inicial (`01bacf3`) quedo con el contrato equivocado y se corrigio en `d1faac1`.
**Spec:** secciones 4.1 (`cancellation_policy`), 5.2, 7.6

**Descripcion:** Motor de reembolso como funcion pura. Lee los tramos de
`tenant_content`, ordena por `hours_before` descendente, aplica el primero que cumplas.
Devuelve tambien `tierHoursBefore` y `percentApplied` para auditarlo.

**Criterios de aceptacion:**
- [ ] **Test primero**
- [ ] Es pura. No lee `tenant_content`: recibe los tramos como argumento
- [ ] 25h antes -> 100%; **24h exactas -> 100%**; 20h -> 50%; **12h exactas -> 50%**;
      5h -> 0%
- [ ] Los casos limite exactos estan explicitos en los tests, no son accidentales
- [ ] Devuelve `tierHoursBefore` y `percentApplied` para snapshot en el booking
- [ ] Un tenant sin politica definida usa los 3 tramos por defecto

**Verificacion:** `pnpm test --filter @fras/core` · tabla de casos completa

**Depende de:** T2 · **Alcance:** M

---

### Checkpoint 2
- [x] 100% de cobertura en `packages/core`
- [x] `resolvePrice` y `computeRefund` son puras. Verificable por grep
- [x] Todos los casos limite de la spec cubiertos
- [ ] **Revision humana antes de seguir**

---

## Fase 3: Reservas y pago

### [x] T9: Migracion `bookings` con EXCLUDE y limpieza perezosa `[TDD]` `[SEG]`
**Hecho:** migracion `20260927000000_bookings.sql` y `bookings.db.test.ts` contra Postgres
real: 46 tests nuevos, 176 en total, `pnpm verify` verde. Doble FK de tenant (`user_id` a
`auth.users` y compuesta `(tenant_id, court_id)` a `courts`), 10 `check`, `EXCLUDE` con
predicado, indice de lectura y limpieza perezosa por `hold_expires_at`.
**Pendiente de produccion:** el `pg_cron` solo se programa si la extension esta
disponible, y en el PostgreSQL local de Windows no lo esta, asi que el schedule de Supabase
esta sin ejecutar en local. La via principal (limpieza perezosa de T11) si esta probada.
**Spec:** secciones 4.4, 4.4.1, 7.4

**Descripcion:** La tabla critica. `btree_gist`, `EXCLUDE` por `(tenant_id, court_id,
tstzrange)` con predicado de estados, funcion de limpieza perezosa, y `pg_cron` de red de
seguridad. Estados: `held`, `pending_payment`, `confirmed`, `cancelled`, `completed`,
`no_show`, `expired`.

**Criterios de aceptacion:**
- [ ] `btree_gist` instalado. Sin el, el `EXCLUDE` compuesto no indexa las columnas `uuid`
- [ ] `EXCLUDE` con predicado `status in ('held','pending_payment','confirmed')`, **sin
      `now()`**: el predicado debe ser `IMMUTABLE`
- [ ] Funcion `expire_stale_holds(tenant, court)` que marque `expired` los caducados
- [ ] `pg_cron` cada minuto llama a la funcion de red de seguridad
- [ ] `check`: si `is_minor` entonces los 4 campos de tutor no son null
- [ ] `check (amount_refunded_cents >= 0 and amount_refunded_cents <= price_cents)`
- [ ] `price_cents` es `not null` y es un snapshot: nada lo recalcula

**Verificacion:** **test que intenta solapar dos reservas en la misma pista y recibe
violacion de constraint. Este test falla si se borra el `EXCLUDE`** · test que demuestra
que `now()` en el predicado es rechazado por Postgres (documenta la trampa)

**Depende de:** T4 · **Alcance:** M

---

### [x] T10: Test de concurrencia de holds `[TDD]`
**Spec:** seccion 7.4

**Descripcion:** La red de proteccion de T9, probada antes de que exista el endpoint. Dos
intentos simultaneos sobre el mismo slot: **exactamente uno** gana.

**Criterios de aceptacion:**
- [x] Dos intentos concurrentes sobre el mismo slot: uno entra y el otro recibe el
      conflicto de la `EXCLUDE`. El **409** del endpoint es de T11, aqui se comprueba que
      el conflicto lo decide la base
- [x] Un hold caducado se limpia al intentar reservar, **sin esperar al cron**. Test que
      fuerza `hold_expires_at` al pasado y comprueba que el siguiente intento tiene exito
- [x] Un hold vigente **no** se limpia
- [x] A los 3 min + 1 s el slot vuelve a estar libre

**Verificacion:** `pnpm test` con la suite de concurrencia, ejecutada **en paralelo real**,
no con mocks

**Nota:** 9 tests en `src/lib/bookings.concurrencia.db.test.ts`, con
`withTransaccionesConcurrentes` (dos conexiones reales, dos transacciones, las dos como
`authenticated` con RLS). El primero de los criterios no se puede escribir con dos llamadas
a `withTenant`: ese helper revierte siempre, asi que las dos reservas nunca coexisten y el
test pasaria con el `EXCLUDE` borrado. Mutacion comprobada: quitando `bookings_no_overlap`
caen 6 de los 9.

**Depende de:** T9 · **Alcance:** S

---

### [ ] T11: Endpoints de hold `[TDD]`
**Spec:** seccion 5.1, 7.4

**Descripcion:** `POST /api/holds` (3 min exactos) y `DELETE /api/holds/[id]`. Limpieza
perezosa dentro de la misma transaccion que el `INSERT`.

**Criterios de aceptacion:**
- [ ] El hold dura 3 min exactos
- [ ] La limpieza perezosa se ejecuta **en la misma transaccion** que el insert
- [ ] Solo puedes liberar tu propio hold. El de otro devuelve 404
- [ ] 409 con horarios alternativos cuando hay conflicto

**Verificacion:** tests de endpoint · la suite de T10 sigue verde

**Depende de:** T10 · **Alcance:** M

---

### [ ] T12: `pricing_rules` + disponibilidad con precio
**Spec:** secciones 4.3, 5.1, 7.3

**Descripcion:** Migracion de `pricing_rules` y el endpoint de disponibilidad que ya
devuelve el precio resuelto por `resolvePrice`. **Todos los precios vienen del servidor.**

**Criterios de aceptacion:**
- [ ] `pricing_rules` con `check` de coherencia de `scope`
- [ ] La disponibilidad devuelve el precio de cada slot, resuelto en servidor
- [ ] El cliente **no** puede enviar precio. Un precio en el body se descarta
- [ ] El desglose devuelto incluye el nombre de la tarifa aplicada, para el panel

**Verificacion:** tests de endpoint · test de que el `PriceQuote` de la API coincide con
`resolvePrice` llamado directamente

**Depende de:** T7, T5 · **Alcance:** M

---

### [ ] T13: Stripe Connect, onboarding y `/admin/pagos` `[SEG]`
**Spec:** secciones 4.1, 5.2, 6.3 (pantalla 20), 7.6

**Descripcion:** Cuentas Express, Account Links, webhook `account.updated`, y la pantalla
`/admin/pagos`. **Bloqueante del MVP:** sin esto el club no cobra.

**Criterios de aceptacion:**
- [ ] `POST /api/stripe/connect/onboard` crea la cuenta Express y devuelve el Account Link
- [ ] `GET /api/stripe/connect/return?setup=complete` cierra el flujo
- [ ] `account.updated` actualiza `stripe_charges_enabled` y `stripe_payouts_enabled`
- [ ] `/admin/pagos` muestra "Conectar los cobros de mi club" y luego "Los cobros estan
      conectados"
- [ ] Copy sin jerga. Cero palabras tecnicas en pantalla
- [ ] `application_fee_cents` a 0: el club no paga comision

**Verificacion:** E2E del onboarding con Stripe CLI · test de que el panel refleja el
estado real de Connect

**Depende de:** T12 · **Alcance:** L (dividir si el E2E se resiste)

---

### [ ] T14: Pago con intent + webhook idempotente `[TDD]` `[SEG]`
**Spec:** secciones 5.2, 6.2, 7.6

**Descripcion:** `POST /api/payments/intent` con `transfer_data.destination` al club, y el
webhook que confirma la reserva. **El navegador nunca confirma un pago.**

**Criterios de aceptacion:**
- [ ] El importe lo calcula el servidor. Un importe del cliente se descarta
- [ ] `transfer_data.destination` = `tenants.stripe_account_id`
- [ ] **No lleva `application_fee_amount` mientras la comision sea 0**
- [ ] Si `stripe_charges_enabled = false`: 503 `tenant_payments_not_ready`, no un error
      crudo de Stripe
- [ ] El webhook sin firma valida devuelve 401
- [ ] `payment_intent.succeeded` -> `confirmed` + `paid`
- [ ] Reprocesar el mismo `event.id` no duplica efectos
- [ ] `payment_intent.payment_failed` -> `cancelled` y libera el slot

**Verificacion:** tests con Stripe CLI · test de idempotencia con el mismo `event.id`
enviado 3 veces

**Depende de:** T8, T13 · **Alcance:** M

### Checkpoint 3: Reserva y pago
- [ ] **Test que intenta solapar dos reservas recibe 409. Falla si se borra el `EXCLUDE`**
- [ ] Dos holds concurrentes: exactamente uno gana
- [ ] El webhook es idempotente
- [ ] El importe va a la cuenta del club, no a la plataforma
- [ ] El club paga exactamente el precio de la pista
- [ ] **Un `is_minor = false` enviado desde el cliente con fecha de menor se recalcula en
      servidor. Verificado con test, no de palabra** (T14c)
- [ ] **Revision de seguridad obligatoria: RLS, webhook, IAM de Connect**
- [ ] **Revision humana antes de seguir**

---

### [ ] T14b: Cancelar reserva confirmada y reembolsar `[TDD]` `[SEG]`
**Spec:** secciones 5.1 (`/cancel`), 5.2 (`/refund`), 4.1 (`cancellation_policy`), 7.6

**Descripcion:** `POST /api/bookings/[id]/cancel` y `POST /api/bookings/[id]/refund`. Es la
tarea que **consume `computeRefund` de T8 en produccion**. Sin ella, los tramos de
reembolso que se construyeron con tanto cuidado no tienen quien los use: la logica existiria
y nadie la ejecutaria. T8 es la funcion pura; esta es el cableado.

**Criterios de aceptacion:**
- [ ] `POST /api/bookings/[id]/cancel` cancela la reserva y **dispara el reembolso con
      `computeRefund`**, leyendo los tramos de `tenant_content['cancellation_policy']`
- [ ] `POST /api/bookings/[id]/refund` permite al gestor ejecutar el mismo reembolso
      (o el socio cancelar la suya)
- [ ] Solo el dueno de la reserva o un gestor puede cancelar. Un tercero recibe 404
- [ ] **Guarda el snapshot**: `refund_tier_hours_before` y `refund_percent_applied` en el
      booking. Si el club cambia la politica despues, el socio sigue viendo que regla se
      le aplico
- [ ] `amount_refunded_cents` se actualiza y nunca supera `price_cents` (garantizado por
      `check`)
- [ ] `payment_status` pasa a `'refunded'`
- [ ] **El slot se libera**: la reserva queda `cancelled` y el `EXCLUDE` deja de bloquear.
      Test explicito: la pista vuelve a estar disponible
- [ ] La reserva cancelada desaparece de "mis reservas" activas y pasa al historico
- [ ] **Cancelar dos veces no devuelve el doble.** El segundo intento devuelve 409
- [ ] Cancelar una reserva ya pasada no reembolsa. Si `starts_at` ya ocurrio, 422
- [ ] El reembolso se hace contra el **PaymentIntent real** de Stripe, no contra el
      `price_cents` local
- [ ] Test de integracion de los 5 casos de la tabla: 25h->100%, 24h->100%, 20h->50%,
      12h->50%, 5h->0%. **El importe devuelto por Stripe coincide con el del motor**

**Verificacion:** tests de endpoint contra Stripe CLI · test de que cancelar dos veces no
duplica el reembolso · test de que el slot se libera · la tabla de 5 casos pasando de
`computeRefund` (T8) hasta el reembolso real de Stripe

**Depende de:** T14 (el booking tiene que estar confirmado y pagado) · **Alcance:** M

---

### Checkpoint 3b: Reembolso
- [ ] **Cancelar una reserva pagada devuelve el importe del tramo correcto, verificado
      de punta a punta contra Stripe** (no solo la funcion pura de T8)
- [ ] Los 5 casos de la tabla de tramos pasan de `computeRefund` al reembolso real
- [ ] El snapshot (`refund_tier_hours_before`, `refund_percent_applied`) queda en el booking
- [ ] Cancelar dos veces no devuelve el doble
- [ ] El slot se libera y la pista vuelve a estar disponible
- [ ] **Revision humana antes de seguir**

---

### [ ] T14c: Verificacion de menores en servidor `[TDD]` `[SEG]`
**Spec:** secciones 4.1 (`min_player_age`), 4.4, 6.2, 7.5

**Descripcion:** Tarea propia y separada para la correccion de seguridad mas importante del
proyecto: **`is_minor` no se acepta del cliente**. Se calcula en servidor comparando
`player_birth_date` con `tenants.min_player_age` (18 por defecto).

Existe como tarea propia, y no como criterio implícito dentro de T9 o T11, porque un
`check` en BD **no** cierra este agujero: si el servidor acepta `is_minor = false` del
cuerpo de la peticion, el `check` ve `false` y no exige tutor. El menor se salta el
requisito y el `check` ayuda en nada. Solo el calculo en servidor lo cierra.

**Criterios de aceptacion:**
- [ ] **TEST PRINCIPAL: el cliente envia `is_minor = false` con un `player_birth_date` que
      da menor de edad segun `tenants.min_player_age`. El servidor lo RECALCULA a `true`
      y exige los 4 campos de tutor. La reserva no se crea sin ellos**
- [ ] El mismo test con un tenant de `min_player_age = 16`: con 17 anos, **no** es menor
- [ ] El umbral sale de la BD, no de una constante en el codigo
- [ ] Un tenant nuevo nace con `min_player_age = 18` sin que nadie lo configure
- [ ] Si la fecha de nacimiento no se envia y el jugador es un adulto segun el umbral, la
      reserva se crea normal. La fecha solo es obligatoria para quien es menor
- [ ] El aviso de responsabilidad de `/reserva/confirmar` se muestra **si y solo si** el
      servidor determino menor
- [ ] El `check` de BD sigue existiendo como **segunda capa** (defensa en profundidad), no
      como unica proteccion

**Verificacion:** los 3 tests de manipulacion explicitamente nombrados · `pnpm test` verde

**Depende de:** T9 · **Alcance:** S

---

## Fase 4: Partidos, invitaciones, noticias

### [ ] T15: `open_matches` con booking en la misma transaccion `[TDD]`
**Spec:** secciones 4.5, 7.7

**Descripcion:** `open_matches` y `open_match_participants`. Crear un partido abierto
inserta **su propio `booking`** en la misma transaccion, o falla entero. Un solo cobro por
pista.

**Criterios de aceptacion:**
- [ ] Crear un partido **falla entero** si el booking no se puede insertar. Sin booking
      huerfano
- [ ] `price_cents = price_per_player_cents * total_slots`, `payment_status='paid'`
- [ ] El contador de plazas es correcto con dos uniones concurrentes sobre la ultima plaza
- [ ] No se puede unirse si el nivel no cumple el rango
- [ ] RLS completa en las 2 tablas

**Verificacion:** tests de transaccion (incluye el fallo forzado) · test de concurrencia de
la ultima plaza

**Depende de:** T14 · **Alcance:** M

---

### [ ] T16: Invitaciones con trigger de pago `[TDD]` `[SEG]`
**Spec:** secciones 4.6, 5.3, 7.7

**Descripcion:** `invitations`, el trigger `invitations_require_paid_booking`, y el envio
por Resend. **Dominio unico compartido**, remitente por tenant.

**Criterios de aceptacion:**
- [ ] Invitar con booking en `held` o `pending_payment` devuelve 4xx
- [ ] El trigger salta tambien si se llama a Postgres directamente, no solo por la API
- [ ] El token es opaco, aleatorio, >= 32 chars, y expira
- [ ] El email sale por Resend con `email_from_name` del tenant y `Reply-To` real
- [ ] **Dominio tecnico unico y compartido.** La unica variable por tenant en la cabecera
      es `email_from_name`
- [ ] Test: el `From` tecnico de un tenant no es nunca el dominio de otro

**Verificacion:** tests de trigger contra Postgres real · test de la cabecera de email

**Depende de:** T15 · **Alcance:** M

---

### [ ] T17: `news_posts` + pantalla publica
**Spec:** secciones 4.7, 5.4, 6.1 (pantalla 8)

**Descripcion:** CRUD de noticias con `draft`/`published`/`archived`, y la pantalla publica.

**Criterios de aceptacion:**
- [ ] Solo se listan las `published`
- [ ] `unique (tenant_id, slug)`
- [ ] RLS completa. Un tenant no lee noticias de otro
- [ ] El gestor puede crear sin saber nada de markdown (regla 5)

**Verificacion:** tests de endpoint y de RLS

**Depende de:** T2 · **Alcance:** M

---

### [ ] T18a: Pantallas socio — disponibilidad y confirmacion
**Spec:** secciones 6.1 (pantallas 3-4), 6.2, 7.8

**Descripcion:** `/pistas/[id]` con la rejilla de disponibilidad, y `/reserva/confirmar`,
la pantalla mas delicada del MVP. Sin selector de duracion (OQ-4): 90 min fijos.

**Criterios de aceptacion:**
- [ ] **`/reserva/confirmar`: precio, politica de cancelacion y aviso de menor visibles
      en un unico bloque, sin scroll, en 375x667, antes del boton de pago**
- [ ] Es un unico bloque. **No repartido en pasos**
- [ ] El boton de pago no aparece si el club no tiene los cobros conectados
- [ ] Sin selector de duracion
- [ ] El precio mostrado viene del servidor, con IVA incluido y sin desglose
- [ ] El scroll de pagina esta prohibido en esta ruta: scroll interno del bloque de texto

**Verificacion:** **test de layout con Playwright en viewport 375x667, no a ojo** · test de
que el bloque no se reparte

**Depende de:** T12, T14c · **Alcance:** M

---

### [ ] T18b: Pantallas socio — mis reservas y partidos
**Spec:** secciones 6.1 (pantallas 5-7), 7.4

**Descripcion:** `/reservas` con historial y **cancelacion** (la UI que consume T14b),
`/partidos` y `/partidos/[id]` con unirse e invitar.

**Criterios de aceptacion:**
- [ ] `/reservas` separa proximas y pasadas
- [ ] Cancelar pide confirmacion y **muestra el importe que se va a devolver antes de
      confirmar**, leyendo el tramo de `tenant_content`. El socio ve "se te devuelve el
      50%" o "no hay devolucion" **antes** de pulsar
- [ ] La UI de cancelar no existe si la reserva no es cancelable (ya empezada, ya
      reembolsada)
- [ ] Unirse a un partido actualiza plazas en vivo
- [ ] El boton de invitar solo aparece con la reserva pagada

**Verificacion:** E2E del camino socio completo · test de que el importe mostrado coincide
con `computeRefund`

**Depende de:** T14b, T15, T16 · **Alcance:** M

---

### [ ] T18c: Panel de gestor — pistas, bloqueos y reservas
**Spec:** seccion 6.3 (pantallas 12, 13, 17), 7.9

**Descripcion:** `/admin/pistas` con alta y edicion, `/admin/pistas/[id]/bloqueos` para
mantenimiento, y `/admin/reservas` con listado y detalle.

**Criterios de aceptacion:**
- [ ] Copy coloquial. Cero jerga: sin "registro", "endpoint", "configuracion", "forzar",
      "debug", "UUID"
- [ ] "Anadir una pista" funciona de punta a punta sin documentacion
- [ ] Un bloqueo de mantenimiento se refleja en la disponibilidad del socio
- [ ] `/admin/reservas` filtra por fecha y muestra el detalle
- [ ] Se puede completar todo el flujo sin leer documentacion

**Verificacion:** revision con un gestor de club real · test de copy sin jerga

**Depende de:** T5 · **Alcance:** M

---

### [ ] T18d: Panel de gestor — precios con vista previa
**Spec:** seccion 6.3 (pantalla 14), 7.3, 7.9

**Descripcion:** `/admin/precios`, el editor de `pricing_rules`. Es la pantalla de la que
depende el motor de precios de T7, asi que va aparte.

**Criterios de aceptacion:**
- [ ] **Vista previa del resultado de cada regla antes de guardar**: "Los sabados por la
      tarde cuestan mas"
- [ ] Crear, editar, activar y desactivar una regla
- [ ] El motor de precios se puede ejecutar contra la vista previa sin guardar
- [ ] Copy sin jerga
- [ ] Un cambio de regla **no altera reservas ya creadas** (el precio es snapshot)

**Verificacion:** test de que la vista previa coincide con `resolvePrice` · test de que un
cambio de regla no altera bookings existentes

**Depende de:** T7, T12 · **Alcance:** M

---

### [ ] T18e: Panel de gestor — marca, noticias y ajustes
**Spec:** seccion 6.3 (pantallas 11, 15, 16, 19), 7.1, 7.9

**Descripcion:** `/admin` (dashboard), `/admin/marca` (colores y logo con preview en vivo),
`/admin/noticias` (editor y publicar) y `/admin/ajustes` (features y `tenant_content`).

**Criterios de aceptacion:**
- [ ] `/admin/marca` aplica color y logo **en vivo**, sobre la propia app
- [ ] `/admin/noticias` permite crear y publicar sin saber markdown
- [ ] `/admin/ajustes`: cada toggle dice en una frase que pasa si se apaga
- [ ] Apagar una feature con dependencias activas **se bloquea con explicacion**
- [ ] `/admin` muestra ingresos, reservas de hoy y avisos
- [ ] Copy sin jerga en las cuatro pantallas

**Verificacion:** test de que el branding se aplica sin redeploy · test de copy sin jerga ·
revision con gestor real

**Depende de:** T6, T17 · **Alcance:** M

---

### [ ] T18f: Visibilidad de reembolsos en el panel
**Spec:** secciones 5.2, 6.3, 7.6

**Descripcion:** El gestor necesita **ver** los reembolsos que ha ejecutado, aunque la
logica este en T14b. Sin esto, la pantalla de reservas no explica por que un socio recibio
un importe.

**Criterios de aceptacion:**
- [ ] `/admin/reservas` muestra el importe reembolsado y el tramo aplicado
- [ ] Se ve el `refund_percent_applied` de cada reserva, aunque la politica del club ya
      haya cambiado
- [ ] Un klik lleva al detalle del reembolso
- [ ] Sin datos fiscales: ni factura, ni NIF, ni desglose de IVA

**Verificacion:** test de que el tramo aplicado se ve aunque la politica haya cambiado

**Depende de:** T14b · **Alcance:** S

---

### Checkpoint 4
- [ ] Crear un partido abierto inserta su `booking` o falla entero
- [ ] Invitar con booking no pagado devuelve 4xx
- [ ] El email usa dominio unico y remitente por tenant
- [ ] Test de layout 375x667 en verde
- [ ] **El aviso de menor aparece si y solo si el servidor determino menor**, no si el
      cliente lo pidio (T14c + T18a)
- [ ] Cancelar muestra el importe a devolver **antes** de confirmar
- [ ] **Revision humana con un gestor de club real antes de seguir**

---

## Fase 5: Cierre

### [ ] T19: RGPD, export y borrado `[TDD]` `[SEG]`
**Spec:** secciones 4.8, 5.6, 7.5

**Descripcion:** `data_export_requests`, `audit_log`, exportacion, y borrado de datos
**accesible desde el panel del gestor**, no solo desde la cuenta del socio.

**Criterios de aceptacion:**
- [ ] El borrado se inicia **desde el panel de gestor** y desde la cuenta del socio
- [ ] Toda accion sensible queda en `audit_log` **antes** de ejecutarse
- [ ] Tras el borrado, el socio no tiene datos personales recuperables
- [ ] El export contiene las reservas del socio
- [ ] **Cero columnas de salud, medicacion o lesion en el esquema.** Test que falla si
      aparece una
- [ ] `is_minor` se calcula **en servidor** contra `tenants.min_player_age`. Test del caso
      manipulado: el cliente envia `is_minor=false` con fecha de menor

**Verificacion:** tests de RLS y de borrado · el test de columnas de salud

**Depende de:** T15, T16 · **Alcance:** M

---

### [ ] T20: PWA y verificacion de 3D Secure
**Spec:** secciones 8, 7.8, 14

**Descripcion:** Serwist, manifest, service worker, instalable, arranque sin conexion. Y
la verificacion de que el 3D Secure funciona en modo standalone, que es el riesgo real de
los pagos en PWA.

**Criterios de aceptacion:**
- [ ] La app es instalable y arranca standalone sin conexion
- [ ] Funciona en iOS Safari y Chrome Android moviles actuales
- [ ] **El pago con 3D Secure funciona en modo standalone**, verificado en un dispositivo
      real. No asumido
- [ ] Sin scroll horizontal a 320px
- [ ] Si 3D Secure falla en standalone, hay un fallback documentado

**Verificacion:** dispositivo real disposable, no emulador · build de PWA con manifest
valido

**Depende de:** T18 · **Alcance:** M

---

### Checkpoint 5 — Entrega
- [ ] Las 5 reglas invariables verificadas una por una
- [ ] Cero datos fiscales. Cero la palabra "factura" en el copy de pago
- [ ] Cero literales de marca. Cero features sin flag
- [ ] Sin columnas de salud
- [ ] Test de revision de seguridad: toda tabla con `tenant_id` tiene RLS completa
- [ ] **Revision de seguridad completa antes de entregar**
- [ ] **Revision humana final**
