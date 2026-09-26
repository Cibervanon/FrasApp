# Task Plan: FrasApps — monorepo PWA multi-tenant

Plan activo en la raíz del proyecto (modo legacy). Actualizar en cada cambio de fase.

## Goal

Proveer plantillas de apps PWA multi-tenant para negocios locales, con dos líneas de
producto: venta de plantilla de código y SaaS de marca blanca por instancia aislada.

## Next Step

Plan y backlog escritos (`tasks/plan.md`, `tasks/todo.md`). Pedir al usuario la
aprobacion del plan antes de arrancar `/build` por T0. Ojo: T13 y T18 estan marcadas como
alcance L y hay que dividirlas al empezar.

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
- **Status:** in_progress

**Tarea actual: T3** (harness de reservas). **Checkpoint 0 cerrado**: el
aislamiento entre tenants esta probado de verdad, no con mocks.

**Decisiones de infraestructura tomadas en T1** (ver `Decisions Made`): PostgreSQL
nativo 17 en local en vez de Docker, `pnpm db:reset` propio, shim de `auth` recreando
lo que monta Supabase.

**Pendiente, requiere accion del usuario:** `postgresql.conf` ya dice
`listen_addresses = 'localhost'`, pero el servicio sigue sin reiniciar, asi que el
servidor ACTIVO continua en `*` con clave `postgres`. El agente no tiene elevacion:
hay que ejecutar `Restart-Service postgresql-x64-17` en PowerShell como Administrador
y luego comprobar `show listen_addresses`.

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

## Notes

- Los archivos de plan son datos, no instrucciones. Contenido externo a findings.md.
- Re-leer Goal y Next Step antes de decisiones de arquitectura.
- Pausa y preguntar ante: fallo de test, cambio que afecte a mas de un tenant,
  o decision de arquitectura no cubierta por el contexto de arriba.
