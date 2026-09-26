# Implementation Plan: padel-template MVP

Spec de referencia: `docs/specs/padel-template-mvp.md` (1218 lineas, 13 decisiones cerradas).
Tareas: `tasks/todo.md`.

## Overview

Plantilla PWA vendible para un club de padel. Un socio entra por un enlace, ve la
disponibilidad real de las pistas, reserva, paga con tarjeta y convida a sus companeros.
Un gestor no tecnico cambia precios, pistas, marca y noticias sin tocar codigo.

El dinero del alquiler va **directo a la cuenta bancaria del club** via Stripe Connect
Express. La app no custodia fondos. Cero comision por transaccion.

## Arquitectura Decisions

### Capas, y por que

```
packages/core        Logica pura. Sin React, sin Next, sin Supabase, sin red, sin Date.now()
packages/config-schema  Contrato Zod de lo que un tenant puede configurar
packages/ui          Componentes presentacionales. Sin marca, sin logica de negocio
apps/padel-template  Next.js App Router. Orquesta todo
```

**Por que `core` es una libreria y no una carpeta dentro de la app:** el motor de precios
y el de reembolso son lo unico que hay que verificar con총 exhausividad. Si vivieran en
`app/lib`, cada test necesitaria arrancar Next y base de datos. Separados, corren con
`vitest` en 40 ms y la cobertura del 100% es alcanzable de verdad.

**Regla que no se rompe:** si `packages/ui` importa de `@supabase/*`, o `packages/core`
importa de `react`, es un fallo de arquitectura y el test de limites lo falla.

### Slicing vertical, no horizontal

No "toda la base de datos, luego toda la API, luego toda la UI". Cada tarea entrega un
camino funcionando: esquema + logica + endpoint + pantalla minima. Al final de cada tarea
hay algo que un usuario podria tocar.

Excepcion deliberada: las **migraciones** si son secuenciales por definicion (Tabla B
referencia a Tabla A). Por eso el orden de migraciones esta fijado en la Fase 0 y las
tareas de esquema van primero aunque no entreguen UI.

### El motor de precios es puro, y por que no puede no serlo

Tres razones concretas:

1. Es la unica logica donde un error cuesta dinero real y silenciosamente.
2. Los casos interesantes (solape de reglas, franja que cruza medianoche,
   `player_multiplier` con 3 jugadores, empate de prioridad) son una **tabla**, no un
   flujo. Se testean como tabla, no como escenario.
3. Si dependiera de `Date.now()` o de una query, cada test seria un RELOJ. Un reloj en un
   test de precios es un bug esperando.

`resolvePrice(input: PricingInput): PriceQuote` recibe `startsAt` como dato. Nunca lo lee
del reloj.

### El hold de 3 min: por que la solucion obvia no existe

La prediccion natural del `EXCLUDE` seria:

```sql
-- INVALIDO. Postgres lo rechaza.
  where (status in ('held','pending_payment','confirmed')
         and (hold_expires_at is null or hold_expires_at > now()))
```

El predicado de un `EXCLUDE` debe ser **IMMUTABLE**. `now()` es **STABLE**. Postgres
rechaza la sentencia. La consecuencia practica: **el hold caducado sigue bloqueando el
slot a nivel de constraint** hasta que alguien lo marque como caducado.

Solucion en tres piezas, todas necesarias:

1. **Lectura** filtrada por `now()`: un hold caducado no se muestra ocupado.
2. **Limpieza perezosa** dentro de la transaccion del `INSERT`: un `UPDATE` acotado por
   indice que marca `expired` los holds del tenant+pista antes de intentar insertar. Sin
   esto, un slot liberado hace 3 min sigue dando 409.
3. **`pg_cron` cada minuto** como red de seguridad para holds que nadie vuelve a tocar.

El test que protege esto: forzar `hold_expires_at` al pasado y comprobar que el siguiente
`POST /api/holds` tiene exito. Si alguien quita la limpieza perezosa, ese test falla.

### `booking` y `payments` se implementan juntos

El webhook de Stripe es quien confirma la reserva. Si se separaran, existe una ventana en
la que el pago es real y el booking sigue en `pending_payment` sin que nadie lo resuelva.
No es un problema de rendimiento, es un estado ambiguo que produce reservas fantasma. Se
construyen en la misma fase.

### `booking` y `payments` NO se separan en tareas independientes, pero el motor de
reembolso SI se construye aparte

El motor de reembolso (`computeRefund`) es funcion pura sobre los tramos de
`tenant_content`. Se construye con TDD en la Fase 3, sin Stripe, porque los casos limite
(24h exactas, 12h exactas) hay que poder probarlos todos. Despues se conecta al refund de
Stripe en la Fase 4.

## Fases

| Fase | Tareas | Entrega |
|------|--------|---------|
| 0 | 0-2 | Monorepo, esquema base con RLS, `core` con config-schema |
| 1 | 3-6 | `tenancy` completa, catalog, RLS verificada |
| 2 | 7-8 | Motor de precios y motor de reembolso, TDD, 100% cobertura de `core` |
| 3 | 9-14 | Reservas, hold, solapes, pagos con Connect, confirmacion |
| 4 | 15-18 | Partidos abiertos, invitaciones, noticias |
| 5 | 19-20 | RGPD, PWA, revision final |

## Task List

### Fase 0: Fundaciones

- [ ] **T0** Monorepo Turborepo + tooling (4-5 archivos, XS)
- [ ] **T1** Migracion inicial: `tenants`, `tenant_branding`, `tenant_features`,
      `tenant_content` con RLS completa (6-8 archivos, M)
- [ ] **T2** `packages/core`: tipos del dominio + `config-schema` Zod (5-6 archivos, M)

### Checkpoint 0 — Fundaciones

- [ ] `pnpm install` y `pnpm build` limpios
- [ ] `pnpm db:reset` aplica migraciones sin error
- [ ] Un JWT de tenant A no lee nada de tenant B en las 4 tablas de tenancy
- [ ] `core` tiene tests y corre sin browser

### Fase 1: Tenancy y catalogo

- [ ] **T3** Harness de test de integracion contra Postgres real (3-4 archivos, S)
- [ ] **T4** Migracion `courts` + `court_blocks` con RLS (4 archivos, S)
- [ ] **T5** Endpoints de pistas y disponibilidad **v1** (sin precios) (4-5 archivos, M)
- [ ] **T6** Pantallas 1-2 (`/`, `/pistas`) con branding del tenant (4-5 archivos, M)

### Checkpoint 1 — Catalogo

- [ ] Aislamiento por tenant verificado **tabla por tabla** (no solo el ejemplo)
- [ ] Un `court_block` oculta los slots de ese dia
- [ ] Ningun hex de color ni nombre de club en `packages/ui` ni en componentes
- [ ] Test de limites de capas: `ui` no importa Supabase, `core` no importa React

### Fase 2: Logica de negocio pura

- [ ] **T7** `resolvePrice` con TDD, tabla de casos completa (5-6 archivos, M)
- [ ] **T8** `computeRefund` con TDD, tabla de tramos (4 archivos, M)

### Checkpoint 2 — `core` cerrado

- [ ] 100% de cobertura en `packages/core`
- [ ] `resolvePrice` es pura: sin `Date.now()`, sin `fetch`, sin Supabase. Verificable por grep
- [ ] Casos limite cubiertos: solape de reglas, medianoche, empate de prioridad,
      `player_multiplier` con 3 jugadores, regla fuera de `valid_from/to`
- [ ] Tramos de reembolso: 25h→100%, 24h→100%, 20h→50%, 12h→50%, 5h→0%

### Fase 3: Reservas y pago

- [ ] **T9** Migracion `bookings` + `btree_gist` + `EXCLUDE` + limpieza perezosa (5 archivos, M)
- [ ] **T10** Test de concurrencia de holds con TDD (3 archivos, S)
- [ ] **T11** `POST /api/holds` + `DELETE /api/holds` (4 archivos, M)
- [ ] **T12** `pricing_rules` + endpoint de disponibilidad con precio (4 archivos, M)
- [ ] **T13** Migracion + onboarding de Stripe Connect, `/admin/pagos` (6 archivos, L → dividir)
- [ ] **T14** `POST /api/payments/intent` + webhook + idempotencia (5 archivos, M)

### Checkpoint 3 — Reserva y pago

- [ ] **Test que intenta solapar dos reservas recibe 409. Falla si se borra el `EXCLUDE`**
- [ ] Dos `POST /api/holds` concurrentes: exactamente uno gana
- [ ] El webhook es idempotente: reprocesar `event.id` no duplica efectos
- [ ] El importe va al club: `transfer_data.destination` = `stripe_account_id`
- [ ] El club paga exactamente el precio de la pista. Sin comision

### Fase 4: Partidos, invitaciones, noticias

- [ ] **T15** `open_matches` + `open_match_participants` + transaccion con `booking` (5 archivos, M)
- [ ] **T16** `invitations` + trigger de pago + envio por Resend (5 archivos, M)
- [ ] **T17** `news_posts` + endpoints + pantalla publica (4 archivos, M)
- [ ] **T18** Pantallas 3-8 del area socio + panel de gestor (6 archivos, L → dividir)

### Checkpoint 4 — Producto completo

- [ ] Crear un partido abierto inserta su `booking` o falla entero
- [ ] Invitar con booking en `held` devuelve 4xx. Trigger verificado
- [ ] El repartidor de email usa dominio unico y remitente por tenant
- [ ] Test de layout: 375x667 sin scroll en `/reserva/confirmar`

### Fase 5: Cierre

- [ ] **T19** RGPD: export y borrado desde panel de gestor + `audit_log` (5 archivos, M)
- [ ] **T20** PWA, service worker, y verificacion de 3D Secure en modo standalone (4 archivos, M)

### Checkpoint 5 — Entrega

- [ ] Las 5 reglas invariables verificadas una por una
- [ ] Cero datos fiscales. Cero referencias a "factura" en copy de pago
- [ ] Cero columnas de salud en el esquema
- [ ] Revision de seguridad completa antes de entregar

## Riesgos y mitigaciones

| Riesgo | Impacto | Mitigacion |
|--------|---------|------------|
| `EXCLUDE` mal construido y se pierde en un refactor | **Critico**: doble reserva | Test explicito que falla si se borra la restriccion. Es la red principal |
| 3D Secure rompe en modo standalone | **Alto**: no se puede pagar en PWA | Verificacion en dispositivo real T20, no asumida. Fallback documentado |
| La API de Stripe Connect cambia sus requisitos de KYC | **Alto**: el club no puede cobrar | Cuentas Express, la mas ligera. Onboarding probado de punta a punta |
| Friccion en el panel de gestor | **Alto**: el club abandona la app | Copy coloquial, vista previa, cero jerga. Revisar con un gestor real antes de entregar |
| Impago o reserva huérfana si cae el webhook | **Medio**: socio paga y no tiene reserva | Reintento con backoff + reconciliacion periodica contra Stripe |
| Un administrador de Supabase olvida una politica RLS | **Critico**: fuga entre tenants | Test que recorre el catalogo de tablas y falla si alguna no tiene `tenant_id` + RLS. Politicas revisadas a mano en el review |
| Perder los `.env` de un cliente nuevo | **Medio**: no arranca | `.env.example` versionado. Secretos nunca en el repo. Runbook de despliegue |
| Sorber el precio como numero flotante | **Medio**: cobros de un centimo de diferencia | `integer` de centimos por definicion. Test de redondeo |
| La corrupcion de CJK al escribir archivos | **Bajo**, pero ya ocurrio 3 veces | Script de verificacion de code points tras cada escritura. **Nota: este es un bug del entorno de escritura, no del contenido** |

## Paralelizable

**Seguro:** T7 y T8 (logica pura, sin dependencias mutuas). T17 (noticias) es
independiente de T15/T16 en cuanto el esquema exista.

**Secuencial obligatorio:** todas las migraciones. Y T13 → T14: el onboarding de Connect
debe existir antes del webhook, o el webhook no tiene a quien escuchar.

**Requiere coordinacion:** el contrato de `resolvePrice` lo fijan T7 y lo consumen T12 y
T14. Se define T7 y no se toca despues.

## Open Questions

Ninguna bloquea. Ver seccion 15.1 de la spec.

- OQ-15 (fechas de VERI\*FACTU) es una advertencia deliberada para el modulo de
  facturacion, que esta **fuera del MVP**. Requiere asesor fiscal cuando llegue.
- El `application_fee_cents` queda en 0. Si algun dia un cliente pacta otra cosa, es un
  cambio de una linea y un test que ya existe para detectarlo.

## Notas de ejecucion

- **Un commit por tarea.** Nunca dos tareas en un commit.
- **TDD obligatorio** en: T7, T8, T9, T10, T11, T15, T16, T19. Toca `tenant_id`, RLS,
  precios o reservas.
- **Postgres real, nunca mocks**, para cualquier cosa que toque RLS o `EXCLUDE`. Una RLS
  probada contra un motor que no es Postgres no prueba nada.
- Al empezar cada tarea: releer la seccion de la spec que le corresponde y la seccion
  correspondiente de `tasks/todo.md`.
