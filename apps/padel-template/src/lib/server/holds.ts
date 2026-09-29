import { esMenorDeEdad, resolvePrice } from "@frasapp/core";
import type { BookingStatus, PriceLine } from "@frasapp/core";

import { baseQuery, tenantSession } from "./db";
import { disponibilidadDePista } from "./disponibilidad";
import type { DisponibilidadConPrecio } from "./disponibilidad";

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
  /**
   * `YYYY-MM-DD`, OBLIGATORIA (T14c-B).
   *
   * Antes era opcional y el club decidia con una casilla. Con la fecha ausente, un menor de
   * 15 puede saltarse el consentimiento del tutor simplementemente no mandandola, y el
   * campo `is_minor` acaba en `false`: el caso que el RGPD de menores prohibe.
   */
  readonly playerBirthDate: string;
  /**
   * Los datos del tutor, y SOLO si el servidor ha determinado que el jugador es menor.
   *
   * Que sea opcional en el tipo no es una puerta: `crearHold` exige los tres campos cuando
   * el jugador es menor, y los rechaza con `tutor_no_requerido` cuando es mayor. El tipo lo
   * que hace es dejar que la RUTA lo escriba sin distinguir, que es donde de verdad se valida
   * la forma.
   */
  readonly tutor?: Tutor;
}

/** El tutor que consiente, tal y como lo manda el cuerpo. La forma la mira la ruta. */
export interface Tutor {
  readonly guardianName: string;
  readonly guardianEmail: string;
  readonly guardianPhone: string;
  readonly guardianRelation: "madre" | "padre" | "tutor_legal" | "otro";
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
  /**
   * Lo que el SERVIDOR dedujo de la fecha y del umbral del club, no lo que pidio el cuerpo.
   * La interfaz de la UI (T18a) lo usa para preguntar por el tutor, y no al reves.
   */
  readonly isMinor: boolean;
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
  | { readonly tipo: "conflicto"; readonly alternativas: DisponibilidadConPrecio }
  /**
   * El servidor ha dicho que el jugador es menor y el cuerpo no trae los tres datos del
   * tutor. 422 y NO 400: el cuerpo esta bien formado, lo que falta es informacion que el
   * socio tiene que dar. Y se responde ANTES de escribir, asi que no queda un hold sin tutor.
   */
  | { readonly tipo: "faltan_datos_tutor" }
  /**
   * El cuerpo trae tutor y el servidor ha dicho que el jugador es mayor. 400, y no "se ignora
   * el tutor": si el club y el socio no coinciden en la edad, el que se equivoca es el club y
   * el motivo se ve mejor en un 400 que en un hold guardado con datos de tutor que nadie
   * pidio.
   */
  | { readonly tipo: "tutor_no_requerido" }
  /**
   * Fecha de nacimiento que no existe en el calendario, o de futuro. 400: es del cuerpo, y la
   * ruta lo dice sin adivinar cual de las dos cosas fue.
   */
  | { readonly tipo: "fecha_invalida" };

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

  // -------------------------------------------------------------------------------------
  // LA EDAD, ANTES DE NADA. Y ANTES DEL PRECIO.
  //
  // El orden importa por dos razones. La primera, que el club no tiene por que saber el
  // precio de nada para decirte que te falta el tutor. La segunda, y la que de verdad obliga
  // a que este bloque este aqui y no despues del `insert`: un menor sin tutor no debe dejar
  // NINGUNA fila, ni un hold que caduque luego, ni un hueco tapado tres minutos. Si este
  // codigo se moviera debajo del `insert`, un 422 tardio tendria que borrar lo que ya se
  // escribio, y borrar es mas caro de acertar que no escribir.
  //
  // Que el SERVIDOR decida y no el cuerpo es la decision T14c-C: un `isMinor: false` en el
  // JSON era una casilla de "no soy menor" que el propio menor marcaba.
  const edad = await edadDelClub(tenantId, timezone);
  if (!Number.isInteger(edad.umbral) || edad.umbral < 14 || edad.umbral > 21) {
    // La columna tiene un CHECK de 14 a 21, asi que llegar aqui es una fila corrupta o una
    // migracion que no se aplico. Se lanza en vez de devolver 400: si el umbral del club no
    // es valido, un 400 haria creer al socio que su fecha esta mal, y el menor pasaria sin
    // tutor. Aqui lo correcto es un 500 que alguien mire la fila.
    throw new Error(
      `El tenant ${tenantId} tiene min_player_age = ${String(edad.umbral)}, fuera del ` +
        `rango 14..21 que fija la migracion.`,
    );
  }

  let esMenor: boolean;
  try {
    esMenor = esMenorDeEdad({
      fechaNacimiento: input.playerBirthDate,
      edadMinima: edad.umbral,
      hoy: edad.hoy,
    });
  } catch (error: unknown) {
    // Con el umbral ya validado, lo unico que puede fallar aqui es la FECHA. Se devuelve el
    // 400 en vez de relanzar: la ruta traduria cualquier error a 500, y un 500 por una fecha
    // con dia 30 de febrero es una respuesta que no ayuda a nadie a arreglarlo.
    if (error instanceof Error) return { tipo: "fecha_invalida" };
    throw error;
  }

  if (esMenor) {
    const tutor = input.tutor;
    if (
      tutor === undefined ||
      esVacio(tutor.guardianName) ||
      esVacio(tutor.guardianEmail) ||
      esVacio(tutor.guardianPhone)
    ) {
      return { tipo: "faltan_datos_tutor" };
    }
  } else if (input.tutor !== undefined) {
    return { tipo: "tutor_no_requerido" };
  }

  // El chequeo ANTES de escribir, con la pista y sus huecos. Sirve para el 404 (la pista
  // no existe o es de otro club), para el precio (viene de la pista) y para el 409 barato:
  // el 99% de los conflictos se ven aqui, sin tocar una transaccion de escritura.
  const disponible = await disponibilidadDePista(tenantId, timezone, input.courtId, fecha);
  if (disponible === null) {
    return { tipo: "sin_pista" };
  }
  const { pista, huecos, reglas } = disponible;

  const huecoLibre = huecos.slots.some((slot) => slot.startsAt === input.startsAt);
  if (!huecoLibre) {
    return { tipo: "conflicto", alternativas: huecos };
  }

  // El precio es SNAPSHOT y se resuelve ANTES del insert, con las reglas REALES del club
  // (`disponibilidadDePista` las leyo ya, con la misma RLS). El socio pidio un slot que la
  // grilla tenia a un precio; aqui se recalcula con SU numero de jugadores por si una
  // tarifa es `player_multiplier`. El cliente nunca manda un importe.
  const quote = resolvePrice({
    court: {
      id: pista.id,
      courtType: pista.courtType,
      basePriceCents: pista.basePriceCents,
    },
    rules: reglas,
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
        esMenor,
        input.playerBirthDate,
        input.tutor?.guardianName ?? null,
        input.tutor?.guardianEmail ?? null,
        input.tutor?.guardianPhone ?? null,
        input.tutor?.guardianRelation ?? null,
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
  readonly is_minor: boolean;
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
    isMinor: fila.is_minor,
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

/**
 * Lo que hay que saber del club para decidir si este jugador es menor: SU umbral y SU dia.
 *
 * ---------------------------------------------------------------------------------------
 * `now() at time zone $2` Y NO `now()::date`
 *
 * `now()::date` es el dia de UTC. A las 00:30 de la madrugada en Mallorca, en UTC todavia es
 * el dia de ayer, y un socio que cumple 18 anos HOY seria tratado como menor: le pedirian
 * un tutor que no necesita. Al reves, en un club de Oceania un socio de 18 seria tratado
 * como menor un dia entero de mas. El dia que decide la edad es el dia que ve el club, y la
 * zona que lo define esta en su propia fila.
 *
 * `to_char(..., 'YYYY-MM-DD')` y no `::text`: el texto de un `date` en Postgres depende de
 * `DateStyle`, que es un ajuste de sesion, y un servidor con `DateStyle = 'Postgres, DMY'`
 * devolveria `30-12-2015`. La funcion pura de `core` no deberia tener que defenderse de eso.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE `baseQuery` Y NO LA DEL TENANT, Y POR QUE SIN CACHE
 *
 * `public.tenants` no tiene RLS: es la unica tabla sin, y `resolveTenant` lo documenta
 * (`tenant.ts`). Entrar por la conexion del tenant no aislaria nada aqui, asi que se lee con
 * `baseQuery` y `where id = $1`, que es el mismo aislamiento por identificador unico que usa
 * el propio `resolveTenant` con su `slug`. El `tenantId` no viene del cuerpo: lo resuelve la
 * ruta con `resolveTenant`.
 *
 * Y NO SE MEMORIZA, a diferencia de `resolveTenant`. Ahi el cache es de properties de
 * despliegue (zona, nombre, idioma) y cambiar de club es una alta en caliente. El umbral NO
 * es eso: lo edita el gestor desde el panel (T18e), y un umbral cacheado seria un menor
 * prevenido con la regla de ayer. Una consulta indexada por la clave primaria es lo que
 * cuesta leerlo bien.
 */
async function edadDelClub(tenantId: string, timezone: string): Promise<EdadDelClub> {
  const filas = await baseQuery<{ min_player_age: number; hoy: string }>(
    `select min_player_age, to_char(now() at time zone $2, 'YYYY-MM-DD') as hoy
       from public.tenants
      where id = $1`,
    [tenantId, timezone],
  );
  const fila = filas[0];
  if (fila === undefined) {
    // No puede pasar por el camino normal (la ruta acaba de resolver el tenant), asi que si
    // pasa es que la fila se borro entre medias. Se dice claro, en vez de devolver un
    // umbral por defecto que haria minors a todo el mundo sin avisar.
    throw new Error(
      `El tenant ${tenantId} no existe al pedir la edad del jugador. Si la ruta acaba de ` +
        `resolverlo, alguien borro el club a mitad de la peticion.`,
    );
  }
  return { umbral: fila.min_player_age, hoy: fila.hoy };
}

/** El umbral del club y su dia de hoy, que es lo unico que hace falta para la edad. */
interface EdadDelClub {
  /** `tenants.min_player_age`. Lo valida `crearHold`, no esta funcion. */
  readonly umbral: number;
  /** `YYYY-MM-DD` en la zona del club. Nunca la fecha de UTC. */
  readonly hoy: string;
}

/** Un texto que no es un dato: vacio o solo espacios. */
function esVacio(texto: string): boolean {
  return texto.trim() === "";
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
 *
 * Las columnas de menor (T14c) van con el `case`: `guardian_consent_at` es `now()` de la
 * BASE cuando el jugador es menor, y `null` cuando no lo es. La fecha del consentimiento no
 * viaja en el `insert` porque no viene del cuerpo: si el reloj del consentidor fuera el del
 * navegador, un reloj mal puesto fecharia el RGPD de un menor en 1970.
 */
const SQL_CREAR_HOLD = `
insert into public.bookings
  (tenant_id, court_id, user_id,
   starts_at, ends_at, status, hold_expires_at,
   price_cents, price_breakdown, currency, num_players, player_name,
   is_minor, player_birth_date,
   guardian_name, guardian_email, guardian_phone, guardian_relation, guardian_consent_at)
values
  ($1::uuid, $2::uuid, $3::uuid,
   ($4::timestamp at time zone $5),
   (($4::timestamp at time zone $5) + make_interval(mins => $6)),
   'held',
   now() + interval '3 minutes',
   $7, $8::jsonb, 'eur', $9, $10,
   $11::boolean, $12::date,
   $13, $14, $15, $16,
   case when $11::boolean then now() end)
returning
  id,
  to_char(starts_at at time zone $5, 'YYYY-MM-DD"T"HH24:MI') as starts_at,
  to_char(ends_at at time zone $5, 'YYYY-MM-DD"T"HH24:MI') as ends_at,
  to_char(hold_expires_at at time zone $5, 'YYYY-MM-DD"T"HH24:MI:SS') as hold_expires_at,
  price_cents,
  price_breakdown,
  is_minor
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