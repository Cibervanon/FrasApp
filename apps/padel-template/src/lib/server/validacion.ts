/**
 * Validaciones de formato compartidas por las rutas del servidor.
 *
 * Las tres rutas (availability, holds, y la sesion que las autentica) comparten dos
 * preguntas: "esto es un uuid" y "esto es una fecha de pared del club". Con una sola copia
 * no hay ninguna decision de versiones que tomar: la disponibilidad, el hold y la sesion
 * aceptan exactamente los mismos formatos.
 *
 * PURA y SIN DEPENDENCIAS: solo regex y aritmetica de calendario, para que una ruta con
 * un `sub` mal formado devuelva 401 sin abrir ni una conexion.
 */

/** Un uuid, en cualquier caja. Postgres lo aceptaria en minuscula o mayuscula. */
export const FORMATO_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `YYYY-MM-DD`, y solo eso. Un formato mas laxo deja que "2026-3-2" sea un dia. */
export const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `YYYY-MM-DDTHH:MM` en hora de pared del club: sin segundos ni offset.
 *
 * Un `T10:00Z` de un club de Madrid en verano son sus 12:00. Los slots de disponibilidad
 * se devuelven en hora de pared (decision de T5d), y un hold que llegue con offset haria
 * que el precio (motor T7, que rechaza offsets) y el slot no casaran con nada.
 */
export const FORMATO_INSTANTE_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/** `YYYY-MM-DD` que ademas existe en el calendario. */
export function esFechaReal(fecha: string): boolean {
  const partes = /^(\d{4})-(\d{2})-(\d{2})$/.exec(fecha);
  if (partes === null) return false;
  const anio = Number(partes[1]);
  const mes = Number(partes[2]);
  const dia = Number(partes[3]);
  // El calendario gregoriano no tiene meses 0 ni 13, y el dia depende del mes. El `Date` se
  // construye en UTC a proposito: con la hora local, un servidor en una zona negativa puede
  // leer el dia anterior y declarar valida una fecha que no lo es.
  const fechaUtc = new Date(Date.UTC(anio, mes - 1, dia));
  return (
    fechaUtc.getUTCFullYear() === anio &&
    fechaUtc.getUTCMonth() === mes - 1 &&
    fechaUtc.getUTCDate() === dia
  );
}

/**
 * Un instante local de club con fecha y reloj que existen.
 *
 * `FORMATO_INSTANTE_LOCAL` acepta `99:99`; aqui se comprueba que las 99 no son una hora.
 * La 24:00 NO se acepta: es un instante VALIDO para describir el cierre de un dia (el motor
 * de precios la acepta), pero ningun slot empieza a las 24:00, y aceptarla aqui dejaria que
 * un hold pidiera un hueco que la rejilla nunca ofrece.
 */
export function esInstanteLocal(instante: string): boolean {
  const partes = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(instante);
  if (partes === null) return false;
  if (!esFechaReal(`${partes[1]}-${partes[2]}-${partes[3]}`)) return false;
  return Number(partes[4]) <= 23 && Number(partes[5]) <= 59;
}