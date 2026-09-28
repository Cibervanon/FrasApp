import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "../route";
import { DELETE } from "./route";
import { GET } from "../../availability/route";
import { closePool } from "../../../../lib/server/db";
import { clearTenantCache } from "../../../../lib/server/tenant";
import {
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
} from "../../../../test/db-harness";

/**
 * T11: `DELETE /api/holds/[id]` - liberar un hold propio.
 *
 * ---------------------------------------------------------------------------------------
 * MISMAS REGLAS QUE EL FICHERO DE POST
 * El hold se crea por HTTP (commitea) con la cookie del socio, y el DELETE va contra esa
 * id. La "otra cara" del 404 solo existe porque la RLS aisla al club: el hold del vecino
 * es una fila real, pero la consulta de un socio de A ni la ve. Por eso el criterio no es
 * el STATUS sino el CUERPO IGUAL al de un uuid inventado (mismo patron que T5d).
 */

const TENANT_A = "00000000-0000-4000-8000-0000000006a0";
const SLUG_A = "club-t11-a";
const TENANT_B = "00000000-0000-4000-8000-0000000006a1";
const SLUG_B = "club-t11-b";

const PISTA_A = "00000000-0000-4000-8000-0000000006a2";
const PISTA_B = "00000000-0000-4000-8000-0000000006a3";

const USUARIO_A = "00000000-0000-4000-8000-0000000006a4";
const USUARIO_B = "00000000-0000-4000-8000-0000000006a5";

const TENANTES = [TENANT_A, TENANT_B];
const PISTAS = [PISTA_A, PISTA_B];
const USUARIOS = [USUARIO_A, USUARIO_B];

const ZONA_A = "Europe/Madrid";
const ZONA_B = "America/Mexico_City";
const PRECIO_BASE = 1200;

function cookieDe(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `frasapp_session=cabecera.${payload}.firma`;
}

async function crearHold(fecha: string, cookie: string): Promise<string> {
  const respuesta = await POST(
    new Request("http://localhost:3000/api/holds", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        cookie,
      },
      body: JSON.stringify({
        courtId: PISTA_A,
        startsAt: `${fecha}T08:00`,
        numPlayers: 4,
        playerName: "Socio Uno",
      }),
    }),
  );
  expect(respuesta.status).toBe(201);
  return ((await respuesta.json()) as { id: string }).id;
}

async function borrar(id: string, cookie: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (cookie !== null) headers["cookie"] = cookie;
  return DELETE(
    new Request(`http://localhost:3000/api/holds/${id}`, {
      method: "DELETE",
      headers,
    }),
    { params: Promise.resolve({ id }) },
  );
}

function apuntarA(slug: string): void {
  process.env["TENANT_SLUG"] = slug;
  clearTenantCache();
}

function placeholders(ids: readonly string[]): string {
  return ids.map((_, index) => `$${index + 1}`).join(", ");
}

async function huecosDePista(fecha: string): Promise<readonly string[]> {
  const respuesta = await GET(
    new Request(
      `http://localhost:3000/api/availability?court_id=${PISTA_A}&date=${fecha}`,
    ),
  );
  expect(respuesta.status).toBe(200);
  const cuerpo = (await respuesta.json()) as {
    slots: ReadonlyArray<{ startsAt: string }>;
  };
  return cuerpo.slots.map((slot) => slot.startsAt);
}

beforeAll(async () => {
  await prepareDatabase();

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

describe("T11: liberar un hold", () => {
  it("libera el hold propio: 200 'cancelled' y el hueco vuelve a la agenda", async () => {
    const id = await crearHold("2026-07-24", cookieDe(USUARIO_A));

    const respuesta = await borrar(id, cookieDe(USUARIO_A));
    expect(respuesta.status).toBe(200);
    const cuerpo = (await respuesta.json()) as { status: string };
    expect(cuerpo.status).toBe("cancelled");

    await withAdmin(async (db) => {
      const filas = await db.query<{ status: string; cancelled_at: unknown }>(
        `select status, cancelled_at from public.bookings where id = $1`,
        [id],
      );
      expect(filas.rows[0]?.status).toBe("cancelled");
      expect(filas.rows[0]?.cancelled_at).not.toBeNull();
    });

    // El hueco de las 08:00 vuelve a ser libre para el resto de la agenda.
    expect(await huecosDePista("2026-07-24")).toContain("2026-07-24T08:00");
  });

  it("el hold del vecino da el mismo 404 que un uuid inventado", async () => {
    // Un hold REAL del club B: fila visible solo para B. Un socio de A no debe poder
    // distinguirlo de uno inexistente.
    await withAdmin(async (db) => {
      await db.query(
        `insert into public.bookings
           (tenant_id, court_id, user_id, starts_at, ends_at, status,
            hold_expires_at, price_cents, price_breakdown, num_players,
            player_name, is_minor)
         values ($1, $2, $3,
                 ($4::timestamp at time zone $5),
                 (($4::timestamp + interval '90 minutes') at time zone $5),
                 'held', now() + interval '3 minutes', ${PRECIO_BASE}, '[]',
                 4, 'Socio del B', false)`,
        [TENANT_B, PISTA_B, USUARIO_B, "2026-07-25 08:00", ZONA_B],
      );
    });
    const idVecino = await withAdmin(async (db) => {
      const filas = await db.query<{ id: string }>(
        `select id from public.bookings where court_id = $1 limit 1`,
        [PISTA_B],
      );
      const id = filas.rows[0]?.id;
      if (id === undefined) throw new Error("El hold del vecino no se creo");
      return id;
    });

    const borrarVecino = await borrar(idVecino, cookieDe(USUARIO_A));
    const borrarInvencion = await borrar(
      "00000000-0000-4000-8000-00000000deed",
      cookieDe(USUARIO_A),
    );

    expect(borrarVecino.status).toBe(404);
    expect(borrarInvencion.status).toBe(404);
    expect(await borrarVecino.json()).toEqual(await borrarInvencion.json());
  });

  it("un hold que ya no esta 'held' no se puede cancelar: 409", async () => {
    const id = await crearHold("2026-07-26", cookieDe(USUARIO_A));

    // El pago lo confirma el admin: el socio ya no retiene, ha pagado.
    await withAdmin(async (db) => {
      await db.query(
        `update public.bookings set status = 'confirmed', confirmed_at = now(), payment_status = 'paid' where id = $1`,
        [id],
      );
    });

    const respuesta = await borrar(id, cookieDe(USUARIO_A));
    expect(respuesta.status).toBe(409);
  });

  it("sin cookie de sesion responde 401", async () => {
    const id = await crearHold("2026-07-27", cookieDe(USUARIO_A));
    const respuesta = await borrar(id, null);
    expect(respuesta.status).toBe(401);
  });

  it("una id que no es uuid responde 400", async () => {
    const respuesta = await borrar("no-es-uuid", cookieDe(USUARIO_A));
    expect(respuesta.status).toBe(400);
  });
});