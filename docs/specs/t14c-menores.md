# Spec T14c: Verificacion de menores en servidor

Addendum de `docs/specs/padel-template-mvp.md` (secciones 4.1, 4.4, 6.2, 7.5 y la demo 12
del cierre) y de `tasks/todo.md` (T14c). Redactada el 2026-09-29 al cierre de T14b.

## El agujero, en una frase

`bookings.is_minor` lo escribe el SERVIDOR comparando `player_birth_date` con
`tenants.min_player_age`. Hoy, T9 escribio el `check` de la tabla y T11 escribio el
`INSERT` de `crearHold` con `is_minor = false` constante (`holds.ts:305-312`): el `check`
ve `false` y no exige tutor. Un menor de 15 anos que reserve hoy entra sin datos de tutor,
y el `check` no ayuda en nada.

Un `check` **no puede** cerrar este agujero, y conviene decirlo sin rodeos porque es el
motivo de que T14c sea una tarea propia y no un criterio dentro de T9 o T11: el `check`
solo puede verificar lo que el servidor ya ha decidido. Si el servidor acepta
`is_minor = false` del cuerpo, la base de datos esta mirando al cliente y creyendole.

## Decisiones que esta spec cierra (preguntadas, no inferidas)

**T14c-A. La edad se decide al CREAR EL HOLD, no al confirmar.** El unico camino por el que
el servidor ve datos del jugador es `POST /api/holds` (T11). La confirmacion es
`POST /api/payments/intent` (T14) y su webhook, y un webhook no tiene cuerpo de peticion
que preguntar: si el requisito se comprobase al confirmar, el menor que manipula el
navegador llegaria al webhook sin datos de tutor y ahi no habria quien se los pidiera. El
`is_minor` calculado viaja con la fila por todo el ciclo (`held` -> `pending_payment` ->
`confirmed`), y el `check` de T9 lo vigila en cada salto. Es el mismo criterio que T14b
aplico para el reembolso: el estado de negocio se decide donde hay contexto, no donde
llega la consecuencia.

**T14c-B. `player_birth_date` es OBLIGATORIA en el hold. [DECIDIDA por el usuario el
2026-09-29]** `tasks/todo.md` escribia "Si la fecha de nacimiento no se envia y el jugador
es un adulto segun el umbral, la reserva se crea normal. La fecha solo es obligatoria para
quien es menor". Esa frase no se sostiene: si la fecha es opcional, un menor de 15 anos
la **omite** y entra igual, y la demo 12 de la spec ("un socio con 15 anos no puede
completar una reserva sin datos de tutor, aunque manipule la peticion desde el
navegador") deja de ser cierta. Un servidor que no conoce la edad no puede exigir la
edad. Esa linea del plan se corrige con esta decision, y el fichero de tareas se actualiza
en E4.

El coste es real y hay que decirlo: es un campo mas que pide el formulario a un adulto, y
es un dato personal mas que T19 tiene que exportar y borrar (RGPD). El usuario lo asume al
aprobar. La alternativa opcional dejaba la edad en manos del navegador.

**T14c-C. `is_minor` NUNCA se lee del cuerpo.** `validarCuerpo` (ruta de holds) no lo
acepta como campo conocido, y el `INSERT` recibe el booleano del servidor. Un
`isMinor: false` en el cuerpo se **ignora**, no es un 400: mismo criterio que T14b-F con
`amount_cents` (el cliente no puede cambiar el resultado, y un 400 por un campo que se
ignora seria ensenarle al socio a reintentar sin el campo). La consecuencia es que el
cliente tampoco puede DECLARAR mayor a un menor: `is_minor = true` con fecha de adulta
produce `is_minor = false`, y el servidor decide en los dos sentidos (caso 10).

**T14c-D. El umbral y el "hoy" salen de Postgres, en una sola lectura.**
`select min_player_age, to_char(now() at time zone $tz, 'YYYY-MM-DD') as hoy from tenants
where id = $1`. Tres razones: el umbral no es una constante del codigo (cada club tiene el
suyo, entre 14 y 21 por `check`); el reloj es el de la base, el mismo que caduca los holds
y cierra los huecos, asi que no hay dos relojes discrepantes; y la RLS devuelve solo su
propio tenant, sin una segunda vuelta. Sin viaje extra de red: cabe en el mismo sitio donde
hoy se lee la pista.

**T14c-E. La comparacion de edad es una funcion PURA en `core`, con las tres fechas como
`YYYY-MM-DD` y nada de `Date` ni de zona horaria dentro.** `esMenorDeEdad({ fechaNacimiento,
edadMinima, hoy }) -> boolean`, en `packages/core/src/domain/`, con tests unitarios sin
Postgres, como el motor de reembolso de T8. La comparacion es de CALENDARIO, no de dias
transcurridos: cumplir anos hoy es ser adulto hoy (el mismo limite inclusivo `>=` que los
tramos de reembolso). La funcion **lanza** ante una fecha imposible (futura, mal formada) o
un umbral fuera de 14..21, en vez de devolver `false`: un `false` silencioso por una fecha
rota seria un menor entrando sin tutor, que es justo el agujero. La app transforma el
lanzamiento en **400**.

**T14c-F. `guardian_consent_at` lo pone el SERVIDOR como `now()`. El cliente no manda una
fecha de consentimiento.** El momento del consentimiento es un hecho de la peticion, no una
afirmacion que el cliente pueda fechar donde quiera; si lo aceptamos del cuerpo, un
"acepto" de 2020 con la reserva de hoy es indistinguible de uno de hace un minuto. El
cliente manda los datos del tutor (`guardianName`, `guardianEmail`, `guardianPhone`,
`guardianRelation`) y el resto lo pone el servidor. `guardianRelation` tiene que estar en
`'madre' | 'padre' | 'tutor_legal' | 'otro'`: si no, **400** (el `check`
`bookings_guardian_relation_allowed` sigue siendo la segunda capa).

**T14c-G. Menor + datos de tutor incompletos -> 422 `faltan_datos_tutor`, con CERO filas.**
No es un 400: el cuerpo esta bien formado, y lo que falta solo se sabe DESPUES de que el
servidor ha hecho su calculo. Un 400 diria "tu peticion esta mal escrita" y un 422 dice
"no puedo aceptarla asi", que es lo que ha pasado. Cero efectos es lo importante: la
comprobacion va ANTES del `INSERT`, y el test cuenta las filas. Las cuatro columnas de tutor
que exige la spec son `guardian_name`, `guardian_email`, `guardian_phone` y
`guardian_consent_at`; este ultimo lo pone el servidor, asi que el cliente aporta tres.

**T14c-H. La respuesta lleva el flag, y la pantalla lo consume en T18a.** `HoldCreado` gana
`isMinor`, y el **201** de `POST /api/holds` lo trae. La spec 6.2/7.5 pide que el aviso de
responsabilidad aparezca en `/reserva/confirmar` "si y solo si el jugador es menor", y esa
pantalla todavia no existe (hoy solo hay `/pistas` y `/admin/pagos`): T14c entrega y prueba
el flag y el 422, y el aviso se verifica en T18a, que es quien pinta. Escribir aqui un
criterio que solo se puede cumplir mas adelante seria un checkbox que miente.

**T14c-I. T14c NO toca el precio.** La spec no tiene ninguna regla de precio por edad: la
unica regla por jugadores es el `player_multiplier` de T7. Un descuento para menores, si un
club lo quiere, es un cambio de `pricing_rules` (T18d), no de esta tarea. Se dice
explicitamente para que nadie lea "menores" y asuma que el importe cambia.

## El flujo completo

```
socio -> POST /api/holds
  1. resolveTenant + subDeSesion                          (sin sesion -> 401)
  2. validarCuerpo: courtId, startsAt, numPlayers, playerName, playerBirthDate
     (YYYY-MM-DD) y guardian* opcionales                   (forma mala -> 400)
  3. leer umbral y "hoy" del club, en una consulta       (min_player_age, hoy)
  4. esMenorDeEdad({ playerBirthDate, minPlayerAge, hoy }) -> is_minor DEL SERVIDOR
                                                          (imposible -> 400)
  5. si is_minor y faltan datos de tutor -> 422 faltan_datos_tutor, CERO filas
  6. disponibilidad y precio (T12, sin cambios)            (404 pista / 409 hueco)
  7. INSERT con is_minor del servidor, player_birth_date, guardian_* del cliente y
     guardian_consent_at = now() si y solo si es menor    (el check de T9 muerde igual)
  8. 201 con is_minor en el cuerpo
```

## Matriz de casos (endpoint `POST /api/holds`)

| # | caso | resultado |
|---|---|---|
| 1 | adulto (30 anos), sin datos de tutor | 201, `is_minor = false` |
| 2 | **PRINCIPAL**: el cuerpo dice `isMinor: false` con fecha de 15 anos y sin tutor | 422 `faltan_datos_tutor`, CERO filas: el `false` del cliente se ignora |
| 3 | mismo caso 2 pero con nombre, email, telefono y relacion de tutor | 201, `is_minor = true`, `guardian_consent_at` = ahora (no el del cliente) |
| 4 | 17 anos en un tenant con `min_player_age = 16` | 201, `is_minor = false`: el umbral es del club |
| 5 | el mismo dia, el club sube su umbral a 21 y la fecha es de 19 anos | 422: el umbral sale de la base, no del codigo |
| 6 | tenant nuevo sin configurar nada | umbral 18 (el default de la columna; test explicito) |
| 7 | fecha mal formada: `"ayer"`, `"2015-13-45"`, `"20150301"` | 400 |
| 8 | fecha futura | 400 (el motor lanza; un `false` silencioso seria un menor sin tutor) |
| 9 | `guardianRelation = "abuela"` | 400 |
| 10 | el cuerpo dice `isMinor: true` con fecha de adulta | 201 con `is_minor = false`: el cliente no declara tampoco |
| 11 | liberar el hold (T11) | la fila conserva fecha y tutor: el borrado es de T19 (RGPD) |
| 12 | el `check` de T9 sigue | un INSERT con `is_minor = true` sin tutor -> 23514; y el inverso, `is_minor = false` con fecha de menor, la base lo **acepta**: por eso existe T14c |

## Matriz de tests (desglose E1-E4, TDD: ROJO antes que implementacion)

- **E1: `esMenorDeEdad` en `packages/core/src/domain/` + unitarios.** Sin Postgres: 15 anos
  con umbral 18 -> menor; cumple 18 hoy -> adulto; cumple 18 manana -> menor; 17 con umbral
  16 -> adulto; umbral 14 con 13 anos -> menor; fecha futura -> lanza; umbral 21 con 22 anos
  -> adulto; formato invalido -> lanza. Los limites exactos son parte de la tabla, como en
  los tramos de T8.
- **E2: `crearHold` cableado (Postgres REAL) + tests DB.** Matriz 1-6, 10 y 12 contra la
  fila: `is_minor`, `player_birth_date`, los 4 campos de tutor y `guardian_consent_at`
  escrito por el servidor. El caso 2 cuenta filas (cero efectos) y el caso 5 sube el umbral
  del tenant en la propia transaccion del test, sin hardcodear.
- **E3: ruta `POST /api/holds` + tests DB.** Los status exactos: 400 por forma, 422
  `faltan_datos_tutor`, 201 con `is_minor` en el cuerpo, y el test del cuerpo manipulado
  (caso 2) a nivel HTTP, con la sesion y el tenant propios del fichero.
- **E4: `pnpm verify` raiz + detect-changes + memorias.**

## Fuera de alcance de T14c

- La pantalla `/reserva/confirmar` y el aviso de responsabilidad: **T18a** (T14c entrega el
  flag que la pantalla consume).
- Editar `min_player_age` desde el panel del gestor: **T18e**.
- Exportar y borrar `player_birth_date` y los datos de tutor: **T19** (RGPD). T14c anade el
  dato, T19 lo borra; el criterio de T19 que repite el caso manipulado se queda como
  asercion transversal, no como trabajo duplicado.
- Cualquier regla de precio por edad: no existe (T14c-I).
- `open_matches` e invitaciones (T15, T16), que tambien crearan filas en `bookings`: cuando
  lleguen, tendran que usar el mismo `esMenorDeEdad` en el servidor.

## Criterios de aceptacion

- [ ] **TEST PRINCIPAL (caso 2): el cliente envia `isMinor: false` con una fecha que da
      menor. El servidor lo RECALCULA a `true`, exige los 4 campos y NO crea la reserva**
- [ ] El caso 3: con los datos de tutor completos, la reserva se crea con `is_minor = true`
      y `guardian_consent_at` puesto por el servidor
- [ ] El caso 4: con `min_player_age = 16`, 17 anos NO es menor
- [ ] El umbral sale de la base, no de una constante: el caso 5 lo sube en el test
- [ ] Un tenant nuevo nace con `min_player_age = 18` sin que nadie lo configure
- [ ] El caso 7 y el 8: fecha mal formada o futura -> 400
- [ ] El caso 10: el cliente no puede declarar mayor a un menor
- [ ] El caso 12: el `check` de T9 sigue existiendo como segunda capa, y el test deja
      escrito que la base por si sola NO cierra el agujero
- [ ] El 201 de `POST /api/holds` trae `is_minor`, para que T18a muestre el aviso si y solo
      si el servidor determino menor
- [ ] Cero filas cuando faltan los datos de tutor (el 422 no deja rastro)
- [ ] El precio del hold no cambia (T14c-I)
