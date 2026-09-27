import type { PriceQuote, PricingInput, PricingRule, PricingRuleScope } from "./types.js";

/**
 * El precio de una reserva. PURA: sin base de datos, sin reloj, sin azar y sin red, que
 * es lo que hace que la misma pregunta reciba la misma respuesta dentro de tres meses,
 * cuando el club haya cambiado tres tarifas.
 *
 * Ver `docs/specs/t7-resolve-price.md` para las decisiones y `pricing.test.ts` para los
 * 42 casos. Aqui solo lo que no se deduce leyendo el nombre de las funciones.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE ESTA SEPARADA DE TODO
 *
 * Porque el precio es el unico dato del MVP que no puede depender de nada que cambie por
 * su cuenta. El nombre del club se puede leer de la base y listo, la disponibilidad se
 * puede recalcular cuando otra pestana reserve, el nombre de la pista tampoco cambia.
 * El precio no: si la respuesta depende de la version de Postgres, de como el optimizador
 * ordena las filas o de la zona horaria del proceso, hay dos reservas identicas con dos
 * importes, y el socio solo ve uno.
 *
 * Por eso la entrada NO lleva la lista de reglas filtrada. Llega entera y la funcion
 * decide, porque "filtradas" es una palabra que significa "quien filtro y con que
 * criterio", y si el filtro lo hace la base el motor deja de ser el motor: pasa a ser una
 * funcion que confia en un `order by` de otra persona.
 * ---------------------------------------------------------------------------------------
 */

/**
 * `YYYY-MM-DDTHH:MM`, con segundos opcionales. Sin offset: mira el otro patron.
 *
 * Con segundos SI se aceptan, porque `timestamptz` los trae, pero se ignoran: una regla
 * de precio tiene granularidad de minuto y dos instants que se diferencian en segundos
 * son el mismo slot.
 */
const INSTANTE_LOCAL = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?$/;

/**
 * Un offset de zona horaria al final: la `Z` de UTC o el `+02:00` del verano.
 *
 * ESTO SE RECHAZA, y es la decision mas importante del fichero despues de la
 * precedencia. `starts_at` es `timestamptz`, o sea que lo que sale de la base trae
 * `Z`, y las 10:00 de un string con `Z` NO son las 10:00 del club: en un club de
 * `Europe/Madrid` en verano son las 12:00. Aceptar el string y usar sus horas tal cual
 * desplaza todas las franjas un numero de horas que depende del dia del ano, porque el
 * offset cambia con el horario de verano, y el precio de un martes de julio no coincide
 * con el del martes de enero.
 *
 * Convertir aqui exigiria una base de datos de zonas horarias y un reloj, o sea que el
 * motor dejaria de ser puro. La conversion es de quien llama, y T12 la hace en el
 * `select` con `at time zone`. Ojo: `availability.ts` SI acepta offsets y los usa como si
 * fueran hora local, que es la misma trampa con menos consecuencias. Anotado en
 * `findings.md`.
 */
const CON_OFFSET = /(?:Z|[+-]\d{2}:?\d{2})$/;

/** `HH:MM` de `time`. Se acepta `24:00` porque Postgres lo acepta. */
const HORA_LOCAL = /^(\d{2}):(\d{2})$/;

/** Minutos de un dia, con 24:00 como 1440. Un dia entero. */
const MINUTOS_DE_UN_DIA = 1440;

/** Etiqueta del desglose cuando no hay regla. Castellano, como el producto. */
const ETIQUETA_BASE = "Tarifa base";

/**
 * Que tan especifica es una regla. Mayor = mas especifica.
 *
 * `scope` va ANTES que `priority`, no se suman. Si se sumaran, un `priority: 99` en la
 * tarifa global aplastaria a la tarifa del tipo de pista, que es justo la tarifa que el
 * club escribe para no cobrar lo de cristal en la malla.
 */
function especificidad(scope: PricingRuleScope): number {
  if (scope === "court") return 2;
  if (scope === "court_type") return 1;
  return 0;
}

function esBisiesto(year: number): boolean {
  // La regla es de tres pasos, no `year % 4`. 1900 y 2100 son divisibles por 100 y no
  // por 400, asi que NO son bisiestos; 2000 si lo es. Sin el paso del 400, el dia de la
  // semana de esas fechas sale desplazado un dia y la tarifa de punta se aplica al dia
  // equivocado.
  if (year % 4 !== 0) return false;
  if (year % 100 !== 0) return true;
  return year % 400 === 0;
}

/**
 * Dias que tiene un mes. Para poder rechazar el 30 de febrero sin `Date`.
 */
function diasDelMes(year: number, month: number): number {
  if (month === 2) return esBisiesto(year) ? 29 : 28;
  if (month === 4 || month === 6 || month === 9 || month === 11) return 30;
  return 31;
}

/**
 * Dias desde 1970-01-01, por aritmetica civil.
 *
 * Es la cuenta de Howard Hinnant: se pasa la fecha a un "ano de 400 anos" y de ahi sale
 * un numero de dias contados, sin tablas ni bucles. La alternativa `new Date()` esta
 * prohibida por el guard de capas, y con razon: devuelve el dia de HOY, no el del input.
 *
 * Devuelve dias, no semanas: el dia de la semana sale en `diaDeLaSemana`.
 */
function diasDesdeEpoch(year: number, month: number, day: number): number {
  // En enero y febrero el "ano" civil es el anterior: el ano empieza el 1 de marzo en
  // este conteo, que es lo que hace que los bisiestos caigan al final del ciclo.
  const y = year - (month <= 2 ? 1 : 0);
  const era = Math.floor(y / 400);
  const yoe = y - era * 400; // 0..399
  const mp = (month + 9) % 12; // marzo = 0
  const doy = Math.floor((153 * mp + 2) / 5) + day - 1; // 0..365
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
}

/**
 * Dia de la semana de una fecha: 0 domingo, 6 sabado. El orden de la spec 4.3, que no es
 * el ISO (donde el lunes es el 1).
 *
 * 1970-01-01 fue un jueves, asi que el dia 0 del conteo es un 4.
 */
function diaDeLaSemana(year: number, month: number, day: number): number {
  const dias = diasDesdeEpoch(year, month, day);
  // El `%` de un negativo sale negativo, y con el `+ 7` el resultado siempre cae en
  // 0..6. Una fecha de antes de 1970 es legitima (una reserva de 1960 no, pero una regla
  // de 2019 validada hoy, si) y sin esto devolveria un dia negativo.
  return ((dias % 7) + 11) % 7;
}

interface Momento {
  readonly date: string;
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly minuto: number;
}

/**
 * Lee el instante de la reserva y lo parte en fecha y minuto del dia.
 *
 * @throws si el formato no es `YYYY-MM-DDTHH:MM`, si la fecha no existe en el calendario
 *   o si la hora no cabe en el dia.
 */
function momentoDe(startsAt: string): Momento {
  if (CON_OFFSET.test(startsAt)) {
    throw new Error(
      `El instante '${startsAt}' trae zona horaria, y este motor no convierte zonas. ` +
        `Las reglas de precio son por HORA LOCAL del club: un 'T10:00Z' de un club de ` +
        `Madrid en verano son las 12:00 suyas, y aplicarle la franja de 10:00 cobraria la ` +
        `tarifa equivocada dos horas antes. Pasa la hora local del club, no el instante.`,
    );
  }

  const match = INSTANTE_LOCAL.exec(startsAt);
  if (match === null) {
    throw new Error(
      `El instante '${startsAt}' no tiene el formato que espera el motor de precios. ` +
        `Se necesita 'YYYY-MM-DDTHH:MM' en HORA LOCAL del club, porque las reglas de ` +
        `precio son por hora de club. Si llega en UTC, la franja de punta se desplaza.`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);

  if (month < 1 || month > 12) {
    throw new Error(`'${startsAt}' tiene el mes ${month}, y un mes va de 1 a 12.`);
  }
  const maximo = diasDelMes(year, month);
  if (day < 1 || day > maximo) {
    throw new Error(
      `'${startsAt}' pide el dia ${day} de un mes que tiene ${maximo} dias. Una fecha ` +
        `que no existe no tiene dia de la semana, y sin dia de la semana no hay tarifa.`,
    );
  }
  // 24:00 no es una hora de reloj pero si el final de un dia. El `24:00` como `startTime`
  // seria una franja de 0 minutos que no aplica nunca, asi que se deja pasar: que no
  // aplique es la respuesta correcta para las dos.
  if (hour < 0 || hour > 24 || minute < 0 || minute > 59) {
    throw new Error(
      `'${startsAt}' tiene la hora ${match[4]}:${match[5]}, que no existe. La 24:00 si ` +
        `vale, porque es el cierre del dia.`,
    );
  }
  if (hour === 24 && minute > 0) {
    throw new Error(`'${startsAt}' tiene la hora 24:${match[5]}. La 24:00 es el cierre del dia, no las 24 y pico.`);
  }

  return {
    date: `${match[1]}-${match[2]}-${match[3]}`,
    year,
    month,
    day,
    minuto: hour * 60 + minute,
  };
}

/** `HH:MM` -> minutos desde medianoche. `24:00` son 1440. */
function minutosDeHora(hora: string, contexto: string): number {
  const match = HORA_LOCAL.exec(hora);
  if (match === null) {
    throw new Error(
      `La hora '${hora}' de ${contexto} no es 'HH:MM'. Sin las dos cifras, '8:00' y ` +
        `'08:00' seriam dos horas distintas y la franja no casaria con nada.`,
    );
  }
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (hour > 24 || minute > 59 || (hour === 24 && minute > 0)) {
    throw new Error(
      `La hora '${hora}' de ${contexto} no existe. La 24:00 si vale, porque es el cierre ` +
        `del dia.`,
    );
  }
  return hour * 60 + minute;
}

/**
 * Si la regla sigue viva en la fecha de la reserva. `null` es infinito en los dos
 * extremos.
 *
 * Los dos extremos son INCLUSIVOS. Una regla con `valid_from = 2026-09-27` tiene que
 * aplicar el 27, que es el dia que el club escribio; y una con `valid_to = 2026-09-27`
 * tiene que aplicar el 27, que es el dia que pago el socio. Con cualquiera de los dos
 * en exclusivo, el club pierde un dia de cobro o regala uno.
 *
 * La comparacion es de CADENAS a proposito: `YYYY-MM-DD` ordena igual que la fecha que
 * representa, y comparar fechas sin `Date` es comparar dos numeros que significan dias
 * contados desde 1970. Una cadena de texto tambien valdria, pero la base manda `date` y
 * comparar con el mismo tipo que devuelve la base quita una conversion de por medio.
 */
function vivaEn(rule: PricingRule, momento: Momento): boolean {
  if (rule.validFrom !== null && rule.validFrom > momento.date) return false;
  if (rule.validTo !== null && rule.validTo < momento.date) return false;
  return true;
}

/**
 * Si la franja de la regla contiene el slot ENTERO. Decision del spec de T7.
 *
 * `inicio >= desde && fin <= hasta`, con el `[desde, hasta)` medio abierto por el final.
 * Que el slot quepa entero, y no solo su inicio, es lo que evita que la tarifa punta se
 * escape al final de la franja: un slot de 20:30 a 22:00 no cabe en 18:00-21:00, y con
 * "basta con empezar dentro" cobraria punta siendo medio horario normal.
 *
 * Una franja con `start >= end` no contiene nada, ni una de largo cero. Es lo que
 * decide el caso de `22:00-02:00`: se ignora, en vez de interpretarse cruzando
 * medianoche. Con el horario 8:00-22:00 del club no hay slot que caiga ahi, asi que
 * ignorarla no cambia un importe.
 */
function contieneSlot(regla: PricingRule, inicio: number, fin: number): boolean {
  const desde = minutosDeHora(regla.startTime, `la regla '${regla.name}'`);
  const hasta = minutosDeHora(regla.endTime, `la regla '${regla.name}'`);
  if (desde >= hasta) return false;
  return inicio >= desde && fin <= hasta;
}

/** Si la regla aplica a esta pista. El `court_type` y el `court` se miran a la vez. */
function aplicaAPista(rule: PricingRule, input: PricingInput): boolean {
  if (rule.scope === "court") return rule.courtId === input.court.id;
  if (rule.scope === "court_type") return rule.courtType === input.court.courtType;
  return true;
}

/** Si la regla aplica a este dia de la semana. `[]` es "todos los dias" (spec 4.3). */
function aplicaAlDia(rule: PricingRule, dia: number): boolean {
  if (rule.dayOfWeek.length === 0) return true;
  // Un dia fuera de 0..6 no casa con nada y la regla se descarta. NO se revienta: en la
  // base lo prohibe un `check` de 0..6, y un dato mal puesto en el panel no puede tirar
  // la disponibilidad de todo el club. Es el fallo barato: se cobra la tarifa base en vez
  // de la punta.
  return rule.dayOfWeek.includes(dia);
}

/**
 * Si la regla aplica, de punta a punta.
 *
 * El orden NO es el del spec y es a proposito: primero lo barato de descartar. Las reglas
 * de un club son pocas, pero la comprobacion de la franja parsea dos horas, y hacerlo
 * para las 40 reglas que no son de esta pista es trabajo para nada.
 */
function aplica(rule: PricingRule, input: PricingInput, momento: Momento, dia: number): boolean {
  if (!rule.isActive) return false;
  if (rule.durationMin !== input.durationMin) return false;
  if (!aplicaAPista(rule, input)) return false;
  if (!aplicaAlDia(rule, dia)) return false;
  if (!vivaEn(rule, momento)) return false;
  return contieneSlot(rule, momento.minuto, momento.minuto + input.durationMin);
}

/**
 * Criterios de orden, del mas fuerte al mas flojo. Los tres primeros son los de la
 * spec 7.3; el cuarto es mio y hace falta para que la funcion sea determinista.
 *
 * Un `sort` de JavaScript es estable, asi que sin el cuarto criterio el resultado
 * dependeria del orden de llegada de las filas: dos reglas con la misma prioridad y el
 * mismo `valid_from` NULL son indistinguibles para los tres primeros, y gana la que la
 * consulta haya puesto primero. Mismo input, distinto importe, y el unico cambio es la
 * version de Postgres o el indice que decida usar. Con el cuarto, el resultado depende
 * solo de los datos.
 *
 * El `valid_from` NULL se trata como EL MAS ANTIGUO, no como el mas reciente. Al reves,
 * una regla sin fecha se pondria por encima de todas las reglas con fecha, y una tarifa
 * de septiembre no se aplicaria nunca mientras haya una regla general sin fecha.
 */
function porCriterio(a: PricingRule, b: PricingRule): number {
  // Los locales NO se llaman como la funcion. `const especificidad = especificidad(...)`
  // es un ReferenceError en cuanto se ejecuta: la declaracion `const` vive en el mismo
  // ambito y su zona muerta temporal llega hasta el punto de la inicializacion. El
  // compilador lo acepta y el fallo sale en ejecucion, en el `sort`, y solo cuando hay
  // dos reglas que comparar.
  const diferenciaDeScope = especificidad(b.scope) - especificidad(a.scope);
  if (diferenciaDeScope !== 0) return diferenciaDeScope;

  const diferenciaDePrioridad = b.priority - a.priority;
  if (diferenciaDePrioridad !== 0) return diferenciaDePrioridad;

  const desdeA = a.validFrom ?? "";
  const desdeB = b.validFrom ?? "";
  if (desdeA !== desdeB) {
    return desdeB > desdeA ? 1 : -1;
  }

  // Ultimo criterio, y el que hace que la funcion sea DETERMINISTA. Con operadores y no
  // con `localeCompare`: este ordena con las reglas de colacion de ICU, que dependen
  // del idioma del sistema y de la version de ICU. Para `YYYY-MM-DD` y para UUIDs en
  // hexadecimal hoy no hay diferencia, pero esta funcion vende la promesa de que el
  // mismo input da el mismo precio, y prometer eso mientras el comparador depende de la
  // configuracion regional de la maquina es mentira a la espera: en un servidor con
  // reglas de colacion distintas, dos reglas empatadas se ordenarian al reves y el
  // importe del club cambiaria segun quien ejecutase el servidor.
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}

/**
 * El precio de una reserva, y el desglose con el que se explica.
 *
 * @throws si `startsAt` no es un instante local legible, si la fecha no existe, si una
 *   regla trae una hora mal escrita, o si `durationMin` o `numPlayers` no son positivos.
 *   Todos son datos que no deberían llegar, y fallar es mas util que devolver un importe
 *   inventado: un precio de 0 por `numPlayers = 0` es un regalo que el socio agradece y
 *   el club no.
 *
 * NUNCA devuelve `null`. Sin regla aplicable cae a `courts.base_price_cents`, que es un
 * precio por pista y hora y no se multiplica por jugadores. Esa asimetria es de la spec
 * y conviene saberla: una regla SI puede multiplicar por jugadores (`player_multiplier`),
 * el precio base no.
 */
export function resolvePrice(input: PricingInput): PriceQuote {
  const { court, rules, startsAt, durationMin, numPlayers } = input;

  const momento = momentoDe(startsAt);
  if (!Number.isFinite(durationMin) || durationMin <= 0) {
    throw new Error(
      `La duracion de la reserva es ${String(durationMin)} minutos, y un slot de 0 o ` +
        `negativo minutos no se puede ni pintar ni cobrar.`,
    );
  }
  if (!Number.isFinite(numPlayers) || numPlayers <= 0) {
    throw new Error(
      `La reserva es para ${String(numPlayers)} jugadores. Una pista va de 2 a 4, y con 0 ` +
        `jugadores el multiplicador daria un precio de 0.`,
    );
  }

  const dia = diaDeLaSemana(momento.year, momento.month, momento.day);

  // Copia antes de ordenar: `rules` es del llamante, y un `sort` en el sitio mutaria sus
  // datos. Con dos endpoints compartiendo la lista, el segundo recibe un array reordenado
  // sin que nadie lo haya pedido.
  const candidata = rules
    .filter((rule) => aplica(rule, input, momento, dia))
    .sort(porCriterio);

  const ganadora = candidata[0];
  if (ganadora === undefined) {
    return {
      totalCents: court.basePriceCents,
      ruleId: null,
      ruleName: null,
      breakdown: [{ label: ETIQUETA_BASE, cents: court.basePriceCents }],
    };
  }

  const totalCents = ganadora.playerMultiplier
    ? ganadora.priceCents * numPlayers
    : ganadora.priceCents;

  return {
    totalCents,
    ruleId: ganadora.id,
    ruleName: ganadora.name,
    breakdown: [
      { label: ganadora.name, cents: totalCents },
      // La segunda linea lleva 0 a proposito: es el FACTOR aplicado, no un cobro. Quien
      // la pinte tiene que saber que es un factor, o el socio leera que le cobran 0,00
      // por los jugadores. Aviso en `findings.md` para T12.
      ...(ganadora.playerMultiplier
        ? [{ label: `${String(numPlayers)} jugadores`, cents: 0 }]
        : []),
    ],
  };
}
