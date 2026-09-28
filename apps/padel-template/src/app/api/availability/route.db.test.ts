import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolvePrice } from "@frasapp/core";
import type { CourtType, PriceLine, PricingRule } from "@frasapp/core";

import { GET } from "./route";
import { closePool } from "../../../lib/server/db";
import { clearTenantCache } from "../../../lib/server/tenant";
import {
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
} from "../../../test/db-harness";

/**
 * T5d: `GET /api/availability?court_id&date`.
 *
 * El endpoint donde la zona horaria deja de ser un detalle. Las filas de `court_blocks` son
 * `timestamptz` y la ventana de 8:00 a 22:00 es hora de pared del club, asi que casi todos
 * los tests de aqui son, sin decirlo, tests de `at time zone`.
 *
 * ---------------------------------------------------------------------------------------
 * TENANTS PROPIOS, POR EL MISMO MOTIVO QUE EN T5c
 *
 * Los fixtures de T4 se siembran con `withAdmin` y no se borran nunca, y `club-padel-demo`
 * tiene bloques de la seed. Un `toEqual` sobre la disponibilidad de cualquiera de ellos
 * depende de lo que otro test dejo antes. Este fichero crea los suyos y los destruye.
 *
 * Se necesitan dos porque el 404 cross-tenant necesita una pista que sea de otro club, y esa
 * fila tiene que existir de verdad: un uuid inventado daria el mismo 404 y el test pasaria
 * sin haber probado nada. La diferencia entre "no existe" y "es de otro" se comprueba con la
 * cita anterior, no con el status.
 */

/** Tenant con pistas. */
const TENANT_A = "00000000-0000-4000-8000-0000000005e0";
const SLUG_A = "club-t5d-a";

/** Tenant con una pista propia, para el 404 cross-tenant. */
const TENANT_B = "00000000-0000-4000-8000-0000000005e1";
const SLUG_B = "club-t5d-b";

/** Pista de A. 90 min por defecto, que es lo que da 9 slots en una ventana de 14 h. */
const PISTA_A = "00000000-0000-4000-8000-0000000005e2";
/** Pista de B. No debe salir nunca en una respuesta de A. */
const PISTA_B = "00000000-0000-4000-8000-0000000005e3";

const MIS_FICTS = [PISTA_A, PISTA_B];

/**
 * Un socio en `auth.users`, para las reservas del overlay de T11. La FK de bookings exige
 * que el `user_id` exista, igual que en el POST de holds.
 */
const USUARIO_A = "00000000-0000-4000-8000-0000000005e4";

/**
 * Zonas horarias de los tenants de este fichero.
 *
 * Europe/Madrid es la que usa el club de verdad y la que cambia de hora. America/Mexico_City
 * esta a 6 horas de UTC todo el ano desde 2022, asi que si el codigo calculase el desfase con
 * una constante en vez de leer la zona del tenant, este tenant daria horas completamente
 * equivocadas y no habria forma de que el error pasara desapercibido: las 08:00 locales
 * serian las 02:00, o las 14:00, segun que constante se cogiera.
 */
const ZONA_A = "Europe/Madrid";
const ZONA_B = "America/Mexico_City";

/** Cuerpo de la respuesta, tipado. Desde T12 cada slot lleva su precio. */
interface AvailabilityJson {
  readonly courtId: string;
  readonly date: string;
  readonly slots: ReadonlyArray<{
    readonly startsAt: string;
    readonly endsAt: string;
    readonly priceCents: number;
    readonly priceBreakdown: ReadonlyArray<{ readonly label: string; readonly cents: number }>;
  }>;
}

async function pedir(url: string): Promise<Response> {
  return GET(new Request(`http://localhost:3000${url}`));
}

async function disponibilidad(
  courtId: string,
  fecha: string,
  extra = "",
): Promise<AvailabilityJson> {
  const response = await pedir(
    `/api/availability?court_id=${courtId}&date=${fecha}${extra}`,
  );
  expect(response.status).toBe(200);
  return (await response.json()) as AvailabilityJson;
}

/** Los inicios de los slots, que es como se lee una disponibilidad de un vistazo. */
async function inicios(courtId: string, fecha: string): Promise<string[]> {
  const cuerpo = await disponibilidad(courtId, fecha);
  return cuerpo.slots.map((slot) => slot.startsAt);
}

function apuntarA(slug: string): void {
  process.env["TENANT_SLUG"] = slug;
  clearTenantCache();
}

function placeholders(ids: readonly string[]): string {
  return ids.map((_, index) => `$${index + 1}`).join(", ");
}

/** Inserta un bloque para una pista. `reason` tiene que ser uno de los del `check`. */
async function bloquear(
  courtId: string,
  desde: string,
  hasta: string,
  reason = "mantenimiento",
): Promise<void> {
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.court_blocks (id, tenant_id, court_id, starts_at, ends_at, reason)
       values (gen_random_uuid(), $1, $2, $3::timestamptz, $4::timestamptz, $5)`,
      [courtId === PISTA_A ? TENANT_A : TENANT_B, courtId, desde, hasta, reason],
    );
  });
}

/** Inserta una reserva (overlay de T11) para un dia local. `holdExpira` es SQL literal. */
async function reservar(
  courtId: string,
  dia: string,
  desde: string,
  hasta: string,
  status: string,
  holdExpira: string | null = null,
): Promise<void> {
  const tenant = courtId === PISTA_A ? TENANT_A : TENANT_B;
  const zona = courtId === PISTA_A ? ZONA_A : ZONA_B;
  const holdExpiraSql =
    status === "held" ? (holdExpira ?? "now() + interval '3 minutes'") : "null";
  // Coherencia de pagos de T14 (20260930000000_payments_intent.sql): pending_payment
  // exige Intent + unpaid, confirmed exige paid. Los otros estados dejan las columnas
  // null, como un hold recien creado.
  const intent =
    status === "pending_payment" ? `pi_av_${courtId}_${desde}_${hasta}` : null;
  const pago =
    status === "pending_payment" ? "unpaid" : status === "confirmed" ? "paid" : null;
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.bookings
         (tenant_id, court_id, user_id, starts_at, ends_at, status,
          hold_expires_at, price_cents, price_breakdown, num_players,
          player_name, is_minor, stripe_payment_intent_id, payment_status)
       values ($1, $2, $3,
               ($4::timestamp at time zone $7),
               ($5::timestamp at time zone $7),
               $6, ${holdExpiraSql}, 1200, '[]', 4, 'Socio de T5d', false, $8, $9)`,
      [tenant, courtId, USUARIO_A, `${dia} ${desde}`, `${dia} ${hasta}`, status, zona, intent, pago],
    );
  });
}

beforeAll(async () => {
  await prepareDatabase();

  await withAdmin(async (db) => {
    await db.query(
      `delete from public.bookings where court_id in (${placeholders(MIS_FICTS)})`,
      [...MIS_FICTS],
    );
    await db.query(
      `delete from public.court_blocks where court_id in (${placeholders(MIS_FICTS)})`,
      [...MIS_FICTS],
    );
    await db.query(`delete from public.courts where id in (${placeholders(MIS_FICTS)})`, [
      ...MIS_FICTS,
    ]);
    await db.query(`delete from public.tenants where id in (${placeholders([TENANT_A, TENANT_B])})`, [
      TENANT_A,
      TENANT_B,
    ]);
    await db.query(`delete from auth.users where id = $1`, [USUARIO_A]);

    await db.query(
      `insert into public.tenants (id, name, slug, timezone)
       values ($1, 'Club T5d A', $2, $4), ($3, 'Club T5d B', $5, $6)`,
      [TENANT_A, SLUG_A, TENANT_B, ZONA_A, SLUG_B, ZONA_B],
    );
    await db.query(
      `insert into public.courts
       (id, tenant_id, name, court_type, base_price_cents, sort_order,
        default_duration_min, min_duration_min, max_duration_min)
       values
       ($1, $3, 'Pista T5d A', 'cristal', 1200, 1, 90, 60, 180),
       ($2, $4, 'Pista T5d B', 'cristal', 1200, 1, 90, 60, 180)`,
      [PISTA_A, PISTA_B, TENANT_A, TENANT_B],
    );
    await db.query(
      `insert into auth.users (id, email) values ($1, 'socio-t5d@test') on conflict (id) do nothing`,
      [USUARIO_A],
    );

    // -------------------------------------------------------------------------------
    // REGLAS DE T12, para que la grilla tenga tarifas que resolver de verdad.
    //
    // Cada comportamiento usa un DIA DISTINTO (por dia de la semana), igual que los
    // bloques del overlay: las reglas sobreviven al test (withAdmin, sin rollback) y
    // si dos grupos compartieran dia, una regla de un grupo descolocaria el slot del
    // otro. El patron es el del T5d: un fixture que se pisotea necesita su propio hueco.
    await db.query(`delete from public.pricing_rules where tenant_id = $1`, [TENANT_A]);
    await db.query(
      `insert into public.pricing_rules
         (id, tenant_id, name, scope, court_type, court_id, day_of_week,
          start_time, end_time, duration_min, price_cents, player_multiplier,
          priority, valid_from, valid_to)
       values
         ('00000000-0000-4000-8000-0000000005e5', $1, 'Tarifa punta manana', 'global', null, null, '{1}',
          '09:00', '12:00', 90, 2000, false, 0, null, null),
         ('00000000-0000-4000-8000-0000000005e6', $1, 'Tarifa por jugador', 'global', null, null, '{2}',
          '14:00', '16:30', 90, 1000, true, 0, null, null),
         ('00000000-0000-4000-8000-0000000005e7', $1, 'Tarifa tipo cristal', 'court_type', 'cristal', null, '{3}',
          '08:00', '22:00', 90, 1500, false, 0, null, null),
         ('00000000-0000-4000-8000-0000000005e8', $1, 'Tarifa global punta', 'global', null, null, '{3}',
          '08:00', '22:00', 90, 500, false, 99, null, null),
         ('00000000-0000-4000-8000-0000000005e9', $1, 'Tarifa pista A', 'court', null, $2, '{4}',
          '08:00', '22:00', 90, 1800, false, 0, null, null),
         ('00000000-0000-4000-8000-0000000005ea', $1, 'Tarifa cristal jueves', 'court_type', 'cristal', null, '{4}',
          '08:00', '22:00', 90, 1500, false, 0, null, null),
         ('00000000-0000-4000-8000-0000000005ec', $1, 'Tarifa de sesenta minutos', 'global', null, null, '{6}',
          '08:00', '22:00', 60, 999, false, 0, null, null),
         ('00000000-0000-4000-8000-0000000005ed', $1, 'Tarifa antigua', 'global', null, null, '{1}',
          '06:00', '22:00', 90, 777, false, 0, '2020-01-01', '2026-06-14'),
         ('00000000-0000-4000-8000-0000000005ee', $1, 'Tarifa futura', 'global', null, null, '{1}',
          '06:00', '22:00', 90, 888, false, 0, '2026-06-16', null)`,
      [TENANT_A, PISTA_A],
    );
  });

  apuntarA(SLUG_A);
});

afterAll(async () => {
  delete process.env["TENANT_SLUG"];
  clearTenantCache();
  await withAdmin(async (db) => {
    await db.query(
      `delete from public.bookings where court_id in (${placeholders(MIS_FICTS)})`,
      [...MIS_FICTS],
    );
    await db.query(
      `delete from public.court_blocks where court_id in (${placeholders(MIS_FICTS)})`,
      [...MIS_FICTS],
    );
    await db.query(`delete from public.courts where id in (${placeholders(MIS_FICTS)})`, [
      ...MIS_FICTS,
    ]);
    await db.query(`delete from public.tenants where id in (${placeholders([TENANT_A, TENANT_B])})`, [
      TENANT_A,
      TENANT_B,
    ]);
    await db.query(`delete from auth.users where id = $1`, [USUARIO_A]);
  });
  await closePool();
  await releaseDatabaseLease();
});

describe("T5d: la rejilla de un dia normal", () => {
  // 2026-06-15: un lunes de junio, con horario de verano en Madrid y sin cambio de hora en
  // un radio de semanas. La referencia contra la que se comparan todos los casos raros.
  const DIA = "2026-06-15";

  it("abre a las 8:00 y el ultimo slot acaba antes de las 22:00", async () => {
    const cuerpo = await disponibilidad(PISTA_A, DIA);
    expect(cuerpo.courtId).toBe(PISTA_A);
    expect(cuerpo.date).toBe(DIA);
    // 8:00 a 22:00 son 840 min. Con slots de 90 caben 9 enteros (810) y sobran 30, asi que
    // el noveno acaba a las 21:30 y no hay un decimo a medias. El motor de T5b ya lo
    // garantiza con el `inicio + duracion <= cerrar`; aqui se ve.
    expect(cuerpo.slots.map((s) => s.startsAt)).toEqual([
      `${DIA}T08:00`,
      `${DIA}T09:30`,
      `${DIA}T11:00`,
      `${DIA}T12:30`,
      `${DIA}T14:00`,
      `${DIA}T15:30`,
      `${DIA}T17:00`,
      `${DIA}T18:30`,
      `${DIA}T20:00`,
    ]);
    expect(cuerpo.slots[8]?.endsAt).toBe(`${DIA}T21:30`);
  });

  it("nunca pasa de las 22:00", async () => {
    const cuerpo = await disponibilidad(PISTA_A, DIA);
    for (const slot of cuerpo.slots) {
      expect(slot.endsAt <= `${DIA}T22:00`).toBe(true);
    }
  });

  it("no devuelve ni tenant_id ni otros datos del club, y si el precio de cada slot", async () => {
    const cuerpo = await disponibilidad(PISTA_A, DIA);
    expect(Object.keys(cuerpo).sort()).toEqual(["courtId", "date", "slots"]);
    // 08:00 un lunes no cae en ninguna tarifa de T12 (la de manana empieza en 09:00):
    // el precio que se ve es la tarifa base de la pista.
    const slot = cuerpo.slots.find((s) => s.startsAt === `${DIA}T08:00`);
    expect(slot).toMatchObject({
      startsAt: `${DIA}T08:00`,
      endsAt: `${DIA}T09:30`,
      priceCents: 1200,
    });
    // El desglose NO es decorativo: trae la etiqueta de lo que se le mostrara al socio.
    expect(slot?.priceBreakdown).toEqual([{ label: "Tarifa base", cents: 1200 }]);
    // Un slot no es una ventana del tenant: solo lo que el socio necesita para decidir.
    for (const s of cuerpo.slots) {
      expect(Object.keys(s).sort()).toEqual([
        "endsAt",
        "priceBreakdown",
        "priceCents",
        "startsAt",
      ]);
    }
  });
});

describe("T5d: court_blocks como overlay", () => {
  // ---------------------------------------------------------------------------------------
  // UNA FECHA DISTINTA POR TEST, Y NO POR ORGANIZACION
  //
  // `bloquear` usa `withAdmin`, que no lleva rollback, asi que un bloque se queda en la base
  // para siempre. Cuatro tests que meten bloques sobre la MISMA fecha se contaminan entre
  // ellos, y el rojo aparece en el ultimo con un recuento que no cuadra por culpa del
  // primero. La primera version de este fichero usaba `2026-06-16` en los seis y fallaba
  // exactamente asi: el test de "un bloque de OTRA pista" esperaba 9 huecos y se encontraba
  // con 7, porque el bloque del test anterior seguia ahi.
  //
  // Es el mismo hallazgo que en T5c, aplicado a las filas en vez de a los tenants: un fixture
  // commiteado necesita su propio hueco, y un hueco es una fecha.
  it("un bloque esconde solo los slots que toca", async () => {
    // 2026-06-16 en Madrid es CEST (UTC+2), asi que 12:00 local son 10:00 UTC. El bloque
    // cubre de 10:00 a 12:00 UTC, que en hora de pared es de 12:00 a 14:00: los slots de
    // 11:00 (11:00-12:30) y 12:30 (12:30-14:00) se van, y los demas se quedan.
    const DIA = "2026-06-16";
    await bloquear(PISTA_A, `${DIA}T10:00:00Z`, `${DIA}T12:00:00Z`);
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).toEqual([
      `${DIA}T08:00`,
      `${DIA}T09:30`,
      `${DIA}T14:00`,
      `${DIA}T15:30`,
      `${DIA}T17:00`,
      `${DIA}T18:30`,
      `${DIA}T20:00`,
    ]);
  });

  it("un bloque de OTRA pista no toca esta", async () => {
    const DIA = "2026-06-17";
    await bloquear(PISTA_B, `${DIA}T10:00:00Z`, `${DIA}T12:00:00Z`);
    expect(await inicios(PISTA_A, DIA)).toHaveLength(9);
  });

  it("un bloque que empieza justo al acabar un slot no lo quita", async () => {
    // De 10:30 a 12:00 UTC = 12:30 a 14:00 local. El slot de 11:00 acaba a las 12:30 y el
    // bloque empieza a las 12:30: no se solapan, y el de 12:30 si. Si el endpoint usara
    // `<=` en el filtro de solape, el de 11:00 desapareceria.
    const DIA = "2026-06-18";
    await bloquear(PISTA_A, `${DIA}T10:30:00Z`, `${DIA}T12:00:00Z`);
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).toContain(`${DIA}T11:00`);
    expect(resultado).not.toContain(`${DIA}T12:30`);
  });

  it("un bloque que empieza del dia anterior y sigue hasta hoy oculta lo de hoy", async () => {
    // El dato valido que obliga al recorte: de 22:00 a 02:00 locales del dia siguiente.
    // Sin recortar, el motor de T5b recibiria un instante de ayer y lanzaria.
    const DIA = "2026-06-19";
    await bloquear(PISTA_A, "2026-06-18T20:00:00Z", `${DIA}T00:00:00Z`);
    const resultado = await inicios(PISTA_A, DIA);
    // Abarca de las 00:00 a las 02:00 locales, que es antes de abrir, asi que no quita
    // ningun slot. Lo que se comprueba es que responde 200 y no 500.
    expect(resultado).toHaveLength(9);
  });

  it("un bloque de dia entero responde 200 y deja cero huecos", async () => {
    // El caso que obliga a restar un minuto al borde final: un bloque acaba a las 00:00 del
    // dia siguiente, y esas 00:00 son justo el instante que el motor de T5b rechaza.
    const DIA = "2026-06-20";
    await bloquear(PISTA_A, "2026-06-19T22:00:00Z", `${DIA}T22:00:00Z`, "cierre");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).toEqual([]);
  });

  it("dos bloques que se solapan entre si se aplican los dos", async () => {
    // En Madrid de junio, UTC+2, asi que los dos bloques son 10:00-12:00 y 11:00-13:00 en
    // hora de pared. Su union es 10:00-13:00, y sobre la rejilla de 90 min se llevan los
    // slots de 09:30, 11:00 y 12:30.
    //
    // El de 08:00 SOBREVIVE, y por eso merece la pena dejarlo escrito: el primer bloque
    // empieza a las 10:00, no a las 08:00, asi que no toca nada de la manana. Y el de 14:00
    // sobrevive porque el segundo bloque acaba a las 13:00. Este es el unico test que
    // distingue "se aplicando los dos" de "solo el primero" o "solo el ultimo":
    //   - con el primero solo (10:00-12:00) el de 12:30 saldria, y son 7 slots.
    //   - con el ultimo solo (11:00-13:00) el de 09:30 saldria, y tambien son 7.
    //   - con los dos, 6. Por eso la lista entera se compara y no un `length`.
    const DIA = "2026-06-21";
    await bloquear(PISTA_A, `${DIA}T08:00:00Z`, `${DIA}T10:00:00Z`);
    await bloquear(PISTA_A, `${DIA}T09:00:00Z`, `${DIA}T11:00:00Z`);
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).toEqual([
      `${DIA}T08:00`,
      `${DIA}T14:00`,
      `${DIA}T15:30`,
      `${DIA}T17:00`,
      `${DIA}T18:30`,
      `${DIA}T20:00`,
    ]);
  });
});

describe("T11: el overlay de bookings activos (el motivo de la ruta de holds)", () => {
  // ---------------------------------------------------------------------------------------
  // LAS RESERVAS DE T11 SON TAMBIEN OVERLAY, Y EL PRECIO DE UNA PISTA ES UNO SOLO
  //
  // Un hold de 3 minutos TAPARIA el hueco exacto que una reserva confirmada y no tendria
  // ningun sentido mostrarlo al socio; por eso el overlay de `bookings` se construyo con la
  // MISMA consulta que ya filtraba `court_blocks`, con UNION ALL y el mismo recorte. Los
  // estados: les descuentan el hueco a held (vivo), pending_payment y confirmed; un hold
  // CADUCADO y una reserva CANCELLED ya no cuentan, si no los mas de un año del club
  // estarian tapados.
  //
  // Mismos reglas que los court_blocks: una fecha distinta por test y limpieza en beforeAll
  // (lineas 23 a 27 de junio, que ningun otro test de este fichero usa).
  it("una reserva realizada como hold vigente esconde el slot", async () => {
    // El hold vivo: 08:00-09:30 (hora de pared). Quita el primer slot y nada mas.
    const DIA = "2026-06-23";
    await reservar(PISTA_A, DIA, "08:00", "09:30", "held");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).not.toContain(`${DIA}T08:00`);
    expect(resultado).toContain(`${DIA}T09:30`);
    expect(resultado).toHaveLength(8);
  });

  it("un hold YA caducado no esconde el slot (la limpieza perezosa lo expira)", async () => {
    // El hold nacio, vivio sus 3 minutos y murio: la pista vuelve a estar libre. Es la
    // misma regla que `expire_stale_holds` y que el filtro `hold_expires_at > now()`.
    const DIA = "2026-06-24";
    await reservar(PISTA_A, DIA, "08:00", "09:30", "held", "now() - interval '1 minute'");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).toHaveLength(9);
    expect(resultado[0]).toBe(`${DIA}T08:00`);
  });

  it("una reserva cancelada no esconde el slot", async () => {
    const DIA = "2026-06-25";
    await reservar(PISTA_A, DIA, "08:00", "09:30", "cancelled");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).toHaveLength(9);
    expect(resultado[0]).toBe(`${DIA}T08:00`);
  });

  it("una reserva confirmada esconde el slot", async () => {
    // 12:00-13:30 local: se lleva los slots de 11:00 (11:00-12:30) y 12:30 (12:30-14:00).
    const DIA = "2026-06-26";
    await reservar(PISTA_A, DIA, "12:00", "13:30", "confirmed");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).not.toContain(`${DIA}T11:00`);
    expect(resultado).not.toContain(`${DIA}T12:30`);
    expect(resultado).toContain(`${DIA}T14:00`);
  });

  it("una reserva pendiente de pago esconde el slot", async () => {
    // En el flujo del club, pending_payment es el paso justo despues del hold: si estuviera
    // libre, dos socios podrian llegar al mismo pago guiados por la misma rejilla.
    const DIA = "2026-06-27";
    await reservar(PISTA_A, DIA, "08:00", "09:30", "pending_payment");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).not.toContain(`${DIA}T08:00`);
    expect(resultado).toHaveLength(8);
  });

  it("el hold de otro tenant no tapa NADA de este", async () => {
    // Una reserva del club B con el mismo horario: la UNION ALL se limita a la pista que
    // se esta consultando, y la RLS ya aisla a los clubs. Los 9 huecos se quedan.
    const DIA = "2026-06-28";
    await reservar(PISTA_B, DIA, "08:00", "09:30", "confirmed");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).toHaveLength(9);
  });
});

describe("T5d: la zona horaria del club (el motivo de este endpoint)", () => {
  it("en verano un bloque a las 06:00 UTC es el slot de las 08:00", async () => {
    // 2026-07-01 en Madrid es CEST, UTC+2. Un cierre de 06:00 a 07:30 UTC es de 08:00 a
    // 09:30 en hora de pared: se lleva el primer slot y nada mas. Si el codigo aplicase un
    // desfase fijo de +1 (el de invierno), esto seria las 07:00 y no tocaria nada.
    const DIA = "2026-07-01";
    await bloquear(PISTA_A, "2026-07-01T06:00:00Z", "2026-07-01T07:30:00Z");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado[0]).toBe(`${DIA}T09:30`);
    expect(resultado).not.toContain(`${DIA}T08:00`);
  });

  it("en invierno un bloque a las 07:00 UTC es el slot de las 08:00", async () => {
    // 2026-12-01 en Madrid es CET, UTC+1. La misma hora de pared se guarda una hora mas
    // tarde en UTC. El par de tests con el de verano es el que demuestra que el desfase se
    // calcula por fecha y no con una constante.
    const DIA = "2026-12-01";
    await bloquear(PISTA_A, "2026-12-01T07:00:00Z", "2026-12-01T08:30:00Z");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado[0]).toBe(`${DIA}T09:30`);
    expect(resultado).not.toContain(`${DIA}T08:00`);
  });

  it("el dia de cambio a primavera (2026-03-29) tambien usa UTC+2", async () => {
    // Ese domingo a las 02:00 locales no existe: salta a las 03:00. A las 06:00 UTC ya es
    // horario de verano, asi que el bloque es el de las 08:00 de pared.
    const DIA = "2026-03-29";
    await bloquear(PISTA_A, "2026-03-29T06:00:00Z", "2026-03-29T07:30:00Z");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).not.toContain(`${DIA}T08:00`);
    expect(resultado[0]).toBe(`${DIA}T09:30`);
  });

  it("el dia de cambio a otono (2026-10-25) tambien usa UTC+1", async () => {
    // A las 03:00 locales las 02:00 se repiten. El club abre a las 08:00, asi que la hora
    // repetida cae fuera de la ventana y no se nota: por eso 9 slots y no 10. Si el club
    // abriera de noche, este test habria que rehacer y la pagina de la cabecera con el.
    const DIA = "2026-10-25";
    await bloquear(PISTA_A, "2026-10-25T07:00:00Z", "2026-10-25T08:30:00Z");
    const resultado = await inicios(PISTA_A, DIA);
    expect(resultado).toHaveLength(8);
    expect(resultado).not.toContain(`${DIA}T08:00`);
  });

  it("otro tenant con otra zona recibe sus propias horas", async () => {
    // Mexico City (`America/Mexico_City`) esta a UTC-6 todo el ano desde 2022, sin horario
    // de verano. El bloque de 13:00 a 14:00 UTC del dia 16 son las 07:00 a las 08:00
    // locales: antes de abrir, asi que no quita ningun slot y siguen siendo 9.
    //
    // Aqui ESTA el test. Sin el bloque solo se comprobaria que la rejilla existe, que ya lo
    // hacen los de arriba. Con el, si el endpoint usase la zona de Madrid en vez de la del
    // tenant, las 13:00 UTC serian las 15:00 y el bloque se llevaria el slot de las 15:30
    // (15:30-17:00 se solapa con 15:00-16:00), y serian 8. El fallo, si lo hay, es visible.
    await bloquear(PISTA_B, "2026-06-16T13:00:00Z", "2026-06-16T14:00:00Z");
    apuntarA(SLUG_B);
    try {
      const cuerpo = await disponibilidad(PISTA_B, "2026-06-16");
      expect(cuerpo.slots).toHaveLength(9);
      expect(cuerpo.slots[0]?.startsAt).toBe("2026-06-16T08:00");
    } finally {
      apuntarA(SLUG_A);
    }
  });
});

describe("T5d: una pista que no es de este club", () => {
  const UUID_INVENTADO = "00000000-0000-4000-8000-00000000ffff";

  it("una pista de otro tenant da 404", async () => {
    const response = await pedir(
      `/api/availability?court_id=${PISTA_B}&date=2026-06-15`,
    );
    expect(response.status).toBe(404);
  });

  it("un uuid que no existe da el MISMO 404, cuerpo incluido", async () => {
    // El criterio 7.1 pide 404 y no 403 para no confirmar la existencia. Este es el test que
    // lo hace observable: si las dos respuestas no fueran identicas, un atacante que
    // recorriera uuids sabria que filas existen en el club de al lado.
    const ajeno = await pedir(`/api/availability?court_id=${PISTA_B}&date=2026-06-15`);
    const inexistente = await pedir(
      `/api/availability?court_id=${UUID_INVENTADO}&date=2026-06-15`,
    );
    expect(ajeno.status).toBe(404);
    expect(inexistente.status).toBe(404);
    expect(await ajeno.text()).toBe(await inexistente.text());
  });

  it("no dice NUNCA 403", async () => {
    const response = await pedir(
      `/api/availability?court_id=${PISTA_B}&date=2026-06-15`,
    );
    expect(response.status).not.toBe(403);
  });
});

describe("T5d: parametros que no valen", () => {
  it("sin court_id", async () => {
    expect((await pedir("/api/availability?date=2026-06-15")).status).toBe(400);
  });

  it("sin date", async () => {
    const response = await pedir(`/api/availability?court_id=${PISTA_A}`);
    expect(response.status).toBe(400);
  });

  it("court_id que no es un uuid", async () => {
    const response = await pedir("/api/availability?court_id=pista-1&date=2026-06-15");
    expect(response.status).toBe(400);
  });

  it("una fecha con formato raro", async () => {
    // Sin esto, `2026-3-2` llegaria a Postgres, que lo castearia a 2 de marzo y devolveria
    // un 200 con un dia que nadie pidio.
    expect(
      (await pedir(`/api/availability?court_id=${PISTA_A}&date=2026-3-2`)).status,
    ).toBe(400);
  });

  it("una fecha que no existe en el calendario", async () => {
    // El 30 de febrero pasa el `/^\d{4}-\d{2}-\d{2}$/` y es un dia que no hay. Postgres lo
    // rechaza al castear, y sin esta comprobacion seria un 500 por culpa de quien escribió
    // la URL, que es el peor sitio posible para un error de entrada.
    expect(
      (await pedir(`/api/availability?court_id=${PISTA_A}&date=2026-02-30`)).status,
    ).toBe(400);
  });

  it("un 400 dice cual era el problema, y por que aqui si puede", async () => {
    // Al reves que con el 500: aqui el que se equivoco es quien escribe la URL, y decirle
    // cual de los dos parametros esta mal ahorra una conversacion de soporte.
    const response = await pedir("/api/availability?date=2026-06-15");
    const cuerpo = (await response.json()) as { error: string };
    expect(cuerpo.error).toContain("court_id");
  });
});

describe("T5d: criterio 7.1, que aqui si es observable", () => {
  it("un tenant_id en la query no cambia nada", async () => {
    // En `/api/courts` esto no se podia comprobar, porque el handler no leia la query. Aqui
    // si: si leyera el `tenant_id`, encontraria la pista del otro club y devolveria su
    // horario entero.
    const sinParametro = await disponibilidad(PISTA_A, "2026-06-17");
    const conParametro = await disponibilidad(
      PISTA_A,
      "2026-06-17",
      `&tenant_id=${TENANT_B}`,
    );
    expect(conParametro).toEqual(sinParametro);
  });

  it("un tenant_id basura tampoco revienta", async () => {
    const response = await pedir(
      `/api/availability?court_id=${PISTA_A}&date=2026-06-17&tenant_id=no-es-un-uuid`,
    );
    expect(response.status).toBe(200);
  });
});

/** Fila de `pricing_rules`, como la leeria la propia disponibilidad. */
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

function filaARegla(f: ReglaFila): PricingRule {
  return {
    id: f.id,
    name: f.name,
    scope: f.scope as PricingRule["scope"],
    courtType: f.court_type as CourtType | null,
    courtId: f.court_id,
    dayOfWeek: f.day_of_week,
    startTime: f.start_time,
    endTime: f.end_time,
    durationMin: f.duration_min,
    priceCents: f.price_cents,
    playerMultiplier: f.player_multiplier,
    priority: f.priority,
    validFrom: f.valid_from,
    validTo: f.valid_to,
    isActive: f.is_active,
  };
}

describe("T12: cada hueco trae su precio resuelto en servidor", () => {
  // La tarifa base de las pistas de este fichero, a la que cae el slot que ninguna
  // tarifa toca. Se duplica a proposito, con nombre: es el CONTRATO de la grilla.
  const BASE = 1200;

  // Las fechas son de AGOSTO, no de junio, a proposito: los bloques y reservas de los
  // otras describes sobreviven al test (withAdmin, sin rollback) y ya ocupan casi todos
  // los dias de junio. Agosto esta intacto en este fichero.
  it("sin regla aplicable cae a la tarifa base, nunca a un precio vacio", async () => {
    // 2026-08-07 es viernes: ninguna tarifa de T12 esta dada para el dia 5.
    const cuerpo = await disponibilidad(PISTA_A, "2026-08-07");
    expect(cuerpo.slots.length).toBeGreaterThan(0);
    for (const slot of cuerpo.slots) {
      expect(slot.priceCents).toBe(BASE);
      expect(slot.priceBreakdown).toEqual([{ label: "Tarifa base", cents: BASE }]);
    }
  });

  it("una tarifa global aplica por su nombre y solo al slot que cabe entero", async () => {
    // 2026-06-15 lunes: la tarifa de manana es 09:00-12:00 (fecha de junio a proposito,
    // para convivir con las tarifas antigua/futura del test de abajo). El slot
    // 09:30-11:00 cabe entero; el 11:00-12:30 no termina dentro y el 08:00 no entra.
    const cuerpo = await disponibilidad(PISTA_A, "2026-06-15");
    const porHora = Object.fromEntries(cuerpo.slots.map((s) => [s.startsAt, s]));
    expect(porHora["2026-06-15T09:30"]).toMatchObject({
      priceCents: 2000,
      priceBreakdown: [{ label: "Tarifa punta manana", cents: 2000 }],
    });
    expect(porHora["2026-06-15T08:00"]?.priceCents).toBe(BASE);
    expect(porHora["2026-06-15T11:00"]?.priceCents).toBe(BASE);
  });

  it("una tarifa fuera de su ventana de validez no aplica", async () => {
    // El lunes 15 hay dos tarifas que NO son validas ese dia: la antigua vencio el 14
    // (inclusivo) y la futura no empieza hasta el 16. Ninguna etiqueta suya puede salir.
    const cuerpo = await disponibilidad(PISTA_A, "2026-06-15");
    const etiquetas = cuerpo.slots.flatMap((s) => s.priceBreakdown.map((l) => l.label));
    expect(etiquetas).toContain("Tarifa punta manana");
    expect(etiquetas).not.toContain("Tarifa antigua");
    expect(etiquetas).not.toContain("Tarifa futura");
    expect(
      etiquetas.every((l) => l === "Tarifa punta manana" || l === "Tarifa base"),
    ).toBe(true);
  });

  it("court_type gana a global aunque la global tenga mas prioridad", async () => {
    // Miercoles 2026-08-05: la global punta tiene priority 99 y el tipo cristal 0.
    // Gana el SCOPE, no el numero: spec 7.3.
    const cuerpo = await disponibilidad(PISTA_A, "2026-08-05");
    for (const slot of cuerpo.slots) {
      expect(slot.priceCents).toBe(1500);
      expect(slot.priceBreakdown).toEqual([{ label: "Tarifa tipo cristal", cents: 1500 }]);
    }
  });

  it("court gana a court_type", async () => {
    // Jueves 2026-08-06: la tarifa de la pista A (1800) se lleva el slot frente a la
    // del tipo cristal (1500).
    const cuerpo = await disponibilidad(PISTA_A, "2026-08-06");
    for (const slot of cuerpo.slots) {
      expect(slot.priceCents).toBe(1800);
      expect(slot.priceBreakdown).toEqual([{ label: "Tarifa pista A", cents: 1800 }]);
    }
  });

  it("una regla de pista no cuela su tarifa en el otro club", async () => {
    // El jueves A tiene 'Tarifa pista A' (1800). B no tiene NINGUNA regla y su pista es
    // del mismo tipo 'cristal': si la consulta arrastrara reglas ajenas, B veria 1800.
    // Con la RLS, B ve su tarifa base.
    apuntarA(SLUG_B);
    try {
      const cuerpo = await disponibilidad(PISTA_B, "2026-08-06");
      for (const slot of cuerpo.slots) {
        expect(slot.priceCents).toBe(BASE);
        expect(slot.priceBreakdown).toEqual([{ label: "Tarifa base", cents: BASE }]);
      }
    } finally {
      apuntarA(SLUG_A);
    }
  });

  it("player_multiplier multiplica por los jugadores por defecto de la pista", async () => {
    // Martes 2026-08-04: la tarifa por jugador (1000) aplica al slot de 14:00 y se
    // multiplica por los 4 jugadores por defecto de la pista. La segunda linea del
    // desglose es el FACTOR, con centimos 0, no otro cobro.
    const cuerpo = await disponibilidad(PISTA_A, "2026-08-04");
    const slotCatorce = cuerpo.slots.find((s) => s.startsAt === "2026-08-04T14:00");
    const slotCatorceYMedia = cuerpo.slots.find((s) => s.startsAt === "2026-08-04T15:30");
    expect(slotCatorce).toMatchObject({
      priceCents: 4000,
      priceBreakdown: [
        { label: "Tarifa por jugador", cents: 4000 },
        { label: "4 jugadores", cents: 0 },
      ],
    });
    // El slot de 15:30 no termina dentro de 14:00-16:30: sigue a tarifa base.
    expect(slotCatorceYMedia?.priceCents).toBe(BASE);
  });

  it("una tarifa de otra duracion que la pista no aplica", async () => {
    // Sabado 2026-08-08: la tarifa de sesenta minutos (999) no encaja con pistas de 90.
    // Que no aparezca su etiqueta es lo que se afirma, no solo el importe.
    const cuerpo = await disponibilidad(PISTA_A, "2026-08-08");
    for (const slot of cuerpo.slots) {
      expect(slot.priceCents).toBe(BASE);
      expect(slot.priceBreakdown.map((l) => l.label)).not.toContain(
        "Tarifa de sesenta minutos",
      );
    }
  });

  it("el PriceQuote de la API coincide con resolvePrice llamado directamente", async () => {
    // Criterio de verificacion de T12: el numero que ve el socio es exactamente el del
    // motor, con las MISMAS reglas que la API leyo de la base.
    const filas = await withAdmin(async (db) => {
      const result = await db.query<ReglaFila>(
        `select id, name, scope, court_type, court_id, day_of_week,
                to_char(start_time, 'HH24:MI') as start_time,
                to_char(end_time, 'HH24:MI') as end_time,
                duration_min, price_cents, player_multiplier, priority,
                to_char(valid_from, 'YYYY-MM-DD') as valid_from,
                to_char(valid_to, 'YYYY-MM-DD') as valid_to,
                is_active
           from public.pricing_rules
          where tenant_id = $1`,
        [TENANT_A],
      );
      return result.rows;
    });

    const quote = resolvePrice({
      court: { id: PISTA_A, courtType: "cristal", basePriceCents: BASE },
      rules: filas.map(filaARegla),
      startsAt: "2026-06-15T09:30",
      durationMin: 90,
      numPlayers: 4,
    });

    const slot = (await disponibilidad(PISTA_A, "2026-06-15")).slots.find(
      (s) => s.startsAt === "2026-06-15T09:30",
    );
    expect(quote.totalCents).toBe(2000);
    expect(slot).toMatchObject({
      priceCents: quote.totalCents,
      priceBreakdown: quote.breakdown,
    });
  });
});

describe("T5d: cuando el despliegue esta roto", () => {
  it("sin TENANT_SLUG responde 500 sin decir cual era el problema", async () => {
    const anterior = process.env["TENANT_SLUG"];
    delete process.env["TENANT_SLUG"];
    clearTenantCache();
    try {
      const response = await pedir(
        `/api/availability?court_id=${PISTA_A}&date=2026-06-15`,
      );
      expect(response.status).toBe(500);
      const cuerpo = await response.text();
      expect(cuerpo).not.toContain("TENANT_SLUG");
      expect(cuerpo).not.toContain("env.example");
    } finally {
      if (anterior !== undefined) process.env["TENANT_SLUG"] = anterior;
      clearTenantCache();
    }
  });

  it("sin cache, porque la disponibilidad cambia", async () => {
    const response = await pedir(
      `/api/availability?court_id=${PISTA_A}&date=2026-06-22`,
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
