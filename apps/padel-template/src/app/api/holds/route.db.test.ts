import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "./route";
import { closePool } from "../../../lib/server/db";
import { clearTenantCache } from "../../../lib/server/tenant";
import {
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
} from "../../../test/db-harness";

/**
 * T11: `POST /api/holds` - retener una pista 3 minutos.
 *
 * ---------------------------------------------------------------------------------------
 * TENANTS PROPIOS, COMO EN T5d, Y POR EL MISMO MOTIVO
 *
 * La suite comparte base, y las filas que esta ruta CREA se COMMITEAN (es un endpoint de
 * verdad, con su propio pool): un hold que el test deja vivo taparia el horario del test
 * de otro fichero. Por eso cada test usa un dia distinto, y `afterAll` borra todo lo que
 * este fichero pudo sembrar. Identicos fijos, reproducibles con un `psql` a mano.
 *
 * LA IDENTIDAD VA EN LA COOKIE (spec 6.2): el `sub` viaja en `frasapp_session` como JWT de
 * tres partes SIN firma verificada (decision pendiente de T11, ver `session.ts`). La FK de
 * `bookings.user_id` a `auth.users` es quien distingue un `sub` de persona de un uuid
 * inventado: de ahi el test de 401 por FK.
 */

/** Tenant con pistas y socios de este fichero. */
const TENANT_A = "00000000-0000-4000-8000-0000000006a0";
const SLUG_A = "club-t11-a";

/** Tenant con pista propia, para el 404 cross-tenant. */
const TENANT_B = "00000000-0000-4000-8000-0000000006a1";
const SLUG_B = "club-t11-b";

/** Pista de A y pista de B. Las dos existen para que el 404 tenga algo que no ver. */
const PISTA_A = "00000000-0000-4000-8000-0000000006a2";
const PISTA_B = "00000000-0000-4000-8000-0000000006a3";

/** Un socio de A y otro de B, en `auth.users` (que es quien valida la FK). */
const USUARIO_A = "00000000-0000-4000-8000-0000000006a4";
const USUARIO_B = "00000000-0000-4000-8000-0000000006a5";

/** Un uuid que NO es ninguna persona. Para el 401 de la FK. */
const INVENTADO = "00000000-0000-4000-8000-00000000cafe";

const TENANTES = [TENANT_A, TENANT_B];
const PISTAS = [PISTA_A, PISTA_B];
const USUARIOS = [USUARIO_A, USUARIO_B];

const ZONA_A = "Europe/Madrid";
const ZONA_B = "America/Mexico_City";

/** La pista vale 1200 centimos, que es lo que debe salir como precio base. */
const PRECIO_BASE = 1200;

/** Una sesion de la forma de la cookie: JWT de tres partes, sin firma real. */
function cookieDe(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `frasapp_session=cabecera.${payload}.firma`;
}

/** Llama al POST con cookie (o sin ella) y un cuerpo crudo. */
async function crear(cuerpo: string, cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== null) headers["cookie"] = cookie;
  return POST(
    new Request("http://localhost:3000/api/holds", {
      method: "POST",
      headers,
      body: cuerpo,
    }),
  );
}

/**
 * Un adulto de 1990, que es lo que aporta por defecto a los cuerpos de T11.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE SE COMPLETA AQUI Y NO EN CADA CUERPO
 *
 * Desde T14c `playerBirthDate` es OBLIGATORIA, y catorce de los cuerpos de este fichero no
 * van de ella: estan probando el precio, el 409, el 404 o la cookie. Anadirsela a los catorce
 * seria ruido en un test que no la mira, y un sitio unico del que se ve el motivo es mas
 * util que catorce lineas iguales. Un adulto de 1990 no cambia ninguna de las cosas que
 * estos casos comprueban.
 *
 * Un cuerpo que pase `playerBirthDate: null` o que no sea un objeto NO se toca, que es justo
 * lo que necesitan los casos de cuerpo malformado. Y los 400 y 422 de la fecha y del tutor
 * los prueba T14c E3, con la fecha puesta a proposito.
 */
const NACIMIENTO_ADULTO = "1990-01-01";

function cuerpoDe(campo: unknown): string {
  if (typeof campo !== "object" || campo === null || Array.isArray(campo)) {
    return typeof campo === "string" ? campo : JSON.stringify(campo);
  }
  const cuerpo = campo as Record<string, unknown>;
  if ("playerBirthDate" in cuerpo) return JSON.stringify(cuerpo);
  return JSON.stringify({ playerBirthDate: NACIMIENTO_ADULTO, ...cuerpo });
}

function apuntarA(slug: string): void {
  process.env["TENANT_SLUG"] = slug;
  clearTenantCache();
}

function placeholders(ids: readonly string[]): string {
  return ids.map((_, index) => `$${index + 1}`).join(", ");
}

interface HoldCreadoJson {
  readonly id: string;
  readonly status: string;
  readonly courtId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly holdExpiresAt: string;
  readonly priceCents: number;
  readonly priceBreakdown: ReadonlyArray<{ readonly label: string; readonly cents: number }>;
}

beforeAll(async () => {
  await prepareDatabase();

  await withAdmin(async (db) => {
    // Limpieza de un run anterior que muriese a mitad, antes de sembrar otra vez.
    await db.query(
      `delete from public.bookings where court_id in (${placeholders(PISTAS)})`,
      [...PISTAS],
    );
    await db.query(
      `delete from public.court_blocks where court_id in (${placeholders(PISTAS)})`,
      [...PISTAS],
    );
    await db.query(`delete from public.courts where id in (${placeholders(PISTAS)})`, [
      ...PISTAS,
    ]);
    await db.query(`delete from public.tenants where id in (${placeholders(TENANTES)})`, [
      ...TENANTES,
    ]);
    await db.query(`delete from auth.users where id in (${placeholders(USUARIOS)})`, [
      ...USUARIOS,
    ]);

    await db.query(
      `insert into public.tenants (id, name, slug, timezone)
       values ($1, 'Club T11 A', $2, $4), ($3, 'Club T11 B', $5, $6)`,
      [TENANT_A, SLUG_A, TENANT_B, ZONA_A, SLUG_B, ZONA_B],
    );
    await db.query(
      `insert into public.courts
       (id, tenant_id, name, court_type, base_price_cents, sort_order,
        default_duration_min, min_duration_min, max_duration_min)
       values
       ($1, $3, 'Pista T11 A', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180),
       ($2, $4, 'Pista T11 B', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180)`,
      [PISTA_A, PISTA_B, TENANT_A, TENANT_B],
    );
    await db.query(
      `insert into auth.users (id, email) values
       ($1, 'socio-a@t11.test'), ($2, 'socio-b@t11.test')
       on conflict (id) do nothing`,
      [USUARIO_A, USUARIO_B],
    );

    // Una tarifa de jueves de 2500 para probar T12: el 409 y el hold cobran con reglas
    // reales, no con la base de siempre. Global, duracion 90 (la de las pistas), sin
    // multiplicador.
    await db.query(`delete from public.pricing_rules where tenant_id = $1`, [TENANT_A]);
    await db.query(
      `insert into public.pricing_rules
         (id, tenant_id, name, scope, court_type, court_id, day_of_week,
          start_time, end_time, duration_min, price_cents, player_multiplier,
          priority, valid_from, valid_to)
       values
         ('00000000-0000-4000-8000-0000000006a6', $1, 'Tarifa Jueves Hold', 'global',
          null, null, '{4}', '08:00', '22:00', 90, 2500, false, 0, null, null)`,
      [TENANT_A],
    );
  });

  apuntarA(SLUG_A);
});

afterAll(async () => {
  delete process.env["TENANT_SLUG"];
  clearTenantCache();
  await withAdmin(async (db) => {
    await db.query(
      `delete from public.bookings where court_id in (${placeholders(PISTAS)})`,
      [...PISTAS],
    );
    await db.query(
      `delete from public.court_blocks where court_id in (${placeholders(PISTAS)})`,
      [...PISTAS],
    );
    await db.query(`delete from public.courts where id in (${placeholders(PISTAS)})`, [
      ...PISTAS,
    ]);
    await db.query(`delete from auth.users where id in (${placeholders(USUARIOS)})`, [
      ...USUARIOS,
    ]);
    await db.query(`delete from public.tenants where id in (${placeholders(TENANTES)})`, [
      ...TENANTES,
    ]);
  });
  await closePool();
  await releaseDatabaseLease();
});

describe("T11: crear un hold", () => {
  it("crea el hold de 3 minutos con el horario pedido y el precio base", async () => {
    const respuesta = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-13T08:00",
        numPlayers: 4,
        playerName: "Socio Uno",
      }),
      cookieDe(USUARIO_A),
    );
    expect(respuesta.status).toBe(201);

    const cuerpo = (await respuesta.json()) as HoldCreadoJson;
    expect(cuerpo.status).toBe("held");
    expect(cuerpo.courtId).toBe(PISTA_A);
    expect(cuerpo.startsAt).toBe("2026-07-13T08:00");
    expect(cuerpo.endsAt).toBe("2026-07-13T09:30");
    expect(cuerpo.holdExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
    expect(cuerpo.priceCents).toBe(PRECIO_BASE);
    expect(cuerpo.priceBreakdown).toEqual([
      { label: "Tarifa base", cents: PRECIO_BASE },
    ]);

    // La fila que quedo, con el dueño y el reloj: 3 minutos exactos, duracion 90.
    await withAdmin(async (db) => {
      const filas = await db.query<{
        user_id: string;
        status: string;
        segundos_de_hold: number;
        minutos: string;
      }>(
        `select
           user_id, status,
           extract(epoch from (hold_expires_at - now()))::int as segundos_de_hold,
           (ends_at - starts_at)::text as minutos
         from public.bookings where id = $1`,
        [cuerpo.id],
      );
      const fila = filas.rows[0];
      expect(fila?.user_id).toBe(USUARIO_A);
      expect(fila?.status).toBe("held");
      expect(fila?.segundos_de_hold).toBeGreaterThan(178);
      expect(fila?.segundos_de_hold).toBeLessThan(182);
      expect(fila?.minutos).toBe("01:30:00");
    });
  });

  it("no deja que el cliente mande el precio: lo calcula el servidor", async () => {
    const respuesta = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-17T08:00",
        numPlayers: 4,
        playerName: "Socio",
        priceCents: 1,
      }),
      cookieDe(USUARIO_A),
    );
    expect(respuesta.status).toBe(201);
    const cuerpo = (await respuesta.json()) as HoldCreadoJson;
    expect(cuerpo.priceCents).toBe(PRECIO_BASE);
  });

  it("ignora un tenant_id que llegue de paso en el cuerpo (criterio 7.1)", async () => {
    const respuesta = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-18T08:00",
        numPlayers: 4,
        playerName: "Socio",
        tenant_id: TENANT_B,
      }),
      cookieDe(USUARIO_A),
    );
    expect(respuesta.status).toBe(201);
    const cuerpo = (await respuesta.json()) as HoldCreadoJson;

    await withAdmin(async (db) => {
      const filas = await db.query<{ tenant_id: string }>(
        `select tenant_id from public.bookings where id = $1`,
        [cuerpo.id],
      );
      // Si la ruta hubiera respetado el `tenant_id` del cuerpo, esta fila seria del club B
      // y la RLS del club A no la habria dejado crear. La fila existe y es del club A.
      expect(filas.rows[0]?.tenant_id).toBe(TENANT_A);
    });
  });

  it("209 no: un hueco que ya ocupa un court_block responde 409 con alternativas", async () => {
    await withAdmin(async (db) => {
      await db.query(
        `insert into public.court_blocks
           (id, tenant_id, court_id, starts_at, ends_at, reason)
         values (gen_random_uuid(), $1, $2,
                 ($3::timestamp at time zone $4),
                 (($3::timestamp + interval '90 minutes') at time zone $4),
                 'mantenimiento')`,
        [TENANT_A, PISTA_A, "2026-07-14 08:00", ZONA_A],
      );
    });

    const respuesta = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-14T08:00",
        numPlayers: 4,
        playerName: "Socio",
      }),
      cookieDe(USUARIO_A),
    );
    expect(respuesta.status).toBe(409);

    const cuerpo = (await respuesta.json()) as {
      error: string;
      alternatives: { courtId: string; date: string; slots: ReadonlyArray<{ startsAt: string }> };
    };
    expect(cuerpo.error.length).toBeGreaterThan(0);
    expect(cuerpo.alternatives.courtId).toBe(PISTA_A);
    expect(cuerpo.alternatives.date).toBe("2026-07-14");
    expect(cuerpo.alternatives.slots.map((s) => s.startsAt)).not.toContain(
      "2026-07-14T08:00",
    );
    // El slot de las 09:30 no lo toca un bloque que acaba a las 09:30, asi que sigue libre
    // y es la alternativa que un socio ve al recuperarse del 409.
    expect(cuerpo.alternatives.slots.map((s) => s.startsAt)).toContain(
      "2026-07-14T09:30",
    );
  });

  it("un hold vigente en el mismo hueco responde 409 sin alternativas para ese hueco", async () => {
    // Primer hold: lo pide el socio, se COMMITEA.
    const primero = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-15T08:00",
        numPlayers: 2,
        playerName: "Socio Uno",
      }),
      cookieDe(USUARIO_A),
    );
    expect(primero.status).toBe(201);

    const segundo = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-15T08:00",
        numPlayers: 2,
        playerName: "Socio Dos",
      }),
      cookieDe(USUARIO_A),
    );
    expect(segundo.status).toBe(409);
    const cuerpo = (await segundo.json()) as {
      alternatives: { courtId: string; date: string; slots: ReadonlyArray<{
        startsAt: string;
        priceCents: number;
        priceBreakdown: ReadonlyArray<{ label: string; cents: number }>;
      }> };
    };
    expect(cuerpo.alternatives.slots.map((s) => s.startsAt)).not.toContain(
      "2026-07-15T08:00",
    );
  });

  it("el 409 trae alternativas con su precio ya resuelto (T12)", async () => {
    // Mismo escenario que el 409 de arriba, pero afirmando el precio de las
    // alternativas: son disponibles REALES, con tarifa resuelta en servidor. El bloque
    // de las 08:00 del 14 ya lo dejo el otro test, y el martes no tiene tarifa dada.
    const respuesta = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-14T08:00",
        numPlayers: 4,
        playerName: "Socio",
      }),
      cookieDe(USUARIO_A),
    );
    expect(respuesta.status).toBe(409);

    const cuerpo = (await respuesta.json()) as {
      alternatives: { slots: ReadonlyArray<{
        startsAt: string;
        priceCents: number;
        priceBreakdown: ReadonlyArray<{ label: string; cents: number }>;
      }> };
    };
    const slotNueve = cuerpo.alternatives.slots.find((s) => s.startsAt === "2026-07-14T09:30");
    expect(slotNueve).toMatchObject({
      priceCents: PRECIO_BASE,
      priceBreakdown: [{ label: "Tarifa base", cents: PRECIO_BASE }],
    });
  });

  it("el hold cobra con la tarifa del dia, no con la base (T12)", async () => {
    // Jueves 16: la tarifa de jueves (2500) cubre 08:00-22:00 y pistas de 90 minutos.
    // Las 08:00 del 16 ya estan ocupadas por el hold del test de limpieza perezosa, asi
    // que el hueco de las 09:30 es el que pide el socio.
    const respuesta = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-16T09:30",
        numPlayers: 4,
        playerName: "Socio",
      }),
      cookieDe(USUARIO_A),
    );
    expect(respuesta.status).toBe(201);
    const cuerpo = (await respuesta.json()) as HoldCreadoJson;
    expect(cuerpo.priceCents).toBe(2500);
    expect(cuerpo.priceBreakdown).toEqual([
      { label: "Tarifa Jueves Hold", cents: 2500 },
    ]);
  });

  it("la limpieza perezosa expira el hold caducado en la misma transaccion (4.4.1)", async () => {
    const primero = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-16T08:00",
        numPlayers: 4,
        playerName: "Socio Uno",
      }),
      cookieDe(USUARIO_A),
    );
    expect(primero.status).toBe(201);
    const idPrimero = ((await primero.json()) as HoldCreadoJson).id;

    // El hold caduca: se fuerza el reloj hacia el pasado como haria el paso del tiempo.
    await withAdmin(async (db) => {
      await db.query(
        `update public.bookings set hold_expires_at = now() - interval '1 minute' where id = $1`,
        [idPrimero],
      );
    });

    // Una segunda peticion al MISMO hueco: la limpieza perezosa corre dentro de su
    // transaccion y debe encontrar la pista libre. Es el test de la pieza 2 de la
    // spec 4.4.1: si el expirar fuese un CTE de una sola sentencia, el insert del hold
    // nuevo NO veria el update y el EXCLUDE devolveria un 409 que este test exige que no
    // exista.
    const segundo = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-16T08:00",
        numPlayers: 4,
        playerName: "Socio Dos",
      }),
      cookieDe(USUARIO_A),
    );
    expect(segundo.status).toBe(201);

    await withAdmin(async (db) => {
      const filas = await db.query<{ status: string }>(
        `select status from public.bookings
          where court_id = $1
            and starts_at = ($2::timestamp at time zone $3)
          order by status`,
        [PISTA_A, "2026-07-16 08:00", ZONA_A],
      );
      // Uno expirado (el primero) y uno held (el nuevo): dos filas, y SOLO la segunda
      // ocupa el hueco en la agenda.
      expect(filas.rows.map((f) => f.status)).toEqual(["expired", "held"]);
    });
  });

  it("sin cookie de sesion responde 401", async () => {
    const respuesta = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-19T08:00",
        numPlayers: 4,
        playerName: "Socio",
      }),
      null,
    );
    expect(respuesta.status).toBe(401);
  });

  it("un sub de sesion que no es una persona responde 401, en la base de la FK", async () => {
    // El uuid del `sub` no existe en `auth.users`: la FK de `bookings.user_id` es quien
    // lo dice. Es la reticencia sin firma que session.ts declara: un uuid que no hay
    // forma de validar de otra forma, y aqui la base lo rechaza.
    const respuesta = await crear(
      cuerpoDe({
        courtId: PISTA_A,
        startsAt: "2026-07-20T08:00",
        numPlayers: 4,
        playerName: "Socio",
      }),
      cookieDe(INVENTADO),
    );
    expect(respuesta.status).toBe(401);
  });

  it("un cuerpo malformado responde 400, campo a campo", async () => {
    const casos: ReadonlyArray<{ readonly cuerpo: unknown; readonly motivo: string }> = [
      { cuerpo: "no-es-json", motivo: "el cuerpo no es JSON" },
      { cuerpo: {}, motivo: "objecto" },
      { cuerpo: [1, 2], motivo: "array" },
      {
        cuerpo: { startsAt: "2026-07-21T08:00", numPlayers: 4, playerName: "S" },
        motivo: "courtId uuid",
      },
      {
        cuerpo: { courtId: "no-uuid", startsAt: "2026-07-21T08:00", numPlayers: 4, playerName: "S" },
        motivo: "courtId uuid",
      },
      {
        cuerpo: { courtId: PISTA_A, numPlayers: 4, playerName: "S" },
        motivo: "startsAt",
      },
      {
        cuerpo: { courtId: PISTA_A, startsAt: "2026-07-21T08:00Z", numPlayers: 4, playerName: "S" },
        motivo: "startsAt offset",
      },
      {
        cuerpo: { courtId: PISTA_A, startsAt: "2026-07-21T25:00", numPlayers: 4, playerName: "S" },
        motivo: "startsAt hora invalida",
      },
      {
        cuerpo: { courtId: PISTA_A, startsAt: "2026-02-30T08:00", numPlayers: 4, playerName: "S" },
        motivo: "startsAt fecha irreal",
      },
      {
        cuerpo: { courtId: PISTA_A, startsAt: "2026-07-21T08:00", numPlayers: 3, playerName: "S" },
        motivo: "numPlayers",
      },
      {
        cuerpo: { courtId: PISTA_A, startsAt: "2026-07-21T08:00", numPlayers: 4, playerName: "   " },
        motivo: "playerName",
      },
    ];

    for (const caso of casos) {
      const respuesta = await crear(cuerpoDe(caso.cuerpo), cookieDe(USUARIO_A));
      expect(respuesta.status).toBe(400);
      const cuerpo = (await respuesta.json()) as { error: string };
      expect(cuerpo.error).toContain("Peticion invalida");
    }
  });

  it("la pista de otro club da el mismo 404 que un uuid inexistente", async () => {
    const pistaB = await crear(
      cuerpoDe({
        courtId: PISTA_B,
        startsAt: "2026-07-22T08:00",
        numPlayers: 4,
        playerName: "Socio",
      }),
      cookieDe(USUARIO_A),
    );
    expect(pistaB.status).toBe(404);

    const inexistente = await crear(
      cuerpoDe({
        courtId: "00000000-0000-4000-8000-00000000deed",
        startsAt: "2026-07-22T08:00",
        numPlayers: 4,
        playerName: "Socio",
      }),
      cookieDe(USUARIO_A),
    );
    expect(inexistente.status).toBe(404);

    // El cuerpo es el MISMO: distinguirlos confirmaria que la pista del vecino existe.
    expect(await pistaB.json()).toEqual(await inexistente.json());
  });
});