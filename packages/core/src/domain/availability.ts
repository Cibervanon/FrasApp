import type {
  AvailabilityInput,
  AvailabilityResult,
  AvailabilitySlot,
  TimeRange,
} from "./types.js";

/**
 * Cuantos slots hay, y cuales, en un dia. PURA: sin base de datos, sin reloj y sin azar.
 *
 * `boundaries.test.ts` lo verifica (no puede llamar a `new Date()` sin argumentos ni a
 * `Date.now()`), asi que la misma funcion corre en el servidor del club, en el navegador
 * del socio y en el portable de quien escribe el test, y salen lo mismo.
 *
 * ---------------------------------------------------------------------------------------
 * DONDE ESTA LA LOGICA DE VERDAD
 *
 * No esta aqui. Aqui esta la rejilla y la resta. Quien decide si un slot se puede RESERVAR
 * es la tabla `bookings`, con su `EXCLUDE` por `(tenant_id, court_id, tstzrange)`, y eso es
 * T9.
 *
 * La distincion es la que separa este MVP de uno que vende dos veces la misma pista:
 *
 *   - Availability calcula una estimacion. Puede quedarse desactualizada entre el momento
 *     en que el socio ve el hueco y el momento en que pulsa "reservar", porque otra
 *     pestana, otro movil o el propio gestor ha cogido esa hora mientras tanto.
 *   - La reserva se confirma contra el `EXCLUDE` de Postgres, en la misma transaccion que
 *     inserta la fila. Si dos intentos caen a la vez, UNO gana y el otro recibe un 409.
 *
 * Por eso el 409 de "alguien te ha ganado la hora" NO es un caso raro que se pueda
 * ignorar: es la respuesta normal a una carrera, y esta logica no puede evitarlo. Lo que
 * puede es no DISPONER de horas que ya estan ocupadas, que es lo que hace aqui.
 * ---------------------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------------------
 * LOS TRES BUGS QUE ESTA IMPLEMENTACION EVITA, Y COMO
 *
 * 1. `while (cursor < end) cursor += duracion` con `duracion = 0` no termina. La base lo
 *    impide con `courts_duration_positive`, pero esta funcion tambien la llama codigo que
 *    aun no ha pasado por la base, y un bucle infinito cuelga el proceso entero. Por eso
 *    se comprueba la duracion ANTES del bucle y se sale con la lista vacia.
 *
 * 2. Comparar el solape con `<` en vez de `solapa(a, b)`. Un bloque que empieza justo
 *    cuando un slot acaba no lo toca; con `<=` se lo come de mas y desaparece un huecon
 *    entero. Con `<=` AL OTRO LADO, un bloque que empieza un minuto antes no lo quita y el
 *    socio reserva encima de un cierre. `solapa()` es la unica forma de no tener las dos
 *    cosas.
 *
 * 3. Recorrer la rejilla guardando en un array y filtrar al final. Con una lista de
 *    "ocupado hasta las N", un mismo hueco se compara contra todos los bloques y el
 *    coste es de cuadrado. Aqui se avanza con un indice porque los bloques llegan
 *    ordenados, que es como los trae la consulta.
 * ---------------------------------------------------------------------------------------
 */

/**
 * Apertura por defecto: 8:00. Criterio 7.2.
 *
 * NO se exporta. Se exportara cuando T5d tenga que PINTAR "abierto de 8:00 a 22:00" en la
 * cabecera, y no antes: una constante exportada y sin usar es API permanente, y este
 * proyecto ya corrigio el mismo error en T2 (dos listas de features en core y
 * config-schema, escritas por separado) y en T4 (una migracion que especificaba una
 * restriccion que no se iba a usar). Lo que el endpoint necesita ahora ya lo tiene:
 * si no pasa `openMinuteOfDay`, sale 8:00.
 */
const DEFAULT_OPEN_MINUTE = 8 * 60;

/** Cierre por defecto: 22:00. Criterio 7.2. Sin exportar, por lo mismo. */
const DEFAULT_CLOSE_MINUTE = 22 * 60;

/** `YYYY-MM-DD`, y solo eso. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `HH:MM` en el dia del input. Sin segundos ni offset: el club razona en hora local. */
const ISO_LOCAL = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/;

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}

/** `minuteOfDay` -> `HH:MM`. */
function toHhmm(minuteOfDay: number): string {
  return `${pad2(Math.floor(minuteOfDay / 60))}:${pad2(minuteOfDay % 60)}`;
}

/**
 * Minutos desde medianoche de un instante ISO.
 *
 * Con `Z` se traduce a la hora local del club. Sin `Z` se asume que ya viene en hora local
 * del club, que es lo que hace Postgres cuando se le pide `date_trunc` sobre un
 * `timestamptz` con la sesion en la zona del tenant.
 */
function minuteOfDay(iso: string, date: string): number {
  const match = ISO_LOCAL.exec(iso);
  if (match === null) {
    throw new Error(
      `Instante '${iso}' con formato inesperado. Se esperaba ` +
        `YYYY-MM-DDTHH:MM, con o sin offset.`,
    );
  }
  // La fecha del instante tiene que ser la del input. Si no, el bloque es de otro dia y
  // compararlo contra esta rejilla daria un numero de minutos sin sentido en vez de un
  // "no aplica". Un `court_blocks` con `starts_at` del dia anterior es un dato que se
  // puede colar, y por aqui pasaria como si ocupara hoy.
  if (match[1] !== date) {
    throw new Error(
      `El instante '${iso}' es del dia ${match[1]} y se estaba buscando disponibilidad ` +
        `para el dia '${date}'. Un bloque de otro dia no debe llegar aqui.`,
    );
  }
  return Number(match[2]) * 60 + Number(match[3]);
}

/**
 * Dos franjas se solapan.
 *
 * Toque a partir de `>=`: un bloque que empieza JUSTO cuando acaba el slot no lo ocupa, y
 * uno que empieza un minuto antes si. `>` en el otro extremo, por el mismo motivo.
 */
function solapa(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

interface Rango {
  readonly start: number;
  readonly end: number;
}

/**
 * Normaliza y ordena `busy`.
 *
 * Descarta los rangos invertidos, en vez de tratarlos como "ocupa todo el dia". Un
 * `ends_at < starts_at` viola el `check` de la base, pero si se colara por una
 * migracion, un script o una mano, la pantalla del socio se quedaria sin ninguna hora y
 * sin ninguna pista de por que. Es mejor ignorarlos y que el siguiente test de
 * `court_blocks` lo delate.
 */
function normaliza(busy: ReadonlyArray<TimeRange>, date: string): Rango[] {
  const rangos: Rango[] = [];
  for (const rango of busy) {
    const start = minuteOfDay(rango.startsAt, date);
    const end = minuteOfDay(rango.endsAt, date);
    if (end <= start) continue;
    rangos.push({ start, end });
  }
  return rangos.sort((a, b) => a.start - b.start);
}

/**
 * Los slots libres de una pista en un dia.
 *
 * @throws si `date` no es `YYYY-MM-DD`, si la duracion no es positiva, o si un instante de
 *   `busy` no pertenece a ese dia. Los tres son datos que no deberían llegar aqui, y
 *   fallar es mas util que devolver una pantalla vacia sin explicar por que.
 */
export function computeAvailability(input: AvailabilityInput): AvailabilityResult {
  const { court, date, busy } = input;

  if (!ISO_DATE.test(date)) {
    throw new Error(
      `La fecha '${date}' no tiene formato YYYY-MM-DD. El endpoint la exige asi a ` +
        `proposito, para que "2026-3-2" no se interprete como un dia que no existe.`,
    );
  }

  const duracion = court.defaultDurationMin;
  if (!Number.isFinite(duracion) || duracion <= 0) {
    throw new Error(
      `La pista '${court.name}' tiene defaultDurationMin = ${String(duracion)}, que no ` +
        `es una duracion valida. Un check de la base lo impide, pero esta funcion no ` +
        `puede colgarse si alguien la llama antes de pasar por la base.`,
    );
  }

  const abrir = input.openMinuteOfDay ?? DEFAULT_OPEN_MINUTE;
  const cerrar = input.closeMinuteOfDay ?? DEFAULT_CLOSE_MINUTE;
  const ocupado = normaliza(busy, date);

  const slots: AvailabilitySlot[] = [];
  // Un indice que solo avanza, en vez de un `filter` sobre la rejilla entera. Los bloques
  // llegan ordenados, asi que un rango que ya ha quedado atras no puede volver a tocar
  // un slot posterior y no hace falta volver a mirarlo.
  let cursorOcupado = 0;

  for (
    let inicio = abrir;
    inicio + duracion <= cerrar;
    inicio += duracion
  ) {
    const fin = inicio + duracion;

    while (
      cursorOcupado < ocupado.length &&
      (ocupado[cursorOcupado] as Rango).end <= inicio
    ) {
      cursorOcupado += 1;
    }
    const choca = ocupado[cursorOcupado];
    const libre = choca === undefined || !solapa(inicio, fin, choca.start, choca.end);

    // El `inicio + duracion <= cerrar` del bucle ya impide un slot a medias, y el
    // comentario lo explica. Aqui solo se repite la idea, que es la que mas caro sale
    // cuando se olvida: un hueco de 30 minutos que el motor de precios no sabe cuanto
    // cobrar.
    if (libre) {
      slots.push({ startsAt: `${date}T${toHhmm(inicio)}`, endsAt: `${date}T${toHhmm(fin)}` });
    }
  }

  return { courtId: court.id, date, slots };
}
