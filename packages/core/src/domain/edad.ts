/**
 * La edad del jugador, en PURO y sin Postgres: T14c de la spec (secciones 4.1 y 7.5, y la
 * decision T14c-E de `docs/specs/t14c-menores.md`).
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE ESTA FUNCION EXISTE Y POR QUE VIVE EN `core`
 *
 * `bookings.is_minor` lo escribe el servidor con lo que devuelva aqui, y de eso depende
 * la UNICA proteccion real del requisito de tutor: el `check` de la tabla comprueba que si
 * `is_minor = true` haya tutor, pero no puede saber si el jugador es menor. Si el servidor
 * se equivoca al decidir, el `check` no lo salva: mira lo que le han dado. Por eso el
 * calculo es una funcion pura, con sus limites en tests unitarios, y no una linea de SQL
 * dentro de un endpoint.
 *
 * Es la misma razon por la que el motor de reembolso de T8 es puro: un fallo de edad es
 * un menor jugando sin tutor y un problema legal para el club, y eso tiene que salir de un
 * test rojo, no de un ticket.
 *
 * ---------------------------------------------------------------------------------------
 * CALENDARIO, NO DIAS TRANSCURRIDOS
 *
 * Se compara con el CALENDARIO (`corte = hoy - edadMinima años`), nunca con
 * `(hoy - nacimiento) / 365.25 dias`. Un año bisiesto tiene 366 dias y un cumpleaños no es
 * "hace 365 dias": con la cuenta de dias, un socio que cumple 18 mañana puede salir
 * marcado como adulto un dia antes de su cumpleaños, y ese dia es exactamente el que la
 * spec cierra con "si y solo si".
 *
 * El limite es INCLUSIVO, como el `>=` de los tramos de reembolso: el dia que se cumple
 * la edad minima, ya se puede jugar, y al dia siguiente todavia no.
 *
 * ---------------------------------------------------------------------------------------
 * NADA DE `Date` NI DE ZONA HORARIA DENTRO
 *
 * Las tres fechas son `YYYY-MM-DD` y se procesan como tres numeros. Sin `new Date()`
 * (whose reglas de parseo y de DST no son un contrato que se pueda defender en un test) y
 * sin zona horaria (una fecha de nacimiento es un dia del calendario del club, no un
 * instante). El "hoy" lo pone quien llama, y lo pone Postgres con el reloj y la zona del
 * club (T14c-D), no el reloj del proceso de Node.
 */

/** El umbral que la columna permite, y que una SPEC (4.1) limita a 14..21. */
const EDAD_MINIMA_ADMISIBLE = 14;
const EDAD_MAXIMA_ADMISIBLE = 21;

interface Fecha {
  readonly anio: number;
  readonly mes: number;
  readonly dia: number;
}

const DIAS_POR_MES = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

/** `AAAA-MM-DD` a tres numeros, con el rango del mes comprobado (nada de `Date`). */
function aFecha(texto: string, nombre: string): Fecha {
  const coincide = /^(\d{4})-(\d{2})-(\d{2})$/.exec(texto);
  if (coincide === null) {
    throw new Error(
      `La ${nombre} '${texto}' no es una fecha en formato AAAA-MM-DD. Sin un dia del ` +
        `calendario no se puede comparar una edad, y devolver "no es menor" por una fecha ` +
        `rota seria dejar entrar a un menor sin datos de tutor.`,
    );
  }

  const anio = Number(coincide[1]);
  const mes = Number(coincide[2]);
  const dia = Number(coincide[3]);
  const bisiesto = (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;
  const diasDelMes = mes === 2 && bisiesto ? 29 : DIAS_POR_MES[mes - 1];
  if (mes < 1 || mes > 12 || dia < 1 || diasDelMes === undefined || dia > diasDelMes) {
    throw new Error(
      `La ${nombre} '${texto}' no es una fecha que exista: '${texto}' tiene mes ${mes} y ` +
        `dia ${dia}, y el calendario no llega ahi. Un 30 de febrero o un mes 13 son datos ` +
        `manipulados o un error de tecleo, y en los dos casos lo que hace falta es ` +
        `preguntar de nuevo, no asumir que el jugador es mayor.`,
    );
  }

  return { anio, mes, dia };
}

/** `true` si `anio` es bisiesto por el calendario gregoriano. */
function esBisiesto(anio: number): boolean {
  return (anio % 4 === 0 && anio % 100 !== 0) || anio % 400 === 0;
}

/** Compara dos fechas del calendario. Negativo si `a` es anterior a `b`. */
function comparar(a: Fecha, b: Fecha): number {
  if (a.anio !== b.anio) return a.anio - b.anio;
  if (a.mes !== b.mes) return a.mes - b.mes;
  return a.dia - b.dia;
}

/**
 * El dia en que se cumple `edadMinima` anos dentro de `hoy`.
 *
 * El 29 de febrero se ajusta al 28 en los anos que no son bisiestos: es la convencion de
 * todos los sistemas de edad y afecta a UN dia al ano, en la fecha mas improbable que
 * existe para un cumpleaños. Se documenta en vez de dejarlo como sorpresa.
 */
function cumpleEl(hoy: Fecha, edadMinima: number): Fecha {
  const dia =
    hoy.mes === 2 && hoy.dia === 29 && !esBisiesto(hoy.anio - edadMinima) ? 28 : hoy.dia;
  return { anio: hoy.anio - edadMinima, mes: hoy.mes, dia };
}

/**
 * Decide si un jugador es MENOR que la edad minima del club, hoy.
 *
 * Es la unica fuente de `is_minor` en todo el servidor (T14c-C): el cliente puede mandar
 * lo que quiera en el cuerpo y esta funcion no lo ve.
 *
 * @throws Si la fecha de nacimiento o el "hoy" no son fechas que existan, si la fecha de
 *   nacimiento es FUTURA, o si `edadMinima` no es un entero dentro de 14..21. Se lanza en
 *   vez de devolver `false` porque el fallo de esta funcion es silencioso por construccion:
 *   un `false` aqui significa "adulto", es decir, "sin tutor", y ese error no se ve en
 *   ningun sitio hasta que un club tiene un problema.
 */
export function esMenorDeEdad(input: {
  readonly fechaNacimiento: string;
  readonly edadMinima: number;
  readonly hoy: string;
}): boolean {
  const { fechaNacimiento, edadMinima, hoy } = input;
  if (!Number.isInteger(edadMinima) || edadMinima < EDAD_MINIMA_ADMISIBLE || edadMinima > EDAD_MAXIMA_ADMISIBLE) {
    throw new Error(
      `El umbral de edad '${edadMinima}' no es valido: tiene que ser un entero entre ` +
        `${EDAD_MINIMA_ADMISIBLE} y ${EDAD_MAXIMA_ADMISIBLE}, que es lo que el ` +
        `\`check (min_player_age between 14 and 21)\` de \`tenants.min_player_age\` permite. ` +
        `Un umbral de 0 o null no es "sin restriction": es no comprobar la edad, que es ` +
        `el agujero que esta tarea cierra.`,
    );
  }

  const hoyEnFecha = aFecha(hoy, "fecha de referencia");
  const nacimiento = aFecha(fechaNacimiento, "fecha de nacimiento");
  if (comparar(nacimiento, hoyEnFecha) > 0) {
    throw new Error(
      `La fecha de nacimiento '${fechaNacimiento}' es FUTURA respecto a '${hoy}'. Nadie ` +
        `nace manana, y una fecha futura siempre sale de un cuerpo manipulado o de un reloj ` +
        `del club mal puesto.`,
    );
  }

  // Mayor o igual que el dia del cumpleanos es adulto: el limite es inclusivo.
  return comparar(nacimiento, cumpleEl(hoyEnFecha, edadMinima)) > 0;
}
