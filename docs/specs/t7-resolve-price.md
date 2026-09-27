# Spec T7: `resolvePrice` - motor de precio dinamico

Aprobada por el usuario el 2026-09-27. Padre: `padel-template-mvp.md` secciones 4.3, 7.3,
10 y 11. Deriva de `tasks/todo.md` T7.

T7 es la primera tarea de dinero del repo. Las cinco decisiones que la spec madre deja
abiertas estan resueltas y preguntadas, no inferidas:

| decision |_resolution_ | por que |
|---|---|---|
| Duracion de la regla | Solo aplica si `rule.durationMin === input.durationMin` | Una tarifa de 60 min no puede cobrar una reserva de 90. El ejemplo de la seccion 10 ignora `durationMin`, y con el los clubs pierden dinero sin error visible |
|Franja horaria | El slot tiene que caber ENTERO en `[start_time, end_time)` | Un slot de 90 min a las 20:30 no cabe en 18:00-21:00 y cobra tarifa base. Es lo contrario de dejar que la punta se escape al final de la tarde |
| `start_time > end_time` | No aplica nunca. Lo prohibe un `check` en la migracion de T12 | Con la franja 8:00-22:00 no hay slot que pueda caer ahi. Interpretar el cruce de medianoche es codigo para un caso imposible |
| Cobertura | `@vitest/coverage-v8` instalado, umbral automatico en `pnpm verify` | T0 lo difirio a T7 y T5b lo siguió difiriendo. Es un cambio de lockfile, asi que se pregunto |
| `base_price_cents` | Por pista y hora, sin multiplicar por jugadores | Dice el 7.3. Asimetria aceptada: una regla si puede multiplicar por jugadores, la base no |

## Que es y que no

**Es:** una funcion pura en `packages/core/src/domain/pricing.ts`. Nada mas.

**NO es T7** (y por tanto no se toca en esta tarea):

- La tabla `pricing_rules` y su RLS. Es T12, con el `check` de coherencia de `scope` y el
  `check` de `start_time <= end_time` que esta spec deja PREPARADOS.
- El precio en `GET /api/availability`. Es T12.
- Los endpoints de hold y reserva. Son T9, T10 y T11.
- El boton de reservar en `/pistas`. Depende de T11.

T7 no abre conexion a Postgres, asi que no lleva tests de integracion. La unica red de
seguridad sobre los datos que recibira son los tipos y los tests de la tabla de casos.

## Contrato

Los tipos ya existen en `domain/types.ts` desde T2, tal cual la seccion 10, y **no se tocan**:

```ts
export function resolvePrice(input: PricingInput): PriceQuote
```

Ruta `domain/pricing.ts` y no la `packages/core/pricing/resolve-price.ts` que ilustra la
seccion 10: lo que hay en el repo es `src/domain/{availability,color,types,validation}.ts` y
la seccion 10 es un ejemplo, no un layout. Un fichero mas en el sitio de los demas.

## Precedencia

Criterios, en este orden. Los tres primeros son de la seccion 7.3; el cuarto lo anade esta
spec porque sin el el resultado no es determinista:

1. `scope`: `court` > `court_type` > `global`.
2. Mayor `priority`.
3. `valid_from` mas reciente. Un `valid_from` NULL cuenta como EL MAS ANTIGUO, no como el mas
   reciente: una regla sin fecha de inicio lleva aplicandose siempre, y una regla con fecha
   se pone por delante de ella a proposito.
4. **Empate por `id` ascendente.**

El cuarto criterio no sale de la spec porque la spec no lo encontro necesario, y porque sin
el no hay determinismo que ofrecer: dos reglas con la misma prioridad y el mismo
`valid_from` NULL son indistinguibles para los tres primeros criterios, y gana la que el
plan de ejecucion de la consulta ponga primero. Mismo input, distinto importe, y el unico
cambio, la version de Postgres o el indice que decida usar. Con un cuarto criterio el
resultado depende solo de los datos.

Lo que NO aplica, y en este orden de comprobacion, porque es lo que se malgasta antes:

- `is_active = false`.
- El dia no esta en `dayOfWeek` (`[]` = todos, segun 4.3).
- La fecha del dia esta fuera de `[valid_from, valid_to]`. `NULL` es infinito en los dos
  extremos. `valid_to` es INCLUSIVO: una regla que caduca el dia 30 vale el dia 30.
- La duracion no coincide (decision 1).
- El slot no cabe entero en la franja (decision 2).

## Determinismo

- No muta `input` ni `input.rules`. La ordenacion va sobre una copia.
- El `sort` es estable en el motor, pero no se apoya en eso: el criterio 4 hace que el
  resultado no dependa del orden de llegada.
- `dayOfWeek` se calcula con aritmetica civil, no con `new Date()`. El guard de
  `boundaries.test.ts` prohibe `Date.now()` y `new Date()` sin argumentos en `core`, y con
  razon: un `getUTCDay()` depende del instante, no del dia que el club pide.

## Fallos

`resolvePrice` **revienta**, no devuelve un precio inventado, cuando:

- `startsAt` no es `YYYY-MM-DDTHH:MM`. Mismo criterio y mismo motivo que `computeAvailability`.
- La fecha de `startsAt` **no existe en el calendario**: 30 de febrero, mes 13, dia 0. El
  formato la deja pasar y el dia de la semana saldria de un dia que no existe. T12 lo
  prohibe en la base y la API exige el formato, pero aqui el dato lo pone quien llama y un
  precio calculado sobre un dia inexistente no es un precio. El 29 de febrero SI vale, y
  vale en 2024 y no en 2100, porque la regla del bisiesto es "divisible por 4, y si es
  divisible por 100 tiene que serlo por 400".
- `startTime` o `endTime` de una regla no es `HH:MM`, o es una hora que no existe. `24:00`
  si vale: `time` de Postgres lo admite y es el cierre del dia, asi que una regla de
  00:00 a 24:00 es la tarifa de las 24 horas. `25:00` y `10:60` no.
- `numPlayers` o `durationMin` no son positivos.

Un dia de `dayOfWeek` fuera de 0..6, en cambio, **no** revienta: la regla no casa con nada
y se descarta. Reventar ahi tiraria la disponibilidad de todo el club por un dato que en la
base va a estar prohibido con un `check`, mientras que ignorarlo es el fallo barato: se cobra
la tarifa base en vez de la punta. El `check` se escribe en T12.

## Desglose

- Sin regla aplicable: `totalCents = basePriceCents`, `ruleId = null`, `ruleName = null`, y
  una linea `Tarifa base`.
- Con regla: `totalCents = playerMultiplier ? priceCents * numPlayers : priceCents`, y el
  desglose lleva la linea de la regla mas la linea de jugadores cuando multiplica.

Las etiquetas estan en castellano a proposito: el producto es para clubes espanyoles. Si
alguna vez se vende fuera, esto pasa a `tenant_content` y no se toca el motor.

## Matriz de casos

Los casos que la spec 7.3 nombra, mas los que nacen de las decisiones de arriba:

| # | caso | resultado esperado |
|---|---|---|
| 1 | sin reglas | tarifa base, `ruleId = null` |
| 2 | regla `global` que aplica | su precio |
| 3 | `global` y `court_type` que aplican | gana `court_type` |
| 4 | `global`, `court_type` y `court` que aplican | gana `court` |
| 5 | dos del mismo scope con distinta `priority` | gana la mayor |
| 6 | misma `priority`, `valid_from` distinto | gana la mas reciente |
| 7 | misma `priority` y mismo `valid_from` (los dos NULL) | gana el `id` menor |
| 8 | `court_type` que no es el de la pista | no aplica |
| 9 | `court` que no es esa pista | no aplica |
| 10 | `is_active = false` | no aplica |
| 11 | dia fuera de `dayOfWeek` | no aplica |
| 12 | `dayOfWeek = []` | aplica todos los dias |
| 13 | fecha antes de `valid_from` | no aplica |
| 14 | fecha despues de `valid_to` | no aplica |
| 15 | fecha == `valid_from` | aplica (inclusivo) |
| 16 | fecha == `valid_to` | aplica (inclusivo) |
| 17 | `player_multiplier` con 3 jugadores | `precio * 3` |
| 18 | sin multiplicar con 3 jugadores | `precio`, no `precio * 3` |
| 19 | slot que se sale por el final de la franja | tarifa base |
| 20 | slot que cabe justo entero | aplica |
| 21 | slot que empieza justo en `start_time` | aplica |
| 22 | slot que empieza justo en `end_time` | no aplica |
| 23 | `startTime === endTime` | franja de 0 min: nunca aplica |
| 24 | `startTime > endTime` | nunca aplica |
| 25 | duracion de la regla distinta de la reserva | no aplica |
| 26 | domingo = 0, con dos dias contiguos | se aplica al domingo, no al lunes |
| 27 | multiples de 0, el primero enero 1970 | dia 4 (jueves) |
| 28 | los mismos datos en dos llamadas distintas | mismo `totalCents` |
| 29 | `startsAt` con formato raro | lanza |
| 30 | `numPlayers = 0` | lanza |
| 31 | `rules` no se muta al resolver | el array sigue igual |
| 32 | el resultado no depende del orden de llegada de las reglas | mismo `ruleId` |
| 33 | fecha que no existe, 2026-02-30 | lanza |
| 34 | 2024-02-29, ano bisiesto | aplica, y el dia de la semana es el suyo |
| 35 | 2100-02-29, ano no bisiesto | lanza |
| 36 | `startTime` 8:00 sin cero a la izquierda | lanza |
| 37 | `endTime` 25:00 | lanza |
| 38 | `endTime` 24:00, el cierre del dia | aplica a las 20:00 |
| 39 | slot que cabe en una franja y solo se solapa con otra | cobra la que lo contiene entero |
| 40 | `numPlayers = 0` con multiplicador | lanza, no un precio de 0 |
| 41 | las lineas del desglose suman el total | con y sin multiplicador |
| 42 | el mensaje de error nombra el dato recibido | el texto lleva el valor |

## Criterios de aceptacion

- [ ] Test primero: la tabla se escribe y se ve fallar antes de la implementacion
- [ ] Pura: sin `Date.now()`, sin `fetch`, sin Supabase, sin estado global. Lo vigila
      `boundaries.test.ts`, que ya esta
- [ ] Mismos datos de entrada -> mismo precio, siempre
- [ ] Nunca devuelve `null`
- [ ] `player_multiplier` con 3 jugadores devuelve `precio * 3`
- [ ] 100% de cobertura en `pricing.ts`, con umbral automatico que lo haga fallar
- [ ] `pnpm verify` entero en verde

## Criterio 7.3 que T7 NO cumple, y por que

> Todos los precios en la UI vienen del servidor. El cliente no puede enviar precio.

No hay precio en ninguna UI todavia. Eso se cumple en T12, con el endpoint, y el criterio
esta copiado ahi para que no se pierda. T7 no lo puede cumplir y no lo va a simular con un
test que no probaria nada.
