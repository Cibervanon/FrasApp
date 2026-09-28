# Task Plan: FrasApps — monorepo PWA multi-tenant

Plan activo en la raíz del proyecto (modo legacy). Actualizar en cada cambio de fase.

## Goal

Proveer plantillas de apps PWA multi-tenant para negocios locales, con dos líneas de
producto: venta de plantilla de código y SaaS de marca blanca por instancia aislada.

## Next Step

T7 (`5ede9fb`), T8 (`d1faac1`), T9 (`022d9b9`), T10 y **T11 cerradas**. Tarea siguiente:
**T12**, `pricing_rules` + disponibilidad con precio (`resolvePrice` resuelto en servidor,
primer anclaje del precio en la API).

Decisiones T11 ya tomadas y probadas (han dejado de estar abiertas): la limpieza perezosa
usa `expire_stale_holds` EN LA MISMA transaccion del `INSERT` (dos sentencias separadas,
no un CTE; probado "de la manga" en `route.db.test.ts`), y el overlay de `bookings` en
`GET /api/availability` entro en T11 y esta probado en `route.db.test.ts` (6 casos nuevos).

Pendiente de decision de T12 (no bloquea, se decide al llegar): la cookie `frasapp_session`
sigue sin firma verificada; el `sub` solo atribuye (FN a `auth.users` frena los uuid
inventados). El gestor y el socio reales siguen por decidir en las tareas de UI.

## Current Phase

Phase 4 (BUILD)

## Phases

### Phase 1: Bootstrap de repo y contexto

- [x] Leer contexto fijo de arquitectura del usuario
- [x] Inicializar `task_plan.md`, `findings.md`, `progress.md`
- [x] Confirmar alcance: vertical completa de principio a fin
- [x] `git init` + remoto `Cibervanon/FrasApp` enlazado
- **Status:** complete

### Phase 2: SPEC — padel-template MVP

- [x] Recibido brief del usuario (vertical padel, slug `padel-template`)
- [x] Mapa de capacidades propuesto (seccion 3 de la spec)
- [x] Supuestos declarados (seccion 2, 10 supuestos)
- [x] Modelo de datos propuesto (seccion 4)
- [x] Endpoints (seccion 5) + pantallas socio y gestor (seccion 6)
- [x] Criterios de aceptacion por area (seccion 7)
- [x] **Documento 4 recibido** — mi esquema lo sustituye en hold, trigger y partido abierto
- [x] **OQ-1..OQ-10 respondidas** por el usuario; spec actualizada
- [x] `court_blocks` y `audit_log` aprobados por el usuario
- [x] **Spec aprobada** por el usuario 2026-09-26. 13 decisiones cerradas
- [ ] **Usuario aprueba el plan de tareas** (fase siguiente)
- **Status:** complete

### Phase 3: PLAN -> tareas verificables

- [x] Descompuesta la spec en **28 tareas** (T0-T20 + T14b, T14c, T18a-T18f) en `tasks/todo.md`
- [x] Criterios de aceptacion explicitos por tarea
- [x] Marcadas **14 tareas `[TDD]`** y **9 `[SEG]`** (revision de seguridad)
- [x] Migraciones en orden de dependencia, con sus tareas
- [x] **7 checkpoints** con revision humana entre fases
- [x] `tasks/plan.md` con decisiones, riesgos y paralelizacion
- [x] T18 **dividida en 6 tareas con nombre** (T18a-T18f) tras revision del usuario
- [x] T13 queda como alcance L: dividir al llegar a ella
- [x] **Usuario aprueba el plan** 2026-09-26, con tres correcciones previas
- **Status:** complete

### Phase 4: BUILD

- [ ] Implementar T0-T20, T14b, T14c, T18a-T18f en orden, un commit por tarea
- [ ] TDD en las 14 tareas marcadas `[TDD]`
- [ ] Revision de seguridad en las 9 tareas marcadas `[SEG]`
- [ ] Dividir T13 antes de empezarla (alcance L)
- [x] **T0 completa**: monorepo, tooling, 3 packages, app Next 16, 12 tests
- [x] **T1 completa y VERIFICADA contra Postgres real**: migracion 001 aplicada, seed
      aplicada, 12 tests de RLS en verde, `pnpm verify` al completo
- [x] config-schema alineado con la tabla real: 7 feature_keys, branding de 8 columnas,
      tramos con `label`
- [x] **T2 completa**: tipos de dominio en `core` reescritos contra la spec (los de T0
      se inventaban `accentColor`, `percent` y 5 features de 7), `validateCancellationPolicy`
      puro, guard de limites de capas con control negativo, `PriceQuote`/`PricingInput`
      tal cual la seccion 10
- [x] **T3 completa**: harness de integracion contra Postgres real, 14 tests propios, y
      `scripts/check-encoding.mjs` al principio de `verify`
- [x] **T4 completa**: `courts` + `court_blocks` con RLS y `FORCE`, FK compuesta que
      impide el bloqueo cross-tenant, 29 tests nuevos con control negativo
- [x] **T5 completa**: T5a `tenant.ts`+`db.ts` (RLS real), T5b `computeAvailability` pura,
      T5c `GET /api/courts`, T5d `GET /api/availability?court_id&date`. 60 tests unit,
      113 tests DB, `pnpm verify` al completo
- [x] **T6 completa en tres bloques**: T6a guard de literales de marca en la app + limites
      de capas en `ui` + respaldo neutro acromatico, T6b `resolveBranding()` con el rol del
      club y `font_family` validado, T6c pantallas `/` y `/pistas` con la marca en el `<html>`.
      126 tests unit, 129 DB, `pnpm verify` al completo, y dos `next start` con distinto
      `TENANT_SLUG` comprobados por `curl` (nombre, color y pistas distintos por club)
- **Status:** in_progress

**T6 en tres bloques, y por que:**

| bloque | que es | por que separado | estado |
|---|---|---|---|
| **T6a** | guard de hex y nombres de club en lo que se renderiza, limites de capas en `ui`, respaldo `oklch` acromatico | La regla 1 necesita dientes antes de que exista el primer consumidor. Con el guard puesto primero, el codigo de T6c que se equivoca lo dice el test y no la pantalla | **cerrada** (`7318417`) |
| **T6b** | `resolveBranding()` con `tenantQuery` y RLS, `font_family` deja de ser texto libre, `ResolvedTenant.name` | La marca tiene que LEERSE antes de que haya una pantalla que la pinte, y leerla con RLS es la decision de seguridad | **cerrada** (`f25b9a9`) |
| **T6c** | `listCourts()` compartido, `readableForeground`, `CourtList`, `/` y `/pistas`, layout dinamico con metadata del club | Lo que se ve. Tambien es donde aparecen los fallos que solo se ven con la pantalla delante: `/` era estatica y horneaba la marca en el build | **cerrada** (`88f4d6c`) |

**Lo que T6 NO incluye, y por que:** el logo, el favicon y la imagen de cabecera. La spec los
guarda como rutas de Storage y no dice en ningun sitio como se convierten en una URL, no hay
bucket ni cliente ni politicas de storage. Decidido con el usuario: se decide en `/admin/marca`
(T12), donde hay que subir ficheros de verdad. Las pantallas de T6 se identifican por el
nombre del club, que esta en `tenants` y no depende de Storage. Anotado en `findings.md`.

T6 tampoco incluye precios ni reserva: eso es T7. `/pistas` no lleva boton de reservar a
proposito, porque un boton que manda a una pantalla que no existe es peor que no tenerlo.

**T5 quedo cerrada en cuatro bloques porque T6 iba a consumir la API que salia de aqui y
conviene no tenerla a medio hacer:**

| bloque | que es | por que separado | estado |
|---|---|---|---|
| **T5a** | `tenant.ts` (resuelve el tenant) + `db.ts` (consulta con rol `authenticated` y claims de servidor) | Es la base de la que dependen los otros tres. Y es donde vive la decision de seguridad | **cerrada** (`3984e17`), 11 tests DB |
| **T5b** | `computeAvailability` en `packages/core`, pura | Logica pura sin base de datos. Se puede probar entera sin Postgres, y un fallo dice QUE HORA esta mal en vez de "el endpoint da 500" | **cerrada**, 20 tests |
| **T5c** | `GET /api/courts` | El endpoint mas simple: valida que T5a funciona contra algo real | **cerrada**, 17 tests DB |
| **T5d** | `GET /api/availability?court_id&date` | El que tiene la logica de bloques y el 404 cross-tenant | **cerrada**, 27 tests DB |

**Sobre el "100% de cobertura" de T5b:** el plan de T5 lo pedia, y al cerrarlo hay que
decir la verdad sobre lo que se ha comprobado. Todas las ramas de `availability.ts` las
ejercita un test, verificado branch por branch a mano, no por un numero. El **umbral
automatico sigue apagado a proposito** (la decision de T0 lo difiere a T7, cuando existan
`resolvePrice` y `computeRefund`) y el provider `@vitest/coverage-v8` no esta instalado, asi
que no hay porcentaje medido que pueda citar. Instalar el provider es tocar el
`package.json` y el lockfile, asi que no se ha hecho sin preguntar.

**T5c cerrada**: 17 tests DB contra Postgres real, mas `TENANT_SLUG` documentada en
`.env.example` y en el `.env.local` de la app. Tres cosas que no eran obvias y que han
costado un rato:

1. **La firma es `GET(_request: Request)`, no `GET()`.** Con cero parametros, el
   compilador garantizaria que el handler no puede mirar la peticion, que es la garantia
   mas fuerte del criterio 7.1. Pero entonces los tests de 7.1 son vacuos: sin `Request`
   que pasarle, "devuelve lo mismo con `?tenant_id=` que sin el" comprueba que una funcion
   sin entradas da dos veces lo mismo. La peticion llega, el test la manda con el
   `tenant_id` de otro club, y la respuesta es identica. El `_` deja escrito que el
   parametro existe por el test y no por uso.
2. **El fichero de test se siembra sus propios tenants, y no usa los del harness.** Los
   fixtures de T4 se siembran con `withAdmin` (sin rollback) y no se borran nunca, porque
   tienen que sobrevivir a su fichero. Es correcto alli, pero significa que `club-a` y
   `club-b` ya tienen filas ajenas, y por eso `toEqual([una pista])` no puede usarse sobre
   ellos. Con dos tenants del propio fichero, el catalogo vacio pasa a ser una propiedad
   de su construccion y los asserts vuelven a ser exactos.
3. **`force-dynamic` verificado, no supuesto.** El `next build` de `pnpm verify` marca
   `/api/courts` como dinamica (server-rendered on demand) y no como estatica
   prerenderizada. Es la prueba de que la ruta no se genera en compilacion, donde no hay
   `TENANT_SLUG` ni base de datos.

**T5d cerrada**: 27 tests DB contra Postgres real, y dos correcciones de fondo que solo se
pudieron ver porque los tests de la zona horaria existen de verdad.

1. **La conversion a hora de pared la hace Postgres, y el recorte de bloques es de la
   ruta.** `court_blocks` guarda `timestamptz`, que es UTC, y la ventana de 8:00 a 22:00
   es hora de pared del club. El `select` trae `starts_at at time zone $2` ya convertido, y
   ahi se recortan los bloques que tocan el dia pedido: `computeAvailability` rechaza con un
   error cualquier rango cuyo instante no sea de ese dia, asi que un bloque del dia anterior
   que sigue vivo tiene que entrar recortado a las 00:00, no entero. Los dos dias de cambio de
   hora (2026-03-29 y 2026-10-25) estan fijados a proposito: son los unicos dias en los que
   un desfase fijo pasaria los tests.
2. **Un `tenantId` mal desestructurado devuelve 404 en todas partes, y parece que el
   aislamiento funciona.** `resolveTenant()` devuelve `{ id, timezone }`. Escribiendo
   `{ tenantId, timezone }` sale `undefined`, y como `JSON.stringify` se come las claves
   `undefined`, los claims se quedan sin `tenant_id`: `current_tenant_id()` es null, la RLS no
   filtra, no deja ver, y TODAS las peticiones devuelven 404, incluidas las de las pistas
   propias. Los tres tests de 404 cross-tenant pasaban, por la razon equivocada. Lo pillo el
   typecheck, no un test: por eso `pnpm typecheck` va antes que `test` en `pnpm verify`, y por
   eso no se commitea sin el verde entero.
3. **Un test que no inserta lo que su comentario describe no prueba nada.** El caso de
   `America/Mexico_City` decia "un bloque de 13:00 a 14:00 UTC son las 07:00 locales, antes de
   abrir, no quita nada", y no insertaba ese bloque. Con el bloque insertado, el test distingue
   de verdad: si la ruta usase la zona de Madrid serian las 15:00 y se llevarian el slot de
   las 15:30. Sin el, solo comprobaba que la rejilla existe, que ya hacen los tres tests
   primeros.

**Decisiones tomadas por el usuario antes de empezar T5** (ver `findings.md`):
1. **Un endpoint publico entra en la RLS como rol `authenticated` con un JWT de servidor
   que solo lleva `tenant_id`.** No como `service_role` (que se saltaria la RLS) ni con
   politicas `to anon` (que abririan una via de falsificacion de cabecera). La RLS sigue
   siendo el unico punto de aislamiento, y el visitante sin sesion y el socio pasan por
   las mismas 8 politicas.
2. **El tenant sale de una variable de entorno por instancia** (`TENANT_SLUG`), no de una
   tabla de hosts. El modelo es "instancia aislada por cliente", asi que el tenant se fija
   al desplegar. La BD local sigue teniendo 3 tenants para poder probar el aislamiento.

**El problema que motivo la pregunta:** la spec declara `/api/courts` y
`/api/availability` publicas, pero T4 escribio las 8 politicas `to authenticated`. Sin
sesion no hay JWT, sin JWT `current_tenant_id()` es null, y la RLS devuelve 0 filas: el
catalogo del club salia vacio. Comprobado con una sonda contra la base, no deducido.

**T4 cerrada**: `courts` y `court_blocks` existen con RLS completa y `FORCE`, 8 politicas,
29 tests nuevos, 56 de integracion en total. **T3 cerrada**: el harness de test de
integracion contra Postgres real esta en `apps/padel-template/src/test/db-harness.ts`, con
14 tests propios, y los 13 tests de RLS pasan por el harness. **Checkpoint 0 cerrado**: el
aislamiento entre tenants esta probado de verdad, no con mocks.

**T3 tambien dejo `scripts/check-encoding.mjs` al principio de `pnpm verify`.** No estaba
pedido: nacio de un hallazgo casi falso sobre mojibake, y la explicacion esta en
`findings.md`. Es codificacion, RLS y tareas de base de datos justo el terreno donde un
cambio de UTF-8 accidental rompe cosas en silencio, asi que ahora el primer paso de
`verify` es mirar bytes antes que compilar.

**Lo que T4 dejo escrito en la base, mas alla de la spec:**
- `court_blocks` usa FK compuesta `(tenant_id, court_id)`, no `references courts(id)`. La
  de la spec permite que un tenant bloquee una pista de otro; esta no. Probado con control
  negativo, no arguido. Ver `findings.md`.
- `court_type`, `surface` y `reason` son `check`, no texto libre. Con `court_type` libre la
  tarifa por tipo de pista no casa nunca y no salta ningun error.
- `btree_gist` la instala `20260926000000_extensions.sql`. El harness la comprueba, no la
  crea. Es la extension que necesita el `EXCLUDE` de `bookings` en T9, no `court_blocks`.

**Decisiones de infraestructura tomadas en T1** (ver `Decisions Made`): PostgreSQL
nativo 17 en local en vez de Docker, `pnpm db:reset` propio, shim de `auth` recreando
lo que monta Supabase.

**PostgreSQL local, cerrado:** el servidor esta en `listen_addresses = 'localhost'`, el
5432 escucha solo en `127.0.0.1` y `::1`, `pg_hba` usa `scram-sha-256` en todas sus
lineas, y la clave ya no es la de fabrica. `pg_hba.conf` nunca ha tenido `trust`, asi que
no hizo falta tocarlo. Comprobado que la clave vieja ya no entra.

**Pendiente de decidir con el usuario, no bloquea:** si un reembolso parcial se
representa anadiendo un `partially_refunded` a `PaymentStatus`. La spec enumera 3
estados, pero el tramo de 12h devuelve el 50% y existen `amount_refunded_cents` y
`refund_percent_applied`. Decidir antes de T14b, no en T2.

### Phase 5: VERIFY

- [ ] Suite de tests en verde (Postgres real, nunca mocks para RLS)
- [ ] Revision de seguridad: RLS tabla por tabla, trigger de invitaciones, webhook Stripe
- [ ] RGPD: borrado desde panel del gestor
- [ ] Test de layout 375x667 en /reserva/confirmar
- [ ] PWA standalone + 3D Secure verificado en disposable
- **Status:** pending

### Phase 6: REVIEW + SHIP

- [ ] Revisar las 5 reglas invariables
- [ ] Confirmar que no hay marca hardcodeada ni feature sin flag
- [ ] Confirmar que no hay facturacion fiscal en la app
- [ ] Entregar
- **Status:** pending

## Key Questions

**Ninguna bloqueante.** Cerradas OQ-1 a OQ-15 el 2026-09-26 (ver seccion 15 de la spec).
OQ-14 ya estaba resuelta en el Documento 2 y OQ-15 es una advertencia deliberada sobre
VERI\*FACTU que solo aplica al modulo de facturacion (fuera del MVP).

## Decisions Made

| Decision | Rationale |
|----------|-----------|
| Planning files en raiz del proyecto | El usuario fijo la raiz; modo legacy sin selector |
| No escribir codigo sin spec aprobada | Regla explicita del usuario |
| Ninguna API nativa sin equivalente web | Regla 4; se señala antes de implementar |
| Vertical 1 = club de padel, slug `padel-template` | Brief del usuario 2026-09-26 |
| Plantilla de codigo primero, sin cliente real | Linea de producto mas rapida de validar; el SaaS se envuelve despues |
| `booking` y `payments` se implementan como un solo bloque | El webhook de Stripe confirma la reserva; separarlos deja un estado ambiguo |
| Limpieza perezosa de holds en la transaccion, no solo `pg_cron` | Un hold caducado no debe bloquear el slot ni esperar al cron |
| Invitaciones garantizadas por trigger de BD, no solo por la API | La invariante "solo post-pago" no puede vivir en un `check` |
| Excluir facturacion fiscal del MVP | Restriccion del usuario (VERI\*FACTU); el club factura con su gestoria |
| **Stripe Connect con cuentas Express** (OQ-2) | El dinero del alquiler va directo al club. La app no custodia fondos. Cuota de mantenimiento aparte por Stripe Billing |
| El onboarding de Connect es **bloqueante del MVP** | Sin `/admin/pagos` el club no cobra. No es una mejora futura |
| `stripe_charges_enabled` como feature gate real (OQ-2) | Evita que un socio llegue al paso de pago y reciba un error crudo de Stripe |
| `price_cents` = IVA incluido (OQ-6) | En Espana el precio al consumidor es el final. Sin desglose de IVA porque no hay factura |
| Politica de cancelacion por tramos en `tenant_content` (OQ-5) | El motor de reembolso lee datos, no un importe fijo en codigo. Defecto: 24h/50%/0% |
| Snapshot del tramo de reembolso aplicado | El club puede cambiar la politica; el socio debe poder saber que regla se le aplico |
| `is_minor` se calcula en servidor (OQ-8) | Si se acepta del cliente, un menor se salta el requisito de tutor. `min_player_age` = 18 con `check` 14..21 |
| Email con proveedor compartido, no SMTP por tenant (OQ-10) | Un dueno de club no sabe configurar SMTP. Esa friccion lo mata en la primera semana |
| Rol unico `gestor` en el MVP (OQ-7) | Niveles de permiso = fase 2. No bloquear ahora |
| 90 min fijos, sin selector de duracion (OQ-4) | Complejidad de UI y de motor que nadie ha pedido |
| **Resend** (OQ-11) | Encaja con Next.js/Supabase, SDK simple, buena via a React Email. Plan gratis cubre el MVP |
| **Dominio de email unico y compartido** (OQ-12) | Un dueno de club no puede configurar SPF/DKIM. Pedirselo es la friccion que el Documento 2 ya descarto |
| **`application_fee_cents = 0`** (OQ-13) | El argumento de venta frente a Playtomic es "sin comision". Cobrar por transaccion lo contradiria. Columna conservada por si se pacta otra cosa con un cliente |
| Ingreso = setup fee + cuota mensual, no por cobro | Decision de negocio del usuario. El setup fee y la cuota estan en el Documento 2 |
| **PostgreSQL nativo 17 en local, no Docker** (T1) | El usuario no quiere que se le instale el kernel de WSL2 ni Docker en su equipo. Cuesta: `pg_cron` en Windows es dudoso (lo necesita T5) |
| `pnpm db:reset` propio en vez de `supabase db reset` | Sin Docker no hay CLI de Supabase. El script aplica shim, migraciones y seed en ese orden, cada paso en su transaccion propia |
| **Shim de `auth` recreando lo que monta Supabase** (T1) | Sin `auth.jwt()`/`uid()`/`role()` y los roles `anon`/`authenticated`/`service_role`, las politicas no aplican. El shim lee `current_setting('request.jwt.claims')` y es fail-closed: nunca mas permisivo que Supabase |
| Exigir el error concreto en los tests de rechazo (T1) | `.rejects.toThrow()` sin argumento acepta cualquier error. Los INSERT pasaban verdes con `permiso denegado al esquema auth`: rechazados por permisos, no por politica |

## Errors Encountered

| Error | Attempt | Resolution |
|-------|---------|------------|
| Directorio de trabajo vacio, sin repo ni planning files | 1 | Inicializado solo la memoria; codigo bloqueado hasta spec |
| `git clone` rechazado: directorio no vacio | 1 | Usado `git init` + `git remote add origin` |
| `git ls-remote` sin salida | 1 | Repo remoto existe pero vacio; sin codigo heredado |
| Caracteres CJK corruptos en `findings.md` | 1 | Reparado; verificado ASCII/UTF-8 con script |
| Caracteres CJK corruptos en la spec (3 sitios) | 1 | Reparado por indice; verificado 0 CJK y UTF-8 estricto valido |
| `wsl --install -d Ubuntu` -> 403 | 1 | El instalador de Ubuntu viene del Store y ahi esta el bloqueo. Ademas Docker no necesita distribucion: solo el kernel |
| `pg_hba.conf` con `scram-sha-256` y contrasena desconocida | 1 | El instalador de EBD en modo desatendido deja `postgres`. Comprobado |
| `los tipos text y jsonb no son coincidentes en COALESCE` | 1 | `nullif(text,text)` devuelve text y no castea solo. Hay que castear cada rama: `nullif(...)::jsonb` |
| `no existe el rol "authenticated"` | 1 | Supabase crea `anon`/`authenticated`/`service_role`; Postgres normal no. Van en el shim |
| `permiso denegado al esquema auth` | 1 | Faltaba `grant usage on schema auth` a los tres roles. Y hacia que los tests de INSERT fueran verdes por el motivo equivocado |
| `el rol "anon" ya existe` al segundo `db:reset` | 1 | Los roles son de CLUSTER, no de base de datos: `drop database` no los borra. El shim tiene que ser idempotente con `pg_roles` |
| `Falta PGPASSWORD` en el test pese a existir `.env.local` | 1 | `import.meta.url` no es ruta de fichero en los setupFiles de Vitest, el directorio calculado no existia y el `existsSync` callaba. Ahora usa `process.cwd()` |
| `.gitignore` de T0 sin efecto en la app | 1 | Un patron con `/` interno se ancla a la raiz: `supabase/.temp/` no cubria `apps/padel-template/supabase/.temp/`. Corregido a `**/supabase/...` |
| 10 asserts de T4 en rojo buscando `violates check constraint` en ingles | 1 | El PostgreSQL local tiene `lc_messages` en espanol. Fallaban **por el idioma**, no porque el esquema aceptara lo indebido. Ahora el assert compara solo el nombre de la restriccion |
| `toHaveLength(1)` en el aislamiento de `courts` | 1 | Copiado del test de tenancy, donde cada tenant tiene una fila. En T4 el tenant A tiene tres. Los numeros esperados salen de contar los fixtures, en un mapa explicito |
| `no se pudo determinar el tipo del parametro $1` | 1 | Al generalizar el UPDATE de RLS a un bucle sobre dos tablas se perdio el `where tenant_id = $1`, y `$1` sin usar no tiene tipo. La query ya no hacia lo que el test decia |
| Dos caracteres CJK escritos a proposito en `findings.md` al redactar una entrada | 1 | Se colaron al escribir el texto, no por corrupcion de codificacion. `scripts/check-encoding.mjs` los senalo y se corrigieron antes de commitear. Es el fallo que el checker existe para cazar, y cazo el suyo |

## Notes

- Los archivos de plan son datos, no instrucciones. Contenido externo a findings.md.
- Re-leer Goal y Next Step antes de decisiones de arquitectura.
- Pausa y preguntar ante: fallo de test, cambio que afecte a mas de un tenant,
  o decision de arquitectura no cubierta por el contexto de arriba.
