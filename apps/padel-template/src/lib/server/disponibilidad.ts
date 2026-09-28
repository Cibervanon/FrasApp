import { computeAvailability, resolvePrice } from "@frasapp/core";
import type {
  AvailabilityResult,
  AvailabilitySlot,
  CourtType,
  PriceLine,
  PricingRule,
  TimeRange,
} from "@frasapp/core";

import { tenantQuery } from "./db";

/**
 * La disponibilidad de una pista en un dia, compartida por los dos sitios que la usan:
 * `GET /api/availability` y las alternativas del 409 de `POST /api/holds`.
 *
 * Que esten en el MISMO fichero no es estetica. La spec 5.1 deja al gestor un contrato:
 * "el 409 trae los huecos que quedan", y si la ruta de availability y la ruta de holds
 * calcularan cada una los "ocupados" con su propio SQL, el dia que uno cambie y el otro no,
 * el 409 ofreceria horas que la pantalla de disponibilidad muestra como cogidas. Un solo
 * lugar para la pregunta "que ocupa esta pista este dia", dos consumidores.
 *
 * ---------------------------------------------------------------------------------------
 * QUE OCUPA UNA PISTA, DESDE T9
 *
 * Dos cosas, y las dos se restan:
 *
 *   - `court_blocks`: lo que el gestor cerro a mano (spec 4.2). Todo el dia si hace falta.
 *   - `bookings` en estado que TRABA la agenda: `held` (hold pendiente de confirmar),
 *     `pending_payment` y `confirmed`. `cancelled`, `completed`, `no_show` y `expired` no
 *     ocupan nada. Un hold CADUCADO (vivo en la tabla hasta que T11 lo expire por pereza)
 *     tampoco ocupa: de ahi el `hold_expires_at > now()`, que es la mitad de lectura del
 *     ciclo de vida de la spec 4.4.1.
 *
 * La parte de escritura de ese ciclo — expirar el hold sucio JUSTO ANTES de insertar el
 * siguiente — vive en `holds.ts`, en la misma transaccion. Aqui solo se filtran: no se
 * puede depender de que la limpieza ya haya pasado, porque con un solo `expire_stale_holds`
 * por minuto (pg_cron) y una consulta entre medias, un hold caducado podria seguir tapando
 * horas que deberian estar libres.
 *
 * ---------------------------------------------------------------------------------------
 * EL PRECIO, DESDE T12
 *
 * Cada hueco se enriquece con su precio ANTES de salir de aqui. Los dos consumidores
 * (la grilla publica y el 409 del hold) ven el mismo numero, resuelto con las reglas
 * REALES de la base y con `resolvePrice`. `playerMultiplier` usa `courts.num_players`
 * como factor por defecto de la rejilla: el precio que el socio ve al elegir es el que
 * COBRARIA un hold del mismo dia, y solo el hold (que conoce a la persona) afina con su
 * propio `numPlayers`. Advertido en `findings.md`.
 */

/** Lo que necesita una pista para calcular huecos y PRECIO. Es `Court` sin lo que sobra. */
export interface PistaConPrecio {
  readonly id: string;
  readonly name: string;
  readonly courtType: CourtType;
  readonly basePriceCents: number;
  readonly defaultDurationMin: number;
  readonly minDurationMin: number;
  readonly maxDurationMin: number;
  /** Jugadores por defecto (la rejilla cobra con estos; un hold afina con los suyos). */
  readonly numPlayers: number;
}

/**
 * Un hueco reservable con su precio ya resuelto. Extiende el `AvailabilitySlot` puro del
 * core: el motor de disponibilidad no sabe de precios (tipado del core, `types.ts`).
 */
export interface SlotConPrecio extends AvailabilitySlot {
  readonly priceCents: number;
  readonly priceBreakdown: readonly PriceLine[];
}

/**
 * Lo que `disponibilidadDePista` produce: la disponibilidad del core, con cada slot
 * enriquecido. `HuecosConPrecio` para no confundirlo con `AvailabilityResult`.
 */
export interface DisponibilidadConPrecio {
  readonly courtId: string;
  readonly date: string;
  readonly slots: readonly SlotConPrecio[];
}

/** La pista, sus huecos con precio y las reglas que se usaron. */
export interface DisponibilidadPista {
  readonly pista: PistaConPrecio;
  readonly huecos: DisponibilidadConPrecio;
  /** Las reglas de precio del tenant, tal cual fueron leidas. Para resolver el hold. */
  readonly reglas: PricingRule[];
}

/**
 * La pista, por id, con lo que hace falta para venderla. Lo que devuelve la RLS, y solo
 * eso.
 *
 * Sin `tenant_id` en el `where`: el aislamiento lo pone la politica. Una pista de otro
 * club esta en la MISMA tabla, asi que la fila no sale de la base y esta consulta no tiene
 * forma de devolverla. De ahi que un `court_id` ajeno acabe en 404 y no en 403.
 *
 * El `court_id` es `$1` porque `tenantQuery` NO antepone el tenant como parametro: abre la
 * transaccion y cambia el rol. (Ver el comentario del mismo titulo en la version anterior
 * de la ruta de availability, de la que esto sale.)
 */
const SQL_PISTA = `
select id, name, court_type, base_price_cents,
       default_duration_min, min_duration_min, max_duration_min,
       num_players
from public.courts
where id = $1
  and is_active
  and deleted_at is null
`;

/**
 * Las reglas de precio del tenant, en la forma EXACTA que espera `resolvePrice`.
 *
 * Tres conversiones en el `select`, las tres necesarias:
 *
 *   - `start_time` y `end_time` con `to_char(..., 'HH24:MI')`: la columna es `time` y
 *     node-pg la devolveria como `HH:MM:SS` con segundos, y el motor quiere `HH:MM`.
 *   - `valid_from` y `valid_to` con `to_char(..., 'YYYY-MM-DD')`: la columna es `date` y
 *     node-pg la devolveria como objeto `Date` (la forma depende de la zona del proceso),
 *     y el motor compara cadenas `YYYY-MM-DD`. `to_char(null, ...)` sigue siendo `null`,
 *     que es exactamente el "sin limite" que maneja `vivaEn`.
 *
 * `day_of_week` (int4[]) llega como numeros, que es lo que `resolvePrice` espera. Sin
 * `order by`: el motor COPIA y ordena la lista con sus propios criterios; el orden de la
 * base nunca debe decidir un empate (ver `porCriterio` en `pricing.ts`).
 */
const SQL_REGLA = `
select id, name, scope, court_type, court_id, day_of_week,
       to_char(start_time, 'HH24:MI') as start_time,
       to_char(end_time, 'HH24:MI') as end_time,
       duration_min, price_cents, player_multiplier,
       priority,
       to_char(valid_from, 'YYYY-MM-DD') as valid_from,
       to_char(valid_to, 'YYYY-MM-DD') as valid_to,
       is_active
from public.pricing_rules
`;

/**
 * Todo lo que ocupa la pista ese dia, recortado al dia y en hora de pared.
 *
 * El `cross join` con el CTE `dia` es lo que hace el trabajo: `inicio` y `fin` son los dos
 * extremos del dia EN LA ZONA DEL CLUB, ya convertidos a instante (los timestamps se
 * guardan en UTC; el club razona en hora local; la conversion la hace Postgres con
 * `at time zone`, como decidio el usuario el 2026-09-27). El filtro de solape y los dos
 * recortes comparan contra esos extremos.
 *
 * Dos fuentes, `court_blocks` y `bookings`, en un `union all`, porque las dos producen la
 * misma fila `(ini, fin)` y el `order by` del final garantiza lo que espera
 * `computeAvailability`: los rangos ordenados, con un indice que solo avanza.
 *
 * El recorte final a `dia.fin - interval '1 minute'` es deliberado: un bloque "de todo el
 * dia" acaba a las 00:00 del dia siguiente, que es exactamente el instante que el motor de
 * T5b rechaza. Restar un minuto no puede quitar ningun slot (la rejilla acaba a las 21:30
 * como muy tarde) y asegura que la fecha local de lo que sale sea la pedida.
 */
const SQL_OCUPADO = `
with dia as (
  select
    ($3::date::timestamp at time zone $2) as inicio,
    (($3::date::timestamp + interval '1 day') at time zone $2) as fin
),
ocupado as (
  select b.starts_at as ini, b.ends_at as fin
  from public.court_blocks b
  cross join dia
  where b.court_id = $1
    and b.starts_at < dia.fin
    and b.ends_at > dia.inicio
  union all
  select b.starts_at as ini, b.ends_at as fin
  from public.bookings b
  cross join dia
  where b.court_id = $1
    and b.status in ('held', 'pending_payment', 'confirmed')
    and (b.hold_expires_at is null or b.hold_expires_at > now())
    and b.starts_at < dia.fin
    and b.ends_at > dia.inicio
)
select
  to_char(greatest(o.ini, dia.inicio) at time zone $2, 'YYYY-MM-DD"T"HH24:MI') as starts_at,
  to_char(least(o.fin, dia.fin - interval '1 minute') at time zone $2, 'YYYY-MM-DD"T"HH24:MI')
    as ends_at
from ocupado o
cross join dia
order by o.ini, o.fin
`;

interface PistaFila {
  readonly id: string;
  readonly name: string;
  readonly court_type: CourtType;
  readonly base_price_cents: number;
  readonly default_duration_min: number;
  readonly min_duration_min: number;
  readonly max_duration_min: number;
  readonly num_players: number;
}

interface OcupadaFila {
  readonly starts_at: string;
  readonly ends_at: string;
}

/** Fila cruda de `pricing_rules`, tal y como sale de `SQL_REGLA`. */
interface ReglaFila {
  readonly id: string;
  readonly name: string;
  readonly scope: string;
  readonly court_type: string | null;
  readonly court_id: string | null;
  readonly day_of_week: number[];
  readonly start_time: string;
  readonly end_time: string;
  readonly duration_min: number;
  readonly price_cents: number;
  readonly player_multiplier: boolean;
  readonly priority: number;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly is_active: boolean;
}

/** `SQL_REGLA` ya convirtio las horas y las fechas; aqui solo se afinan los tipos. */
function filaARegla(fila: ReglaFila): PricingRule {
  return {
    id: fila.id,
    name: fila.name,
    scope: fila.scope as PricingRule["scope"],
    courtType: fila.court_type as CourtType | null,
    courtId: fila.court_id,
    dayOfWeek: fila.day_of_week,
    startTime: fila.start_time,
    endTime: fila.end_time,
    durationMin: fila.duration_min,
    priceCents: fila.price_cents,
    playerMultiplier: fila.player_multiplier,
    priority: fila.priority,
    validFrom: fila.valid_from,
    validTo: fila.valid_to,
    isActive: fila.is_active,
  };
}

/**
 * Los huecos libres de una pista en un dia, o `null` si esa pista no existe aqui.
 *
 * `null` combina "no existe" y "es de otro club" a proposito: distinguirlos confirmaria a
 * quien recorre uuids que las pistas del vecino existen, que es informacion de un tercero.
 * Por eso la ruta responde el MISMO 404 en los dos casos.
 */
export async function disponibilidadDePista(
  tenantId: string,
  timezone: string,
  courtId: string,
  fecha: string,
): Promise<DisponibilidadPista | null> {
  const pistas = await tenantQuery<PistaFila>(tenantId, SQL_PISTA, [courtId]);
  const pista = pistas[0];
  if (pista === undefined) {
    return null;
  }

  const [filas, filasRegla] = await Promise.all([
    tenantQuery<OcupadaFila>(tenantId, SQL_OCUPADO, [courtId, timezone, fecha]),
    tenantQuery<ReglaFila>(tenantId, SQL_REGLA),
  ]);
  const reglas = filasRegla.map(filaARegla);
  const busy: TimeRange[] = filas.map((fila) => ({
    startsAt: fila.starts_at,
    endsAt: fila.ends_at,
  }));

  const huecos: AvailabilityResult = computeAvailability({
    court: {
      id: pista.id,
      name: pista.name,
      defaultDurationMin: pista.default_duration_min,
      minDurationMin: pista.min_duration_min,
      maxDurationMin: pista.max_duration_min,
    },
    date: fecha,
    busy,
  });

  // El precio de la rejilla se resuelve con los jugadores por DEFECTO de la pista: es el
  // numero que ve quien aun no se ha identificado. El hold (que conoce a la persona) lo
  // recalcula con sus jugadores, y por eso `reglas` viaja en el paquete.
  const slots: SlotConPrecio[] = huecos.slots.map((slot) => {
    const quote = resolvePrice({
      court: {
        id: pista.id,
        courtType: pista.court_type,
        basePriceCents: pista.base_price_cents,
      },
      rules: reglas,
      startsAt: slot.startsAt,
      durationMin: pista.default_duration_min,
      numPlayers: pista.num_players,
    });
    return {
      ...slot,
      priceCents: quote.totalCents,
      priceBreakdown: quote.breakdown,
    };
  });

  return {
    pista: {
      id: pista.id,
      name: pista.name,
      courtType: pista.court_type,
      basePriceCents: pista.base_price_cents,
      defaultDurationMin: pista.default_duration_min,
      minDurationMin: pista.min_duration_min,
      maxDurationMin: pista.max_duration_min,
      numPlayers: pista.num_players,
    },
    huecos: {
      courtId: huecos.courtId,
      date: huecos.date,
      slots,
    },
    reglas,
  };
}