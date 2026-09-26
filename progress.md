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

## 5-Question Reboot Check

| Question | Answer |
|----------|--------|
| Where am I? | Phase 4 BUILD, empezando **T0** (monorepo Turborepo + tooling) |
| Where am I going? | T0 -> T20 + T14b,T14c,T18a-T18f, un commit por tarea, 7 checkpoints |
| What's the goal? | Plantilla PWA `padel-template`: reservas, precio dinamico, pago con Stripe Connect, partidos abiertos |
| What have I learned? | Ver findings.md. Trampa de IMMUTABLE en EXCLUDE, trigger para invitaciones, y los tres patrones de fallo spec->plan: funcion pura sin consumidor, criterio de seguridad en la fase equivocada, alcance L sin dividir |
| What have I done? | Bootstrap, spec (13 decisiones), plan de 28 tareas con 7 checkpoints, 2 commits (`5ec7764` spec, `2a90d30` plan). **Ningun commit de codigo todavia** |

---

*Actualizar tras cada fase, validacion o error.*
