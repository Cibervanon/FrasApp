import { resolvePrice } from "@frasapp/core";
import type { AvailabilityResult, BookingStatus, PriceLine } from "@frasapp/core";

import { tenantSession } from "./db";
import { disponibilidadDePista } from "./disponibilidad";

/**
 * Crear y liberar holds: la cara de ESCRITURA del ciclo de vida de la spec 4.4.1.
 *
 * ---------------------------------------------------------------------------------------
 * EL CICLO, EN TRES PIEZAS, PARA QUE NO HAYA UNA SOLA
 *
 *  1. Lectura: `disponibilidad.ts` filtra `hold_expires_at > now()`. Un hold caducado no
 *     ocupa la pantalla del socio, aunque la fila siga ahi.
 *  2. Escritura (este fichero): antes del INSERT, en la MISMA transaccion, se llama a
 *     `expire_stale_holds(tenant, court)`. Un hold caducado en esta pista se expira anTES
 *     de que el `EXCLUDE` de `bookings` decida si el hueco es libre.
 *  3. Red de seguridad: el cron de cada minuto de la migracion 003, para los holds que
 *     nadie volvio a tocar.
 *
 * POR QUE LA LIMPIEZA EN LA MISMA TRANSACCION Y NO EN UN CTE
 * Un CTE con `update`+`insert` modificadores se ejecuta con un UNICO snapshot y los datos
 * que el `update` cambia NO son visibles para el `insert` (lo documenta Postgres: las
 * sub-sentencias que modifican datos no ven sus efectos en las tablas objetivo). Dos
 * sentencias SEPARADAS en la misma transaccion, en Read Committed, si se ven. Por eso esto
 * no es un `INSERT ... WITH` de una linea: es un `tenantSession` con dos sentencias, que
 * es exactamente el caso para el que existe (ver `db.ts`).
 *
 * ---------------------------------------------------------------------------------------
 * QUIEN PUEDE CREAR UN HOLD, Y QUE "PUEDE" SIGNIFICA AQUI
 *
 * `crearHold` exige un `sub` (uuid de sesion) y lo guarda como `user_id`. La FK a
 * `auth.users` es la verificacion de que ese uuid existe como persona: si no, el INSERT
 * falla con `23503` y 401. La cookie que transporta el `sub` NO esta firmada todavia
 * (decision pendiente de T11, ver `session.ts`): mientras tanto el `sub` solo atribuye, no
 * autoriza. Este fichero es el que hace valer que dentro de la transaccion de escritura
 * SIEMPRE hay identidad: `tenantSession` lo exige en la firma.
 */

/** Lo que pide un socio para crear un hold. Sin el precio: eso lo calcula el servidor. */
export interface CrearHoldInput {
  readonly courtId: string;
  /** `YYYY-MM-DDTHH:MM`, hora de pared del club. Sin offset. */
  readonly startsAt: string;
  readonly numPlayers: number;
  readonly playerName: string;
}

/** Un hold creado, con todo lo que la respuesta necesita para pintarlo. */
export interface HoldCreado {
  readonly id: string;
  readonly status: "held";
  readonly courtId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly holdExpiresAt: string;
  readonly priceCents: number;
  readonly priceBreakdown: readonly PriceLine[];
}

/** Un hold liberado por su titular: la reserva queda cancelada y el hueco, libre. */
export interface HoldLiberado {
  readonly id: string;
  readonly status: "cancelled";
  readonly courtId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly cancelledAt: string;
}

/** Lo que puede salir de `crearHold`. El 409 y el 404 se construyen desde aqui. */
export type CrearHoldResultado =
  | { readonly tipo: "creado"; readonly hold: HoldCreado }
  | { readonly tipo: "sin_pista" }
  | { readonly tipo: "sin_usuario" }
  | { readonly tipo: "conflicto"; readonly alternativas: AvailabilityResult };

/** Lo que puede salir de `liberarHold`. La ruta traduce cada caso a un status. */
export type LiberarHoldResultado =
  | { readonly tipo: "liberado"; readonly hold: HoldLiberado }
  | { readonly tipo: "sin_hold" }
  | { readonly tipo: "transicion_invalida" };

/**
 * El hold azucarado de 3 minutos (spec 4.4.1): se expira lo sucio y se inserta lo nuevo,
 * en la misma transaccion.
 *
 * @throws si la base falla por algo que no es el solape (`23P01`) ni la persona inexistente
 *   (`23503`). La ruta deja pasar el resto como 500: que la base este rota no es algo que
 *   el socio tenga que adivinar.
 */
export async function crearHold(
  tenantId: string,
  timezone: string,
  sub: string,
  input: CrearHoldInput,
): Promise<CrearHoldResultado> {
  const fecha = input.startsAt.slice(0, 10);

  // El chequeo ANTES de escribir, con la pista y sus huecos. Sirve para el 404 (la pista
  // no existe o es de otro club), para el precio (viene de la pista) y para el 409 barato:
  // el 99% de los conflictos se ven aqui, sin tocar una transaccion de escritura.
  const disponible = await disponibilidadDePista(tenantId, timezone, input.courtId, fecha);
  if (disponible === null) {
    return { tipo: "sin_pista" };
  }
  const { pista, huecos } = disponible;

  const huecoLibre = huecos.slots.some((slot) => slot.startsAt === input.startsAt);
  if (!huecoLibre) {
    return { tipo: "conflicto", alternativas: huecos };
  }

  // El precio es SNAPSHOT y se resuelve ANTES del insert. Sin reglas hasta T12, asi que
  // `rules: []` cae a `courts.base_price_cents`: el desglose sera la tarifa base, que es
  // exactamente lo que el club cobra ahora. El cliente nunca manda un importe.
  const quote = resolvePrice({
    court: {
      id: pista.id,
      courtType: pista.courtType,
      basePriceCents: pista.basePriceCents,
    },
    rules: [],
    startsAt: input.startsAt,
    durationMin: pista.defaultDurationMin,
    numPlayers: input.numPlayers,
  });

  try {
    const hold = await tenantSession(tenantId, sub, async (db) => {
      // Pieza 2 del ciclo de vida, antes del insert y en ESTA transaccion: los holds
      // caducados de esta pista pasan a 'expired' para que el EXCLUDE decida con la
      // tabla limpia.
      await db.query(`select public.expire_stale_holds($1::uuid, $2::uuid)`, [
        tenantId,
        input.courtId,
      ]);

      const filas = await db.query<HoldFila>(SQL_CREAR_HOLD, [
        tenantId,
        input.courtId,
        sub,
        input.startsAt,
        timezone,
        pista.defaultDurationMin,
        quote.totalCents,
        JSON.stringify(quote.breakdown),
        input.numPlayers,
        input.playerName,
      ]);
      const fila = filas.rows[0];
      if (fila === undefined) {
        throw new Error("El insert del hold no devolvio fila, y un returning siempre devuelve.");
      }
      return aHoldCreado(fila, pista.id);
    });
    return { tipo: "creado", hold };
  } catch (error: unknown) {
    // La carrera: entre el chequeo de arriba y este insert, otra pestaña / otro socio se
    // llevo el hueco. El EXCLUDE lo ha dicho con 23P01. Se recomputan los huecos AHORA,
    // que ya reflejan el hold ganador, y esos son las alternativas del 409.
    if (esViolacionDeExclusion(error)) {
      const actual = await disponibilidadDePista(tenantId, timezone, input.courtId, fecha);
      return { tipo: "conflicto", alternativas: actual?.huecos ?? huecos };
    }
    // Un uuid de sesion sin persona en `auth.users`: la FK no deja crear el hold.
    if (esUsuarioInexistente(error)) {
      return { tipo: "sin_usuario" };
    }
    throw error;
  }
}

/**
 * Libera un hold propio: lo borra de la agenda pasandolo a `cancelled`.
 *
 * El 404 — inexistente, de otro club y AJENO — llega aqui YA mezclado en `sin_hold`, y la
 * ruta responde el mismo cuerpo para los tres. De otro club ni siquiera llega: la RLS de
 * `bookings` no devuelve filas de otros tenants, porque esta consulta corre por el rol del
 * tenant resuelto.
 */
export async function liberarHold(
  tenantId: string,
  timezone: string,
  sub: string,
  holdId: string,
): Promise<LiberarHoldResultado> {
  return tenantSession(tenantId, sub, async (db) => {
    const filas = await db.query<HoldReservaFila>(SQL_BUSCAR_HOLD, [holdId]);
    const fila = filas.rows[0];
    if (fila === undefined) {
      return { tipo: "sin_hold" };
    }
    // El hold existe y es de MI club; si el titular es otro, es como si no existiera.
    // Decide el 404 sin decir nada de quien es realmente el hold.
    if (fila.user_id !== sub) {
      return { tipo: "sin_hold" };
    }
    // Un hold que ya no es 'held' salio del estado cancelable. Confirmado, pagado,
    // caducado o ya cancelado: nadie puede tirarlo con este endpoint.
    if (fila.status !== "held") {
      return { tipo: "transicion_invalida" };
    }

    const liberadas = await db.query<HoldLiberadoFila>(SQL_LIBERAR_HOLD, [
      holdId,
      sub,
      timezone,
    ]);
    const filaLiberada = liberadas.rows[0];
    if (filaLiberada === undefined) {
      // El `where status = 'held'` no encontro fila: alguien movio el hold entre el
      // select y el update, en la misma transaccion es imposible, pero no se empieza a
      // inventar un caso que el EXCLUDE ya cubre. Firme: no se libero.
      return { tipo: "transicion_invalida" };
    }
    return { tipo: "liberado", hold: aHoldLiberado(filaLiberada) };
  });
}

interface HoldFila {
  readonly id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly hold_expires_at: string;
  readonly price_cents: number;
  readonly price_breakdown: unknown;
}

interface HoldReservaFila {
  readonly id: string;
  readonly court_id: string;
  readonly user_id: string;
  readonly status: BookingStatus;
}

interface HoldLiberadoFila {
  readonly id: string;
  readonly court_id: string;
  readonly starts_at: string;
  readonly ends_at: string;
  readonly cancelled_at: string;
}

function aHoldCreado(fila: HoldFila, courtId: string): HoldCreado {
  return {
    id: fila.id,
    status: "held",
    courtId,
    startsAt: fila.starts_at,
    endsAt: fila.ends_at,
    holdExpiresAt: fila.hold_expires_at,
    priceCents: fila.price_cents,
    priceBreakdown: fila.price_breakdown as readonly PriceLine[],
  };
}

function aHoldLiberado(fila: HoldLiberadoFila): HoldLiberado {
  return {
    id: fila.id,
    status: "cancelled",
    courtId: fila.court_id,
    startsAt: fila.starts_at,
    endsAt: fila.ends_at,
    cancelledAt: fila.cancelled_at,
  };
}

interface ErrorDeBase {
  readonly code?: string;
  readonly constraint?: string;
}

function esErrorDeBase(error: unknown): error is ErrorDeBase {
  return typeof error === "object" && error !== null;
}

/** El EXCLUDE compuesto de la tabla: alguien se llevo este hueco. */
function esViolacionDeExclusion(error: unknown): boolean {
  return esErrorDeBase(error) && error.code === "23P01" && error.constraint === "bookings_no_overlap";
}

/** La FK de `user_id`: el `sub` no corresponde a ninguna persona de `auth.users`. */
function esUsuarioInexistente(error: unknown): boolean {
  return esErrorDeBase(error) && error.code === "23503" && error.constraint === "bookings_user_id_fkey";
}

/**
 * Crea el hold en una sola sentencia: expira, inserta y devuelve en hora de pared.
 *
 * `now() + interval '3 minutes'` es el hold de la spec, "3 minutos exactos": media hora a
 * la hora de punta no es un hold, es una reserva.
 *
 * `$4::timestamp at time zone $5` es la conversion DECIDIDA con el usuario el 2026-09-27:
 * el `starts_at` viaja como hora de pared del club (`$4`, un `timestamp` sin zona) y Postgres
 * lo convierte a instante con la zona del club (`$5`). Al devolver, `at time zone $5` en el
 * otro sentido, para que la respuesta sea la misma hora que pidio el socio.
 */
const SQL_CREAR_HOLD = `
insert into public.bookings
  (tenant_id, court_id, user_id,
   starts_at, ends_at, status, hold_expires_at,
   price_cents, price_breakdown, currency, num_players, player_name, is_minor)
values
  ($1::uuid, $2::uuid, $3::uuid,
   ($4::timestamp at time zone $5),
   (($4::timestamp at time zone $5) + make_interval(mins => $6)),
   'held',
   now() + interval '3 minutes',
   $7, $8::jsonb, 'eur', $9, $10, false)
returning
  id,
  to_char(starts_at at time zone $5, 'YYYY-MM-DD"T"HH24:MI') as starts_at,
  to_char(ends_at at time zone $5, 'YYYY-MM-DD"T"HH24:MI') as ends_at,
  to_char(hold_expires_at at time zone $5, 'YYYY-MM-DD"T"HH24:MI:SS') as hold_expires_at,
  price_cents,
  price_breakdown
`;

/**
 * La fila antes de tocarla, dentro de la transaccion que la tocara.
 *
 * Sin `user_id = $sub` en el `where`: el SELECT y el UPDATE van en la misma transaccion,
 * y la comparacion de titularidad se hace aqui en codigo, con LO QUE VERA el UPDATE. Que
 * esten en la misma transaccion es lo que hace que el 404 ajeno no sea una carrera.
 */
const SQL_BUSCAR_HOLD = `
select id, court_id, user_id, status
from public.bookings
where id = $1
`;

/**
 * Cancela y libera. `status = 'held'` en el `where` es la ultima palabra, y
 * `cancelled_at = now()` deja la traza de cuando se libero.
 */
const SQL_LIBERAR_HOLD = `
update public.bookings
   set status = 'cancelled', cancelled_at = now()
 where id = $1
   and user_id = $2
   and status = 'held'
returning
  id,
  court_id,
  to_char(starts_at at time zone $3, 'YYYY-MM-DD"T"HH24:MI') as starts_at,
  to_char(ends_at at time zone $3, 'YYYY-MM-DD"T"HH24:MI') as ends_at,
  to_char(cancelled_at at time zone $3, 'YYYY-MM-DD"T"HH24:MI:SS') as cancelled_at
`;