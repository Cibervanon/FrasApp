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

## T13: Stripe Connect, onboarding y `/admin/pagos` (C1-C4 cerradas, C5 pendiente de usuario)

Spec propia `docs/specs/t13-stripe-connect.md` aprobada el 2026-09-28. Desglose C1-C5.

**Verificacion al cierre de C4:** `pnpm test:db` **273/273**, `pnpm test` **30/30**,
`pnpm typecheck` 0 errores, `pnpm lint` 0 (con `--max-warnings 0`), `pnpm build` con las 3
rutas `/api/stripe/*` como dinamicas, `pnpm test:e2e` **5/5** (smoke + 4 de la pantalla 20),
encoding limpio (solo los 3 avisos preexistentes de `.claude/`).

### Implementado

- **C1**: migracion `20260929000000_tenant_members.sql` (tabla + check `role='gestor'` + FKs
  a `tenants` y `auth.users` con `on delete cascade` + RLS `FORCE` con 4 politicas por
  `current_tenant_id()`). Seed: persona `...0d1` en `auth.users` + miembro gestor del tenant
  demo `...0001`. `tenant-members.db.test.ts` 13/13: matriz 1-8 de la spec, aislamiento
  cross-tenant dentro de la misma transaccion, `array_to_string(roles)` para comparar el rol
  de las politicas.
- **C2**: `src/lib/server/stripe-connect.ts` con `StripeConnectClient` inyectable
  (`crearCuentaExpress`/`obtenerAccountLink`/`obtenerCuenta`), `crearClienteStripe`,
  `COMISION_PLATAFORMA_CENTS = 0` anclada con test propio, `cuentaExpressOIdExistente`
  (reutiliza, `guardarCuenta` con `where stripe_account_id is null`), `sincronizarEstadoConnect`
  (con el `case` que pone `stripe_onboarding_completed_at` solo en la transicion a charges),
  `estadoConnectDelTenant` (solo lectura, lo que pinta la pantalla) y `esGestor` (por
  `tenantQuery`, RLS real). `stripe-connect.db.test.ts` 9/9.
- **C3**: rutas `onboard` (POST), `connect/return` (GET) y `webhook` (POST). En las tres el
  cliente se construye DENTRO del `try` (`client ?? crearClienteStripe()`) para que un fallo
  de arranque caiga al 500 generico de la spec y nunca escape crudo. `return?setup=complete`
  sincroniza antes del 302. Webhook: 401 sin firma, `constructEvent` real, 200-ACK de eventos
  ajenos (los `payment_intent.*` son T14). `stripe-connect.route.db.test.ts` 14/14 con
  cliente falso inyectado, tenant propio `club-t13-a` y `clearTenantCache` (patron T5d/T11).
- **C4**: `src/lib/server/session.ts` ahora exporta `subDeValor(valor)` (valor crudo de
  `next/headers.cookies()`, sin el `frasapp_session=` delante) y `subDeCabecera(cookie)`
  delega en el. `admin/layout.tsx` (minimo, `force-dynamic`), `admin/pagos/page.tsx`
  (server: cookie → `esGestor` o `redirect("/")`, pinta pendiente/conectado) y
  `admin/pagos/ConectarCobros.tsx` (cliente: POST onboard, abre `accountLinkUrl` en pestana
  nueva, error generico sin jerga ni palabras tecnicas de Stripe).

### Errores de esta sesion (los tres los pillo el e2e, no la revision)

1. **`subDeCabecera` no sabe leer el valor desnombrado de `cookies()`.** `cookies()` de
   `next/headers` devuelve el VALOR de la cookie, sin el `frasapp_session=` delante, y
   `subDeCabecera` exige la cabecera completa (su regex no casa). La pantalla pasaba el valor
   desnombrado y devolvia `null` → redirect a `/` incluso con el gestor correcto. Un `curl` a
   una sonda (luego borrada) lo demostró: `subDesdeHeader` funcionaba y `subDesdeCookies`
   era `null` con la MISMA cadena. No es un fallo de test sino un error de contrato de la
   funcion; `subDeValor` lo separa por intencion.
2. **Dos tests E2E que mutan la misma fila del tenant de demo corrian en paralelo.**
   `requests: fullyParallel: true` en `playwright.config.ts` lanza en paralelo hasta los
   tests del MISMO fichero: el que encendía `charges_enabled` y el que lo apagaba se pisaban
   y el ganador veía el estado del vecino. El fix es declarativo: `test.describe.configure({ mode: "serial" })`.
3. **`getByRole("alert")` es strict-mode violation en una app de Next**: el
   `#__next-route-announcer__` (rol `alert` vacío, aria-live) que Next inyecta a cada página
   rompe el locator. Se acota al `<p role="alert">` propio.

### GitNexus y commits

Commits hechos el 2026-09-28 (uno por tarea, memorias fuera): `2564f4d` spec T13,
`042ddb0` C1, `9fbf8e2` C2, `9fd85c5` C3, `3ae8c24` C4, `315a979` fix que anade
`.claude/` a `SKIP_DIRS` de `check-encoding` (sin el, el `verify` raiz moria en el primer
paso desde que `.claude/skills/` se commiteo en `4b8f3f6`: antes eran untracked y el
walker no los veia). `detect-changes` previo: 10 ficheros / 21 simbolos / 4 flujos, risk
medio, los 4 flujos cubiertos por las suites verdes.

`pnpm verify` raiz **en verde** tras el fix: encoding 0 problemas, typecheck 0, lint 0
(`--max-warnings 0`), 30 unitarios, 152 de cobertura en `core`, 273 de integracion y
build. Memorias sin commitear (regla).

**C5 queda solo con la verificacion manual E2E con Stripe CLI** (runbook de la spec):
`stripe login` y `stripe listen --forward-to http://localhost:3000/api/stripe/webhook`
+ `stripe trigger account.updated`, mas el onboarding real en la dashboard de Connect.
Hoy esta bloqueada por credenciales que no existen en la maquina: `.env.local` tiene las
variables de Stripe vacias y el CLI no tiene cuenta configurada (`~\.config\stripe` solo
contiene `docs`). No se crea una cuenta Stripe en nombre del usuario: hace falta su
email y el flujo de alta.

## T14: PaymentIntent con destino al club + webhook idempotente (E1-E4 cerradas en codigo)

Spec propia `docs/specs/t14-payment-intent.md` aprobada el 2026-09-28. Desglose E1-E4 en
`tasks/todo.md`. TDD por E: test ROJO contra Postgres real, implementacion, suite completa,
typecheck/lint/encoding, `detect-changes`, commit individual.

**Verificacion E4 (raiz unica):** `pnpm verify` en verde — typecheck 0, lint 0, encoding 0,
**300 tests DB** (18 ficheros), 91 unitarios, 152 core, build con las 3 rutas `/api/stripe/*`
dinamicas. `detect-changes` en E3: 7 ficheros / 21 simbolos / 0 procesos / risk low.

### E1 (commit `0ad6524`, spec `24ec616`)

- Migracion `20260930000000_payments_intent.sql`: SIN columnas nuevas en `bookings`; checks
  `bookings_pending_payment_needs_intent` (pending_payment => intent presente),
  `bookings_pending_payment_unpaid` y `bookings_confirmed_is_paid` en forma FUERTE
  `is not distinct from` (con `=` un `payment_status` NULL dejaba el check en NULL y lo
  pasaba; el test del agujero NULL lo obliga). Indice unico parcial
  `bookings_stripe_payment_intent_uidx` sobre `(tenant_id, stripe_payment_intent_id)`
  `where stripe_payment_intent_id is not null`.
- `src/lib/bookings.payments-intent.db.test.ts` 7/7. Fixtures de T9/T11 arreglados para
  filas de pago coherentes: `reserva()` de `bookings.db.test.ts` autocontiene
  `payment_status`/`stripe_payment_intent_id`; `reservar()` de `availability` tambien;
  UPDATE de holds `[id]` (linea ~242) anade `payment_status='paid'` (y el test fue
  reescrito sin BOM, `70f870f`, porque `Set-Content -Encoding utf8` de PS 5.1 mete BOM).

### E2 (commit `2d1b658`)

- `StripeConnectClient` ampliado en `stripe-connect.ts`: `crearPaymentIntent({amountCents,
  currency, destination, idempotencyKey})` y `recuperarPaymentIntent(paymentIntentId)`;
  impl real con `automatic_payment_methods` + `transfer_data.destination`, sin
  `application_fee_amount` (`COMISION_PLATAFORMA_CENTS=0`). Nuevas `capacidadCobroDelTenant`
  (baseQuery) y `cobrarHold(client, tenantId, sub, holdId)` con union discriminada
  `CobroResultado` (cobro_iniciado/cobro_recuperado/ya_pagado/sin_hold/hold_expirado/
  transicion_invalida/pagos_no_listos).
- Ruta nueva `POST /api/payments/intent`: solo `hold_id` (validacion manual tipo holds,
  claves extra descartadas), respuestas 200/404/409 (`hold_expired`)/503
  (`tenant_payments_not_ready`).
- `src/app/api/payments/payments-intent.route.db.test.ts` 11/11. El fake deriva
  `pi_falso_${idempotencyKey.slice(-4)}` (el indice unico cazo duplicados); slots por dia
  desde el id del booking (`parseInt(fila.id.slice(-2), 16)`) para no chocar con el EXCLUDE.
- Autorreparado: el import de `tenantQuery` roto en el rebase rompio `esGestor` (10 fallos
  de T13); fakes de T13 ampliados con los 2 metodos nuevos inertes.

### E3 (commit `5386f82`)

- Ramas `payment_intent.succeeded` / `payment_intent.payment_failed` en el webhook,
  EJECUTADAS tras la firma y ANTES de `account.updated`. Bind por `stripe_payment_intent_id`
  (index unico = a lo sumo una fila); booking sin intent => 200 ack.
- **Idempotencia por guarda de estado (T14-F):** el UPDATE lleva `where status =
  'pending_payment'`, asi los replays del MISMO `event.id` son no-op y un `succeeded` no
  resucita un `cancelled`. `audit_log` es T19.
- Test ampliado `stripe-connect.route.db.test.ts` a 23 casos: matriz E3 17-25 (succeeded
  desde pending, replay 3x con `confirmed_at` estable, succeeded sin booking, no-resurreccion,
  payment_failed, replay 3x, no-toca-confirmed, evento desconocido, slot liberado tras
  failure). **Hallazgo:** pg devuelve `timestamptz` como objeto `Date`, no string —
  comparar con `toEqual`, un `toBe` falla con "Compared values have no visual difference".
- Seed nuevo: `court` para `TENANT_T13` (antes solo tenia tenant + miembro) y limpieza de
  bookings en `afterAll` antes del borrado de tenants.

### Spec alineada (commit `1cce04f`)

El SQL de la spec usaba `= 'unpaid'`/`= 'paid'`; E1 endurecio la migracion a
`is not distinct from`. La spec ahora refleja la forma final y por que (agujero NULL).

### Pendiente de usuario

E2E manual Stripe en test mode (comparte C5 de T13): keys de test en `.env.local` + `stripe
login` + `stripe trigger payment_intent.succeeded` / `payment_intent.payment_failed` del
runbook. Sin credenciales del usuario no se puede completar; todo lo automatizable esta
automatizado.

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

## PostgreSQL local cerrado (accion del usuario)

- `Restart-Service postgresql-x64-17` en PowerShell elevado. El error previo, "No se
  puede abrir el servicio", era solo eso: la consola no estaba elevada. No hacia falta
  instalar ni configurar nada mas.
- `show listen_addresses` devuelve `localhost` y el 5432 escucha unicamente en
  `127.0.0.1` y `::1`. Antes estaba en `0.0.0.0` y `::`, o sea en todas las interfaces.
- Clave cambiada por indicacion del usuario. Verificado en las dos direcciones: la nueva
  entra y la antigua falla con "password authentication failed". La clave NO se escribe
  en ningun fichero commiteado; vive solo en `apps/padel-template/.env.local`, que sigue
  ignorado por `.gitignore:24`.
- Propagar el cambio de clave obliga a tocar `.env.local` en el MISMO paso. Si se
  cambia en la base y no en el fichero, `db:reset` y `test:db` dejan de autenticar y
  parece un fallo de la suite cuando el problema es una variable.
- Comprobado despues: `pnpm db:reset` aplica shim + migracion + seed, y los 12 tests de
  RLS siguen en verde con la clave nueva.

Recordatorio util: `listen_addresses` solo se aplica al REINICIAR. Un reload de
configuracion no cambia nada, asi que editar el fichero y recargar deja el servidor
igual que antes, y da la sensacion de que el cambio no funciona.
---

## T3: harness de test de integracion (cerrada)

**Commit:** `61a0ef0`.

Harness en `apps/padel-template/src/test/db-harness.ts`:
- `TENANT_IDS` fijos para A y B, `withAdmin`, `withTenant`, `withClaims`.
- `withTenant` hace `SET LOCAL ROLE authenticated`, inyecta `request.jwt.claims` y
  siempre cierra con rollback, incluso si el test lanza.
- `prepareDatabase` comprueba que la migracion esta aplicada, comprueba que `btree_gist`
  esta instalada y siembra fixtures de forma idempotente. Falla con mensaje accionable,
  no con un error de pg.
- Cerrojo `pg_advisory_lock` de sesion para que dos ficheros no se pisen sobre la misma
  base. El test lo demuestra: una segunda conexion no consegue tomarlo.

Los 13 tests de `rls.db.test.ts` ahora pasan por el harness en vez de abrir conexion
propia. Total de integracion: 27 tests, 2 ficheros, en serie.

**Anadido fuera de lo pedido:** `scripts/check-encoding.mjs`, primero de `pnpm verify`.
Nació de un hallazgo casi falso sobre mojibake; el razonamiento esta en `findings.md`.
Esta probado con control negativo en los dos sentidos: planta mojibake y CJK y confirma
que los detecta, y confirma que un punto medio legitimo no se marca.

**Follow-up de T3, commit aparte:** `prepareDatabase` creaba `btree_gist`, y eso convertia
un `create extension` de test en algo que parecia parte del despliegue: en la instancia de
un cliente esa extension no estaria, y el primer `EXCLUDE` de T9 reventaria en produccion.
Ahora la extension la instala `20260926000000_extensions.sql` y el harness solo la
comprueba, con un mensaje que dice `pnpm db:reset`. El test se reescribio para comprobar
que el harness **falla con ese mensaje**, no que la extension "este disponible", que era la
forma de que pasara siempre porque el mismo test la acababa de crear. Probado en los dos
sentidos: quitando `btree_gist` de la base, la suite cae en `beforeAll`; tras
`pnpm db:reset`, vuelven a pasar 27.

**Verificacion:** `pnpm verify` completo en verde: encoding, typecheck 7/7, lint 4/4,
59 tests unitarios, 27 de integracion y build de Next.

## T4: catalogo de pistas (cerrada)

Migracion `20260926000200_courts.sql` con `courts` y `court_blocks`, RLS completa y
`FORCE ROW LEVEL SECURITY` en las dos, 8 politicas en total.

**Correccion de plan:** la nota anterior de T4 decia "exclusion de solapes con
`btree_gist`" en esta migracion. Era incorrecta, y no por poco. `court_blocks` NO lleva
`EXCLUDE`, y `btree_gist` no lo necesita: quien solapa franjas sobre una misma pista son
dos mantenimientos, y que se pisen no rompe nada porque un cierre no genera reservas, no
cobra y no entra en el calculo de reembolso. Meter un `EXCLUDE` ahi habria indexado la
tabla para un problema que no existe. El `EXCLUDE` que si lo necesita es el de `bookings`,
en **T9**, para que nadie reserve dos veces la misma pista. Por eso la extension se
instala ya en una migracion propia y no en esta.

**La FK compuesta, y por que es la decision que mas importa.** La spec escribe
`court_id uuid not null references courts(id) on delete cascade`, y asi, sin tenant dentro
de la referencia, el tenant A puede crear un bloqueo sobre una pista del tenant B. El
bloqueo no aparece en la disponibilidad de B, pero si en la de A, sobre una pista que no
es suya. Aqui va `foreign key (tenant_id, court_id) references courts (tenant_id, id)`, que
obliga a `UNIQUE (tenant_id, id)` en `courts`.

Probado, no supuesto: con la FK tal cual la deja la spec, el INSERT cross-tenant tiene
exito (`rowCount: 1`) y cae exactamente un test de 56. Con la FK compuesta, los 56 pasan.
El control negativo esta en el historial de esta sesion.

**Comments de la spec promovidos a `check`.** `court_type`, `surface` y el `reason` de
`court_blocks` estan como comentario en la spec, no como restriccion. Con
`court_type` libre, una pista 'cristal' y otra 'Cristal' no se parecerian nunca al cruzar
con `pricing_rules.scope = 'court_type'` y la tarifa del club no se aplicaria a ninguna de
las dos sin que saltase NINGUN error: se rompe en silencio. `surface` sigue siendo nullable
como dice la spec, y su `check` admite null. Anadido `courts_name_not_blank`, que la spec
no pide: un nombre en blanco es una fila vacia en el panel de un gestor no tecnico.

`courts_image_path_format` usa el mismo regex y el mismo sufijo que
`tenant_branding_logo_path_format` de la 001. Precedente, no invento.

**29 tests nuevos** en `src/lib/courts.db.test.ts`. Integracion: 56 tests, 3 ficheros, en
serie. Tres cosas que fallaron y que teaches sobre los tests, no sobre el esquema:
- El PostgreSQL local tiene `lc_messages` en espanol. Buscar `/violates check
  constraint/` en ingles no casa nunca y fallo 10 tests. El assert busca ahora solo el
  nombre de la restriccion, que es unico en la base, no depende del idioma y es mas
  preciso que la frase.
- `toHaveLength(1)` copiado del test de tenancy, donde cada tenant tiene una fila. Aqui A
  tiene tres y fallo. Los numeros.expected salen de contar los fixtures, en un mapa
  explicito, no de memoria.
- Al generalizar el UPDATE a las dos tablas se perdio el `where tenant_id = $1`, y `$1` sin
  usar da "no se pudo determinar el tipo del parametro $1".

**Verificacion:** `pnpm verify` completo en verde: encoding, typecheck 7/7, lint 4/4,
59 tests unitarios, 56 de integracion y build de Next.

## T5: siguiente

`GET /api/courts` y `GET /api/availability`, con `court_blocks` como overlay. Sin precios:
aun no existe el motor.

Con lo que se ha cerrado en T4, T5 ya tiene su base: la FK compuesta garantiza que un
bloqueo solo puede apuntar a una pista del propio tenant, asi que el overlay no puede
filtrar franjas sobre pistas de otro club aunque se intente.

Sigue sin verificar si `pg_cron` esta disponible en el PostgreSQL nativo de Windows. No
bloquea T5, pero decide T9: si no esta, los recordatorios de caducidad van en Edge
Function y `EXCLUDE` sigue necesitando `btree_gist`, que esa si esta probada.

Respuesta a T9: `pg_cron` NO esta disponible en el PostgreSQL nativo de Windows, ni
siquiera instalable. La migracion lo comprueba con `pg_available_extensions` y, si no esta,
lo dice con un `raise notice` y sigue. Ver la entrada de T9 mas abajo.

## T7: motor de precio en `core` (cerrada, `5ede9fb`)

`resolvePrice` en `packages/core/src/domain/pricing.ts`, pura: recibe `startsAt` como dato,
resuelve por `court` > `court_type` > `global`, y desempata por `priority` y luego por
`valid_from` mas reciente. Sin regla aplicable cae a `courts.base_price_cents` y NUNCA
devuelve `null`. 135 tests, cobertura 100 % en el fichero, `pnpm verify` verde.

El umbral automatico de cobertura que T0 dejo apagado ya esta en pie: `packages/core`
exige 100 % por fichero en statements, branches, functions y lines.

**Tiempo local, no UTC.** `startsAt` rechaza `Z` y `+02:00` a proposito, porque el club
opera en su hora local y `franja = "18:00-20:00"` tiene que seguir significando las 18:00
del local. Acepta segundos opcionales. Quien normalice a UTC antes de llamar (T12) pierde
la tarde, y el importe que paga el socio no cuadra. La conversion a `timestamptz` es de T12.

## T8: motor de reembolso en `core` (cerrada, `d1faac1`)

`computeRefund` pura, con `RefundInput` del dominio y salida `RefundQuote` (importe mas el
snapshot de `tierHoursBefore`, `percentApplied` y `label`). Ordena una COPIA de los tramos
descendente por `hoursBefore` y aplica el primero que se cumple, con limites INCLUSIVOS
(`>=`): 24h exactas dan 100 %, 12h exactas dan 50 %. Tramos por defecto 24/100, 12/50, 0/0.
Sin tramo aplicable devuelve 0 con los tres campos en `null`. 151 tests en `packages/core`.

El primer commit de T8 (`01bacf3`) se llevo con el contrato equivocado: tipo propio en
snake_case, cinco tramos por defecto, sin ordenar y sin `RefundQuote`. Se corrigio entero
en `d1faac1` en vez de amendar, para que el historial no diga que la version buena estaba
ahi desde el principio.

**El guard de `boundaries` es el que obliga a hacer las cosas bien.** Exige que cada
modulo tenga un test que lo importe, y lo exige CON extension (`.js`). Un import sin
extension no cuenta como import, asi que se quejaba de `refund.ts` sin tener un solo test.
La solucion NO es excluir el fichero de la cobertura: es importar con `.js` desde el test.
Excluirlo dejaba verde un modulo sin probar, que es justo lo que el guard existe para
impedir.

## T9: tabla `bookings` (cerrada)

Migracion `20260927000000_bookings.sql` y `bookings.db.test.ts`: 46 tests nuevos, 176 en
total, `pnpm verify` verde. `btree_gist`, `EXCLUDE` compuesto con predicado de estados
vigentes, indice de lectura por pista, y `expire_stale_holds(tenant, court)` que caduca
por `hold_expires_at` y devuelve cuantas filas toco.

**La FK de `user_id` se me olvido al escribirla.** La declare `uuid not null` con un
comentario larguisimo explicando por que NO lleva `on delete cascade`, y sin el
`references auth.users(id)`. Lo solo vio el test de integridad: una reserva con un socio
inexistente insertaba bien, porque no habia ninguna FK. El comentario describia una FK que
no existia. Asi que un `not null` con su `references` se escribe en el MISMO sitio, nunca
en la frase de arriba.

**`comment on constraint` no admite el nombre con esquema.** Es error de sintaxis en el
punto: la restriccion se identifica por (nombre, tabla) y el nombre va sin `public.`. Peor:
el error lo senala en la linea del `comment`, que estaba mas de 200 lineas mas abajo, y el
`db:reset` solo enseña el numero de linea.

**`RAISE` de PL/pgSQL no concatena con `||`.** `raise exception 'a' || 'b'` no compila:
la firma es `RAISE nivel 'formato', expr...`. O una cadena sola, o `raise exception '%',
'a' || 'b'`.

**Un `EXCLUDE` SI admite predicado.** El error que hizo descartarlo en el primer intento
venia de meterlo dentro de un `create index`, que no es sintaxis. Como restriccion,
`alter table ... add constraint ... exclude using gist (...) where (...)` funciona, y es
la unica forma de que un estado cancelado deje de bloquear la pista.

**`pg_cron` no esta en el PostgreSQL nativo de Windows.** No sale en
`pg_available_extensions` ni instalable, asi que la migracion lo comprueba y, si no esta,
avisa con `raise notice` y sigue. En Supabase la extension viene montada y el schedule se
crea con la misma migracion. **Consecuencia que no hay que dejar sin registrar: el schedule
de produccion no se ha ejecutado nunca.** La via principal es la limpieza perezosa de T11,
que si esta probada; el cron es red de seguridad y hay que verlo funcionar en el primer
entorno que tenga `pg_cron` antes de confiar en el.

**Los tests tienen dientes, y se comprueba.** Con la base ya montada se tiraron el
`EXCLUDE`, la FK compuesta y el indice, y `pnpm test:db` fallo exactamente en 6 tests, los
6 que debian. Ese ejercicio destapo un agujero: el indice no lo cubria ningun test, asi que
su ausencia no la rompia nada. Con el indice fuera, un test de solape que usara dos llamadas
sueltas a `withTenant` pasaria IGUAL, porque cada llamada revierte y las dos reservas nunca
coexisten. La primera version de estos tests hacia justo eso, y por eso los dos inserts de
un caso de solape van ahora en la misma transaccion.

**La trampa del `not null`.** En PostgreSQL 17 los `not null` no aparecen en
`pg_constraint` y su mensaje de error no lleva nombre de restriccion, solo la columna. Es el
unico assert del fichero que mira la columna en vez del nombre, y el propio test lo dice.

## T10: concurrencia de holds (cerrada)

`bookings.concurrencia.db.test.ts`: 9 tests, 185 en total, `pnpm verify` verde. Nuevo helper
`withTransaccionesConcurrentes` en `db-harness.ts`, con dos conexiones reales, dos
transacciones abiertas a la vez, las dos como `authenticated` con RLS, y las dos
revertidas al terminar.

**El criterio de concurrencia NO se puede probar con el helper que ya existia.** Este es el
hallazgo de la tarea: `withTenant` revierte SIEMPRE, aunque el test pase, asi que dos
llamadas sueltas son dos reservas que nunca coexisten: la segunda llega cuando la primera ya
ha desaparecido. Un test de solape escrito asi pasa con el `EXCLUDE` BORRADO. La primera
version de estos tests hacia exactamente eso, y solo se vio al quitar la `EXCLUDE` de la
migracion y comprobar que seguian en verde. Por eso hace falta el helper nuevo, y por eso
el `INSERT` perdedor se arranca como promesa suelta, se resuelve la primera transaccion y
despues se espera la segunda: al reves, el deadlock lo escribe el test.

**La primera mutacion no valia, y casi se cuela como si valiera.** Al quitar la `EXCLUDE`,
todos los tests fallaron, pero no por la `EXCLUDE`: una sustitucion de texto habia juntado
dos lineas del `create table` y la tabla no existia. Un test que falla por la razon
equivocada teaches lo contrario de lo que creias, y `pnpm test:db` en verde con la base
montada habria parecido la prueba de que la mutacion funcionaba. Repetida con una edicion
limpia: 6 de los 9 tests caen con la `EXCLUDE` fuera. Los 3 que siguen verdes son
justamente los que no dependen de ella.

**Los ids de este fichero van en el rango 500-599, y no por gusto.** Los ficheros de tests
comparten base. Los tests de concurrencia hacen `commit` a proposito (el ganador se escribe
de verdad), y con los ids que usaba T9 los residuos de un test de T10 hicieron fallar a T9
con `llave duplicada viola bookings_pkey`: treinta fallos de T9 que apuntaban a una
restriccion que no estaban probando. Por eso el rango es separado y el `afterEach` barre por
ventana, no por lista de ids, para que un test que falle antes de su limpieza no arrastre su
fila al siguiente.

**El reloj no se prueba esperando.** "A los 3 min + 1 s el slot vuelve a estar libre" se
comprueba escribiendo `hold_expires_at` en el pasado, que es el estado que la fila tiene en
ese instante. Tres minutos y un segundo de suite para comprobar lo mismo, y en un portatil
lento el fallo seria del timeout y no del assert. Los dos lados del limite estan: justo
antes de caducar el hold sigue bloqueando, un segundo despues el slot esta libre.

**Un test de la carrera que faltaba.** El caso real no es el teorico: dos socios ven un
hueco con un hold a punto de caducar, los dos pulsan a la vez y los dos ejecutan la limpieza
perezosa antes de insertar. La limpieza no es un `if`, son dos `UPDATE` que pueden tocar la
misma fila. Ese caso esta probado, y comprueba que al final hay un solo hold vigente.

**Lo que T10 NO prueba:** el 409 como HTTP, porque el endpoint es de T11. aqui se comprueba
que el conflicto lo decide la `EXCLUDE` en la base. Tampoco el `pg_cron`, que no existe en
este PostgreSQL.

## Auditoría de arquitectura con GitNexus (2026-09-28)

Auditoría del repo entero (reindex 1234 nodos, 2293 aristas, 46 clusters, 16 flows) con el
CLI de GitNexus + verificación a mano de cada hallazgo. Se aplicaron 4 arreglos, todos con
`pnpm verify` completo en verde (encoding, typecheck, lint, 167 tests unitarios, 185 de
integración, build). `detect-changes`: risk low, 0 procesos afectados.

1. **Crítico: `index.ts` de `@frasapp/core` no exportaba `domain/refund.js`.** `computeRefund`
   era inalcanzable desde la app (el `exports` del paquete solo expone `.`), verificado
   empíricamente con `undefined` en runtime. Añadido el export + un caso nuevo en
   `smoke.test.ts` que lo importa por el camino público y lo ejecuta.
2. **`pg` movido de `devDependencies` a `dependencies`** de la app (lo importa el runtime).
3. **Test cruzado `TRAMOS_POR_DEFECTO` vs `DEFAULT_REFUND_TIERS`** en `refund.test.ts`, y
   corregido el comentario que prometía una sincronía que ningún test garantizaba.
4. **`NEXT_PUBLIC_APP_URL` eliminado de `next.config.ts`** (sin lectores en el repo).

Limpio: 0 imports circulares, sin huérfanos en el grafo; `tenantQuery`/`resolveTenant`
siguen siendo el punto único de aislamiento RLS, por diseño de T5. `SlotGrid` sigue sin
usarse, con consumidor previsto en T11.

El índice de GitNexus quedó reindexado. FTS/BM25 sigue sin habilitar (falta la extensión de
LadybugDB; pendiente para cuando haya red). Los 3 avisos de encoding que salen al verificar
viven en `.claude/skills/` (set up de GitNexus), no son del código del proyecto.

## T11: Endpoints de hold (cerrada)

`POST /api/holds` y `DELETE /api/holds/[id]` con TDD contra Postgres real, más el overlay de
`bookings` en `GET /api/availability`.

**Verificación:** `pnpm verify` en verde salvo los 3 avisos de encoding de siempre en
`.claude/skills/`. `check:encoding`, typecheck 7/7, lint 4/4, 25 unitarios (10 de `session`),
**206 de integración** (12 ficheros; +6 overlay en availability, +15 holds), cobertura 100%
en `core`, build de Next con las 3 rutas `/api/holds` nuevas.

### Implementado

- `src/lib/server/db.ts`: `tenantQuery` con `sub` opcional (cuarto parametro), `claimsDe`
  idéntica para `sub === null` (preserva el assert `claims.sub` toBeUndefined de T5),
  `tenantSession<T>` con `SesionQueryable`. Dos sentencias separadas en la misma transacción
  en vez de CTE; motivo documentado en el código (las sub-sentencias de un CTE no se ven
  entre sí: "cannot see one another's effects on the target tables").
- `src/lib/server/session.ts`: `subDeSesion` lee la cookie `frasapp_session` (JWT de 3
  partes, payload base64url, `sub` debe ser uuid). Sin firma verificada; decisión pendiente,
  documentada. 10 unitarios.
- `src/lib/server/validacion.ts`: `FORMATO_UUID`, `FORMATO_FECHA`, `esFechaReal`,
  `FORMATO_INSTANTE_LOCAL`, `esInstanteLocal` (rechaza offset, `99:99` y `24:00`).
- `src/lib/server/disponibilidad.ts`: `disponibilidadDePista` → `{ pista, huecos } | null`:
  overlay de `court_blocks` UNION ALL `bookings` activos (`held`/`pending_payment`/
  `confirmed` con `hold_expires_at > now()`), clip al día, ordenado.
- `src/lib/server/holds.ts`: `crearHold` (pre-check de disponibilidad → `expire_stale_holds`
  → `INSERT` con `hold_expires_at = now()+3 min`; 23P01→409 con alternativas frescas,
  23503→401) y `liberarHold` (SELECT bajo RLS → 404 si ajeno/otro club/inexistente → UPDATE
  a `cancelled`; 0 filas → 409).
- Rutas `src/app/api/holds/route.ts` (201/400/401/404/409/500) y `[id]/route.ts` (params
  como `Promise`, confirmado en docs de Next 16).

### Errores de esta sesión (los tres de los tests, ninguno de la ruta)

1. `delete from public.auth.users` → **0A000** ("referencias entre bases de datos"): un
   nombre de tres partes se lee como `base.esquema.tabla`. Es `auth.users`.
2. `extract(epoch ...)` → numeric → pg lo devuelve como string → `toBeGreaterThan` lanza.
   Cast `::int` en el SQL.
3. El assert del slot libre esperaba `08:00:00` y la ruta devuelve `2026-07-24T08:00`.

### GitNexus

Reindexado (1471 nodos, 2870 aristas, 57 clusters, 36 flows). `detect-changes`: risk high
por diseño (`tenantQuery`/`claimsDe`/`abrirSesionTenant` son el eje único de aislamiento),
14 flujos afectados (GET availability/courts, PistasPage, HomePage, CrearHold) y los 14
verdes en test:db. Cambios aditivos, sin consumidor roto.

## T12: `pricing_rules` + disponibilidad con precio (cerrada)

Migracion `pricing_rules` (20260928000000), `pricing-rules.db.test.ts` (20 tests) y el
precio por slot resuelto en servidor con `resolvePrice` y las reglas REALES, en
`GET /api/availability` y en el 409/hold de `POST /api/holds`. Primer anclaje del precio
en la API (spec 4.3, 5.1, 7.3).

**Verificación:** `pnpm verify` en verde salvo los 3 avisos de encoding de siempre en
`.claude/skills/`. `check:encoding`, typecheck raíz, lint 4/4, 25 unitarios,
**237 de integración** (13 ficheros; 42 de availability "T12" + 12 extras en holds),
cobertura 100% en `core` (cached) y build de Next verde.

### Implementado

- Migracion `apps/padel-template/supabase/migrations/20260928000000_pricing_rules.sql`:
  `pricing_rules` con `tenant_id`, `scope` (`court`/`court_type`/`global`), `court_id`,
  `court_type`, `day_of_week int[]`, `start_time`/`end_time`, `duration_min`,
  `valid_from`/`valid_to`, `price_cents`, `player_multiplier` y el `check` de coherencia
  de `scope` (una FK de coherencia `tenants` + el rango de `day_of_week` validado por
  contención `day_of_week <@ array[0..6]::int[]`, porque Postgres NO permite subconsultas
  en CHECK). RLS habilitada con políticas de aislamiento por tenant.
- `src/lib/pricing-rules.db.test.ts` (nuevo): aislamiento, sin coherencia de scope,
  acepta lo que `resolvePrice` puede resolver, rechaza precios/duraciones imposibles.
  El `afterAll` borra `RULE_A`/`RULE_B` y `COURT_A`/`COURT_B` por id (withAdmin persiste
  y rompía el aislamiento de `courts.db.test.ts`: 3→4 y 1→2).
- `src/lib/server/disponibilidad.ts`: `SQL_REGLA` lee reglas con `to_char` en `time` y
  `date`; `SlotConPrecio`/`DisponibilidadConPrecio` (extienden los tipos del core, que
  quedan puros); `DisponibilidadPista` gana `reglas`; cada hueco se enriquece con
  `resolvePrice({ numPlayers: pista.num_players })`. La rejilla se puede recobrar sin
  precio (uso interno del pre-check de holds).
- `src/lib/server/holds.ts`: `crearHold` y el 409 usan las reglas REALES (rejilla con
  `num_players` de la pista; el hold recalcula con el `numPlayers` del cliente).
  `alternativas` queda tipado `DisponibilidadConPrecio`. El 409 trae el precio ya
  resuelto y el hold cobra la tarifa del día.
- Tests: `availability/route.db.test.ts` describe "T12" con 9 reglas (ids terminados en
  `5e5`..`5ee`, días distintos: lunes punta, martes multiplicador, miércoles court_type,
  jueves court, viernes base, sábado duración; fechas AGOSTO porque junio ya lo ocupan los
  fixtures permanentes de describes previos) + test de que el `PriceQuote` de la API
  coincide con `resolvePrice` llamado directamente con las MISMAS reglas.
  `holds/route.db.test.ts`: regla de jueves (2500), el 409 trae alternativas con precio
  resuelto y el hold de jueves cobra 2500.

### Errores de esta sesión (resueltos por TDD, ver `findings.md`)

1. Migración con CHECK por subconsulta → `db:reset` rojo → contención de array.
2. `resolvePrice` recibía `time` como `HH:MM:SS` y `date` como `Date` desde pg →
   `NaN` en `vivaEn` → `to_char` en el SELECT de reglas y en el SQL del test directo.
3. Fixtures `withAdmin` de pricing-rules (commiteados) contaminaban `courts.db.test.ts`.
4. `gen_random_uuid()` como `tenant_id` resultaba en FK fail (bien: la coherencia es el
   punto). Tests "acepta" con `withTenant` (rollback).
5. `withTenant` no contamina; `withAdmin` sí. Remarcado en `findings.md`.

### GitNexus

`detect-changes`: "5 files, 26 symbols", risk high, flujos afectados `CrearHold` y
disponibilidad — cubiertos por las suites verdes (237/237). Los 2 ficheros nuevos
(untracked: migración y `pricing-rules.db.test.ts`) no se cuentan en el diff. Commit de
T12 pendiente de que el usuario lo pida.

## T14b: cancelar reserva confirmada y reembolsar (cerrada en codigo, E1-E3)

**Spec:** `docs/specs/t14b-cancel-refund.md` aprobada el 2026-09-29 (`c14570a`). Decisiones
que quedaban abiertas y se cerraron al escribirla: T14b-A (una `pending_payment` NO se
cancela por aqui: 409, el cobro esta en curso y compite con el webhook), T14b-B (dueno o
gestor cancelan), T14b-C (una sola `Idempotency-Key` por reserva, `reembolso_<bookingId>`,
compartida por la cancelacion y el reintento), T14b-D (primero se cancela y se committea,
despues se pide el dinero a Stripe), T14b-E (`/refund` solo sobre `cancelled` + `paid` +
`amount_refunded_cents = 0`), T14b-F (el importe sale de `price_cents` y del reloj del
servidor; el cuerpo del cliente se ignora), T14b-G (3 estados, sin `partially_refunded`) y
T14b-H (`refunded` solo con importe: un tramo del 0% deja el pago en `paid`).

### Commits

- `c14570a` spec T14b.
- `c49af41` E1 `src/lib/server/cancelaciones.ts` + 21 tests DB (motor cableado a Postgres
  real, snapshot, titularidad, guardas, Stripe caido, politica ausente/invalida).
- `3b98bcb` E2 `POST /api/bookings/[id]/cancel` + 13 tests DB (matriz 1-14 completa a nivel
  HTTP, incluido el slot que vuelve por el `EXCLUDE`).
- `90177c6` E3 `POST /api/bookings/[id]/refund` + 11 tests DB (matriz 15-19, mas el caso 11
  cerrado: cancelar con Stripe caido, cambiar la politica y reintentar con el gestor).

### Verificacion

`pnpm verify` raiz unico: exit 0, 7/7 tareas de turbo. Encoding 0, typecheck 0, lint 0
(`--max-warnings 0`), 221 unitarios (19 config-schema + 152 core + 20 UI + 30 app), 345
tests DB en 21 ficheros, build con las 5 rutas dinamicas (nuevas: `/api/bookings/[id]/cancel`
y `/api/bookings/[id]/refund`). `detect-changes` antes de cada commit: 5 ficheros de
memorias, 25 simbolos, 0 procesos afectados, risk low (los ficheros de codigo nuevos estan
untracked y el indice de grafo no los ve todavia).

### Lo que decide la implementacion y merece recordarse

- La cancelacion devuelve **200 con `reembolso.pendiente: true`** cuando Stripe falla, no
  un 500: la cancelacion ya esta commitada y un 500 diria al socio que no se cancelo,
  dejandole la reserva `confirmed` con la pista ocupada. En `/refund` el mismo fallo si es
  un 500, porque ahi no hay nada commitado todavia y la fila se queda reintentable.
- El importe de `/refund` sale del snapshot (`refund_percent_applied`), nunca de la
  politica de ahora. El test de E3 lo demuestra cambiando la politica al 100% entre la
  cancelacion y el reintento: devuelve el 50% del snapshot.
- Los tests de ruta siembran **una pista por caso**, no un dia distinto por caso (como los
  de la ruta de pagos): el tramo lo decide `hoursBefore`, y mover la reserva unos dias la
  echaria de cabeza al tramo del 100% sin que nadie lo tocase.

### Pendiente del usuario

- E2E manual con Stripe CLI (mismo bloqueo que C5 de T13 y el E2E de T14): hace falta
  `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET` de test y `stripe login`.
- La UI de cancelar (`/reservas` con el boton) es T18b/T18f, fuera del alcance de T14b.
