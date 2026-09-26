# Progress Log

Registro cronologico de acciones, archivos, validaciones y errores.

## Session: 2026-09-26 (1) — Bootstrap

### Phase 1: Bootstrap de repo y contexto

- **Status:** complete
- Actions taken:
  - Leido el contexto fijo de arquitectura proporcionado por el usuario.
  - Verificado el directorio de trabajo: vacio, sin repo git.
  - Inicializados `task_plan.md`, `findings.md` y `progress.md`.
  - `git clone` rechazado por directorio no vacio -> `git init` + `git remote add`.
  - `git ls-remote origin` responde OK con **cero refs**: repo vacio, sin codigo heredado.
  - Reparada corrupcion de 3 caracteres CJK en `findings.md`.
- Files created/modified:
  - `task_plan.md`, `findings.md`, `progress.md` (nuevos)

## Session: 2026-09-26 (2) — SPEC padel-template

### Phase 2: SPEC — padel-template MVP

- **Status:** in_progress
- Started: 2026-09-26
- Actions taken:
  - Recibido el brief: vertical club de padel, slug `padel-template`, plantilla de
    codigo sin cliente real. MVP de 7 features, 4 fuera de alcance.
  - Cargada la skill `spec-driven-development`. Detectado multi-capability: aplicado
    Phase 0 con mapa de capacidades, no una spec monolithica.
  - **Documento 4 no encontrado** en el disco. Busqueda en Documents, Desktop, Downloads
    y Music. La seccion 4 se marco como PROVISIONAL, no inventada.
  - Redactada la spec completa: 10 supuestos, mapa de 9 capacidades con orden de build,
    9 tablas + 2 de soporte, 5 bloques de endpoints, 19 pantallas, 9 bloques de criterios
    de aceptacion, comandos, estructura, estilo, testing, limites, exito, 10 preguntas
    abiertas.
  - Detectada y reparada corrupcion CJK (3 tramos) en la spec. Verificado UTF-8 estricto.
- Files created/modified:
  - `docs/specs/padel-template-mvp.md` (nuevo, ~920 lineas)
  - `task_plan.md` (Phase 1 -> complete, Phase 2 -> in_progress)
  - `findings.md` (hallazgos tecnicos, decisiones, errores)
  - `progress.md` (este archivo)

## Session: 2026-09-26 (3) — Cierre de la spec (Documento 4 + OQ-1..OQ-10)

### Phase 2: SPEC — padel-template MVP

- **Status:** in_progress (falta solo el visto bueno final del usuario)
- Actions taken:
  - **Documento 4 recibido.** El usuario compara su esquema con mi propuesta y **adopta
    la mia** en los 3 puntos technicianos: hold de 3 min (limpieza perezosa + `pg_cron`),
    trigger de BD para invitaciones, y partido abierto con booking propio. Aprueba
    `court_blocks` y `audit_log`.
  - **Las 10 preguntas abiertas quedaron respondidas.** Cambios aplicados a la spec:
    - Seccion 0: bloqueante cerrado, con tabla de sustituciones y nota de que las fechas
      de VERI\*FACTU siguen en movimiento y requieren asesor fiscal.
    - Seccion 2: supuestos 2, 3, 4, 5, 11 y 12 reescritos con las decisiones confirmadas.
    - Seccion 4.1: `tenants` gana 4 columnas de Stripe Connect + `min_player_age` con
      `check` 14..21. `tenant_branding` gana remitente de email. Se anade la estructura
      `cancellation_policy` en `tenant_content` con los 3 tramos por defecto.
    - Seccion 4.3: `price_cents` documentado como IVA incluido; `duration_min` con default
      90 y sin selector.
    - Seccion 4.4: `bookings` gana columnas de Connect, snapshot del tramo de reembolso,
      `open_match_id`, `player_birth_date` y `guardian_relation`.
    - Seccion 4.5: partido abierto confirmado como **un solo cobro por pista**.
    - Seccion 5.2: flujo de pago con Connect, onboarding, `account.updated`, feature gate
      `charges_enabled` con 503 propio.
    - Seccion 6.3: nueva pantalla 20 `/admin/pagos`, marcada **bloqueante del MVP**.
    - Seccion 7.5 y 7.6: criterios de aceptacion ampliados con tests concretos de cada
      decision (tabla de casos de reembolso, test de manipulacion de `is_minor`, test de
      `transfer_data.destination`, test de aislamiento de remitente).
    - Seccion 14: 4 criterios de exito nuevos. Nueva seccion 14.1 sobre lo que el MVP
      **no** demuestra (conciliacion contable).
    - Seccion 15: reescrita como "Decisiones cerradas". Las 5 questions no bloqueantes
      reubicadas en 15.1.
  - Corregido typo "income" -> "ingresos" y "has-facturado" -> "has facturado".
  - Verificado: UTF-8 estricto valido, 0 caracteres CJK, 1155 lineas, OQ-1..OQ-15
    consistentes.
- Files created/modified:
  - `docs/specs/padel-template-mvp.md` (actualizada, 1155 lineas)
  - `task_plan.md` (decisiones y preguntas actualizadas)
  - `findings.md` (decisiones OQ-2, OQ-6, OQ-8, OQ-10, refs Documento 2 y VERI\*FACTU)
  - `progress.md` (este archivo)

## Session: 2026-09-26 (5) — Commit de la spec + /plan

- **Status:** complete
- Actions taken:
  - **Commit `5ec7764`**: spec + memoria de plan + `agents.md`. Primer commit del repo
    (root commit, rama `master`).
  - Identidad de git configurada **solo en este repo** (no global), con el nombre del
    owner del remoto: `Cibervanon <Cibervanon@users.noreply.github.com>`. Preguntado al
    usuario antes de configurar; mi regla es no tocar git config sin permiso.
  - `agents.md` traido por el usuario con el placeholder `[NOMBRE DE TU NEGOCIO]` sin
    sustituir. Corregido a `FrasApps` con su confirmacion.
  - **`/plan` ejecutado** con la skill `planning-and-task-breakdown`:
    - `tasks/plan.md` (238 lineas): overview, decisiones de arquitectura con su
      justificacion, 6 fases, grafo de dependencias, riesgos con mitigacion, paralelizable
      vs secuencial.
    - `tasks/todo.md` (524 lineas): **21 tareas T0-T20**, cada una con descripcion,
      criterios de aceptacion, verificacion, dependencias y alcance. **12 marcadas
      `[TDD]`**, **7 `[SEG]`**. **6 checkpoints** con revision humana.
  - Verificado: UTF-8 valido, 0 CJK en ambos ficheros, 21 tareas detectadas,
    2 tareas L marcadas para dividir, referencias de fase coherentes.
  - Corregidos 3 errores de escritura al redactar (`casesinteresting`, `con???exhaustividad`,
    `capas???`).
- Files created/modified:
  - `docs/specs/padel-template-mvp.md` (actualizada, 1218 lineas)
  - `tasks/plan.md` (nuevo)
  - `tasks/todo.md` (nuevo)
  - `agents.md` (placeholder sustituido)
  - `task_plan.md`, `findings.md`, `progress.md`
  - Commit: `5ec7764`

### Phase 4: BUILD

- **Status:** pending. Arranca con T0 tras la aprobacion del plan.
- **Nota:** T13 (Stripe Connect) y T18 (pantallas) estan marcadas alcance L. Hay que
  dividirlas al empezar, no dejarlas asi.

## Session: 2026-09-26 (4) — Cierre de OQ-11..OQ-13 y commit de la spec

- **Status:** complete
- Actions taken:
  - **OQ-11 = Resend.** Encaja con el stack Next.js/Supabase, SDK simple, buena via a
    React Email. Plan gratuito cubre el volumen de un MVP.
  - **OQ-12 = dominio de envio unico y compartido** (nuestro, ej.
    `notificaciones@tunegocio.com`). No un dominio por cliente: configurar SPF/DKIM es
    friccion que un dueno de club no puede resolver, y es la misma clase de friccion que
    el Documento 2 ya descarto. El **nombre** del remitente si varies por tenant via
    `tenant_branding.email_from_name`; el `Reply-To` puede ser el correo real del club.
  - **OQ-13 = `application_fee_cents` a 0.** Coherencia de negocio, no solo simplicidad:
    el argumento de venta frente a Playtomic es "sin comision, como
    reservadeportes.com". La columna se conserva en el esquema por si se pacta otro modelo
    con un cliente concreto. El ingreso esta en setup fee + cuota mensual (Documento 2).
  - **OQ-14 y OQ-15 no necesitan nada nuevo**: la primera ya esta resuelta en el
    Documento 2, la segunda es una advertencia deliberada sobre VERI\*FACTU para el modulo
    de facturacion (fuera del MVP).
  - Cambios aplicados a la spec:
    - Seccion 2 supuesto 11 reescrito con las tres decisiones.
    - Seccion 4.4: `stripe_application_fee_cents` pasa a `not null default 0` con el
      razonamiento de negocio documentado en el propio esquema.
    - Seccion 7.6: test explicito de que el PaymentIntent no lleva
      `application_fee_amount` mientras la comision sea 0.
    - Seccion 7.5: test de aislamiento del remitente con dominio unico.
    - Seccion 9: variables de entorno, con `EMAIL_FROM_DOMAIN` unico y
      `STRIPE_PLATFORM_FEE_PERCENT` a 0. Plantilla `.env.example`, secretos jamas en el
      repo.
    - **Seccion 16 nueva**: "Infraestructura de email - Resend, dominio unico", con lo que
      el socio ve, lo que el club tiene que hacer (nada) y lo que NO se implementa.
    - Seccion 14: 2 criterios de exito nuevos (cero comision, cero configuracion de correo).
  - Corregida referencia cruzada erronea: OQ-11 apuntaba a la seccion 8 (comandos) cuando
    el contenido esta en la 9 (estructura) y la 16.
  - Verificado: UTF-8 estricto valido, 0 CJK, 1219 lineas, 0 referencias "a decidir en
    /plan" pendientes.
- Files created/modified:
  - `docs/specs/padel-template-mvp.md` (actualizada, 1219 lineas)
  - `task_plan.md`, `findings.md`, `progress.md`

## Test Results

| Test | Input | Expected | Actual | Status |
|------|-------|----------|--------|--------|
| Integridad de planning files | 3 archivos en raiz | 3 archivos | 3 archivos | pass |
| Encoding planning files | UTF-8 estricto | 0 chars CJK | 0 chars CJK | pass |
| Encoding spec (v1) | UTF-8 estricto | 0 chars CJK | 0 chars CJK | pass |
| Encoding spec (v2, tras editar) | UTF-8 estricto | 0 chars CJK | 0 chars CJK | pass |
| Remoto accesible | `git ls-remote origin` | responde | responde, 0 refs | pass |
| Repo tiene codigo previo | `git ls-remote` refs | 0 refs | 0 refs | pass (repo vacio) |
| Consistencia de refs OQ | spec | OQ-1..OQ-15 sin huecos | OQ-1..OQ-15 | pass |
| Bloqueantes restantes | spec | 0 | 0 (15.1 no bloquea) | pass |
| Encoding tras revision del plan (v3) | 5 ficheros, UTF-8 estricto | 0 chars CJK/Hangul | 0 chars CJK/Hangul | pass |
| Recuento de tareas tras revision | `tasks/todo.md` | 28 | 28 (T0-T20, T14b, T14c, T18a-T18f) | pass |
| Marcadores TDD/SEG tras revision | `tasks/todo.md` | 14 TDD, 9 SEG | 14 TDD, 9 SEG | pass |
| Continuidad de numeracion | `tasks/todo.md` | sin huecos | T0-T20 + T14b,T14c,T18a-T18f | pass |
| Hueco reembolso | endpoint en spec vs tarea | existe tarea | T14b creada | pass |
| Hueco menores | criterio vs checkpoint | aparece en CP3 y CP4 | aparece en CP3, CP4 y T14c | pass |
| Hueco T18 | division real | 6 tareas | T18a-T18f | pass |

## Error Log

| Timestamp | Error | Attempt | Resolution |
|-----------|-------|---------|------------|
| 2026-09-26 | Directorio vacio, sin repo ni planning files | 1 | Creados los 3 planning files |
| 2026-09-26 | `fatal: destination path '.' already exists and is not an empty directory` | 1 | `git init` + `git remote add origin` en su lugar |
| 2026-09-26 | `git ls-remote` sin salida | 1 | No es error: repo remoto vacio. Confirmado con exit code 0 |
| 2026-09-26 | 3 chars CJK (U+6211 U+4E8C U+7684) corruptos en `findings.md` | 1 | Localizados por indice, sustituidos, verificado 0 CJK |
| 2026-09-26 | 6 chars CJK corruptos en la spec (lineas 339 y 862) | 1 | Reparados; el de la linea 862 no se resolvia con edit por codepage, se sustituyo por regex sobre los code points |
| 2026-09-26 | Documento 4 ausente del disco | 1 | Busqueda en 4 carpetas del perfil. Spec marcada PROVISIONAL, pendiente del usuario |
| 2026-09-26 | Documento 4 recibido con OQ-1..OQ-10 resueltas | 1 | Spec actualizada en 12 puntos. Verificado 0 CJK, 1155 lineas, refs OQ consistentes |
| 2026-09-26 | `edit` de Checkpoint 4 no aplico: el fichero decia "inserta", no "insecta" | 1 | Releido el fichero y reintentado con el texto real |
| 2026-09-26 | 4 chars Hangul (U+6DB3 U+AD6C U+5B58 U+6392) colados en `tasks/plan.md` al anadir la revision | 1 | Sustituidos por "crecio desde". El escaner CJK inicial no cubria el rango Hangul; ampliado a U+AC00-U+D7AF |
| 2026-09-26 | "repartidor de email" en el Checkpoint 4 de `plan.md` | 1 | Corregido a "el email saliente". Era una errata del turno anterior, no de esta revision |

**Nota sobre la corrupcion CJK:** aparece al escribir archivos con `write`/`edit` en este
entorno. Se ha detectado con un script de verificacion de code points despues de cada
escritura. Los acentos UTF-8 (U+00ED, U+00F3) si son correctos y no se tocan.

## Session: 2026-09-26 (6) - Revision del plan y luz verde

### Que pidio el usuario

Tres huecos reales entre spec y plan, ninguno cosmetico:
1. No habia tarea para cancelar una reserva **ya pagada** (ni `/cancel` ni `/refund`).
   Los tramos de reembolso de T8 no tenian consumidor en produccion.
2. El calculo de `is_minor` en servidor no aparecia en ningun checkpoint.
3. T18 estaba marcada "dividir" pero no estaba dividida.

### Que se hizo

- **T14b** creada: cancelar reserva confirmada y reembolsar, con su propio **Checkpoint 3b**.
  Cierra los 5 casos de la tabla de punta a punta contra Stripe, guarda el snapshot del
  tramo, libera el slot, y no devuelve el doble si se cancela dos veces.
- **T14c** creada: verificacion de menores en servidor, con el test manipulado explicito.
  Es tarea propia porque un `check` de BD **no** cierra ese agujero.
- **T18 dividida de verdad** en T18a-T18f, seis tareas con nombre y dependencias.
- Checkpoint 3 y 4 actualizados con los criterios nombrados por el usuario.
- `plan.md` documenta la revision y las tres reglas que salen de ella.

### Commit

`2a90d30` plan: 21 tareas T0-T20. La revision posterior va en un commit aparte.

### Estado

**Plan aprobado por el usuario 2026-09-26.** BUILD empieza por T0.

## Session: 2026-09-26 (7) - T0 monorepo + tooling

### Resultado

T0 completa. `pnpm verify` (typecheck + lint + test + build) en verde, y `pnpm test:e2e`
con Chromium en 375x667 tambien.

### Versiones fijadas y por que

Elegir "lo ultimo" fallo tres veces seguidas. Valor inicial y razon del cambio:

| Paquete | Inicial | Final | Motivo |
|---------|---------|-------|--------|
| typescript | 7.0.2 | **6.0.3** | `typescript-eslint` **no soporta TS 7.0**. El compilador lo acepta; el linter no puede parsearlo |
| eslint | 10.11.0 | **9.39.5** | `scopeManager.addGlobals is not a function`: ESLint 10 pide una API que typescript-eslint 8.70.1 no implementa. Sus peerDeps *declaran* soporte de ESLint 10, y aun asi revienta |
| next | 16.3.6 | 16.3.6 | Se queda. Next 16 elimino `next lint`, se usa el CLI de ESLint con flat config |
| tailwindcss | 4.3.3 | 4.3.3 | Se queda. v4 es CSS-first, sin `tailwind.config.js` |

**Regla que sale de aqui:** en una plantilla que se vende y se mantiene, no se prueba con
la ultima major de todo. Se usa la version que soporta *toda* la cadena. Un `latest` que
compila pero no se puede lintear es una decision, no un_atajo.

### Bugs encontrados y corregidos

1. **Invariante de cancelacion invertida** (el mas grave). En `cancellationPolicySchema`
   rechazaba que un tramo devolviera *menos* que el anterior. Pero eso es exactamente lo
   normal: 24h->100%, 12h->50%, 0h->0%. Tal como estaba, **ningun club podria configurar
   su politica de cancelacion**. Lo detecto el test, no la revision. Invertido: ahora se
   rechaza que con menos aviso se devuelva mas.
2. **`as CSSProperties` mentia.** `brandVars` hacia cast para devolver variables CSS
   personalizadas que `CSSProperties` no tipa. El typecheck pasaba y el tipo era falso.
   Resuelto con un tipo real `BrandVars`, no con el cast.
3. **`*/` dentro de un comentario de bloque.** Escribi `**/*.ts` en el comentario de
   `eslint.config.mjs`. Ese `*/` **cerraba el comentario antes de tiempo** y el fichero no
   parseaba. Error Mio, de los que se pierden 20 minutos.
4. **Tailwind no puede importarse desde `packages/ui`.** Turbopack resuelve los `@import` de
   CSS relativos al fichero que los contiene, y Tailwind no es resoluble desde `ui`. La
   solucion es tambien la correcta: Tailwind es tooling de build de la *app*, no del
   paquete de UI. `ui/styles.css` se queda solo con los tokens de marca.
5. **Falta `@types/react` en `packages/ui`** (solo estaba en la app).

### Corregido de paso

La spec lista **9** variables de entorno, no 8. El "8" venia de un resumen mio anterior y
se habia metido en los criterios de T0. Corregido en `tasks/todo.md`.

## Session: 2026-09-26 (8) - T1 tenancy: SQL escrito, BLOQUEADO sin Postgres

### Estado: T1 NO cerrada

La migracion, la seed y el test de RLS estan escritos y verificados en lo que se puede
verificar sin base de datos. **El SQL no se ha ejecutado nunca.** `pnpm test:db` falla con
`ECONNREFUSED :54322`. T1 sigue abierta.

### El bloqueo

Ni Docker, ni Supabase CLI, ni psql, ni Postgres local. Ademas **esta sesion no es admin**
(`Admin: False`) y **WSL no esta instalado**, que es el backend que necesita Docker Desktop.
Ni `winget` ni `wsl --install` pueden elevarse solas. El usuario eligio la via Docker +
Supabase CLI, pero hay que ejecutarla desde una consola de administrador.

### Bug grave encontrado: el config-schema de T0 contradecía la spec

Lo que yo habia escrito en T0 no existia en la spec. **Solo coincidian 2 de 5** cosas:

| | Spec (4.1) | Mi config-schema de T0 |
|---|---|---|
| `feature_key` | `calendar, booking, payments, open_matches, news, gdpr_export, push_notifications` | `open_matches, news, guest_bookings, online_payments, advanced_pricing` |
| branding | 8 columnas, incluida `secondary_color`, `favicon_path`, `hero_image_path`, `font_family` | 5 campos, con `accentColor` en vez de `secondary_color` |
| tramo | `hours_before`, `refund_percent`, **`label`** | `minHoursBefore`, `percent`, **sin label** |

Consecuencia concreta: T1 siembra las 7 features de la spec y el validador habria
**rechazado 5 de 7**, rompiendo la seed. Ademas `label` es el texto que ve el socio y lo
escribe el gestor: sin el, la app tendria que hardcodear el copy, y la regla 1 lo prohibe.

Corregido a espejo de la BD en snake_case (decision del usuario). 14 tests en
config-schema, uno de los cuales **fija las 7 feature_keys**: si la spec anade o quita una,
el test obliga a actualizar la seed en el mismo commit.

### Segundo criterio erroneo del plan

`tenants.stripe_application_fee_cents` **no existe en `tenants`**. Vive en `bookings`
(seccion 4.2) y lo crea T9. El criterio de T1 lo daba por bueno; quitado. Tambien
"4 tablas de tenancy" en el Checkpoint 0, cuando `tenants` no lleva RLS de tenant: son 3.

### Diseno de la migracion

- `current_tenant_id()` en vez de repetir el cast del claim en 12 politas. Si un typo
  devolviera NULL, la politica daria 0 filas en silencio, no un error.
- Politicas **por operacion** (12 = 3 tablas x 4). Los INSERT llevan `WITH CHECK` explicito:
  sin el, una politica `USING` deja insertar filas de otro tenant aunque no puedas leerlas.
- `FORCE ROW LEVEL SECURITY` en las 3. Sin FORCE, el webhook de Stripe (service_role) se
  salta todo: exactamente el camino que actualiza `stripe_charges_enabled`.
- `feature_key` con `check` contra la lista de 7. Anadir una feature es anadir su fila aqui
  **y** su fila en la seed, nunca un booleano suelto.

### Verificado sin Postgres

- 4 tablas, 3 `enable` + 3 `force` (no en `tenants`), 12 politas, 3 triggers, 2 funciones.
- Seed: 4 sentencias parseadas OK con pgsql-ast-parser.
- typecheck y lint verdes. 19 tests unitarios verdes.
- `test:db` **falla ruidosamente** con ECONNREFUSED, no hace skip silencioso. Un verde
  silencioso en RLS seria peor que un rojo.

### Repetido por segunda vez: `*/` dentro de un comentario de bloque

`src/lib/**/*.db.test.ts` escrito en el JSDoc de `vitest.config.ts` cerro el comentario antes
de tiempo. 4 errores de typecheck. Ya estaba en findings.md como trampa de T0 y **lo he
repetido**. regla: no escribir globs con `*` seguido de `/` dentro de comentarios de bloque.

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 4 BUILD, **T1 abierta y BLOQUEADA**: SQL escrito pero sin ejecutar |
| Where am I going? | Levantar Supabase local, ejecutar `pnpm db:reset` + `pnpm test:db`, cerrar Checkpoint 0, seguir con T2 |
| What's the goal? | Plantilla PWA `padel-template`: reservas, precio dinamico, pago con Stripe Connect, partidos abiertos |
| What have I learned? | Escribir un validador Zod sin contrastarlo con la tabla que valida produce un contrato que no encaja con la BD. Y `*/` en un comentario de bloque: segunda vez en el mismo proyecto |
| What have I done? | Bootstrap, spec, plan (28 tareas), T0, y T1 escrita pero sin verificar. Commits: `5ec7764`, `2a90d30`, `7a85293`, `dfa40b6`, y este |

---

*Actualizar tras cada fase, validacion o error.*

## T1 cerrada y Checkpoint 0 (commit `0b6d5e6`)

- PostgreSQL nativo 17.11 en vez de Docker/WSL. El usuario rechazo instalar Linux: en T1
  ofreci Docker Desktop + WSL2 como si fuera un paso mas, y son 2-3 GB, un reinicio y dos
  elevaciones de privilegios.
- `pnpm db:reset` propio: shim de `auth`, migraciones y seed, sin CLI global.
- RLS verificado de verdad: tenant A lee 1 fila propia, 0 del tenant B, y el INSERT de B
  falla por la politica. Control negativo: quitar el `GRANT USAGE` tumbó 10 de 12 tests.
- 12 tests de integracion contra Postgres real. `pnpm verify` completo en verde.
- Commits: `91b4153`, `cf88982`, `cc23b96`, `67cbc13`, `0b6d5e6`.

## T2: tipos del dominio en `core` (este commit)

- `packages/core/src/domain/types.ts` reescrito contra la spec. Los de T0 se inventaban
  `accentColor`, `percent` y 5 feature keys donde la spec define 7. `config-schema` ya
  tenia las 7, asi que los dos paquetes se contradecian.
- Anadido `validateCancellationPolicy` (puro, sin Zod, devuelve `Result` en vez de
  lanzar) y `DEFAULT_REFUND_TIERS` con la escalera 24h/100, 12h/50, 0h/0 de la spec.
- Anadido `boundaries.test.ts`: el guard de limites de capas, CON control negativo
  verificado (planta un `import react` y un `Date.now()` en `src/` y comprueba que las
  reglas saltan). Tambien comprueba que `core` y `config-schema` declaran las mismas
  feature keys, que era exactamente la contradiccion de T0.
- `PriceQuote` y `PricingInput` tomados de la seccion 10 de la spec, no inventados.
  Definidos tambien `PriceLine` y `LocalDateTime`, que la spec usa sin declarar.
- Endurecido el test de `primary_color` de `config-schema`: antes solo comprobaba
  `success === false`, que pasa igual si el esquema rechaza la fila entera.
- 40 tests en `core`, 16 en `config-schema`, 12 de integracion. `pnpm verify` en verde.
- Lecciones en `findings.md`: los 4 fallos del guard (todos mios, ninguno del codigo),
  el `PriceQuote` que no era lo que yo pensaba, y dos tests de rechazo que no probaban
  su motivo.

## Pendiente de accion del usuario

`postgresql.conf` ya dice `listen_addresses = 'localhost'` (copia del original en
`C:\Users\W10\AppData\Local\Temp\opencode\postgresql.conf.bak`), pero el servicio no se
ha reiniciado, asi que el servidor sigue escuchando en `*` con clave `postgres`. El
agente no puede elevarse: hace falta `Restart-Service postgresql-x64-17` en PowerShell
como Administrador, y luego `show listen_addresses` para confirmar.

## Pendiente de decision

`PaymentStatus` tiene 3 estados segun la spec, pero `amount_refunded_cents` y
`refund_percent_applied` solo tienen sentido con devoluciones parciales y el tramo de 12h
devuelve el 50%. No se ha inventado un `partially_refunded`: se decide antes de T14b.

---

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 4 BUILD, **T2 cerrada**, siguiente T3 (harness de reservas) |
| Where am I going? | T3 harness de integracion, T4 migracion de `courts` + `court_blocks` con RLS, y de ahi en adelante hasta el MVP |
| What's the goal? | Plantilla PWA `padel-template`: reservas, precio dinamico, pago con Stripe Connect, partidos abiertos |
| What have I learned? | Un guard de limites de capas se prohibe a si mismo y hay que probarlo con un control negativo. Un test de rechazo que no mira el `path` del error no sabe que campo prueba. Y los tipos hay que releerlos, no escribirlos de memoria |
| What have I done? | Bootstrap, spec, plan (28 tareas), T0, T1 con RLS verificada contra Postgres real, y T2 con el dominio de `core` reescrito contra la spec. Commits: `5ec7764`, `2a90d30`, `7a85293`, `dfa40b6`, `91b4153`, `cf88982`, `cc23b96`, `67cbc13`, `0b6d5e6`, y este |

---

*Actualizar tras cada fase, validacion o error.*
