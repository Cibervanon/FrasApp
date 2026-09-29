import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prepareDatabase, releaseDatabaseLease, withAdmin } from "../../../test/db-harness";
import { closePool } from "../../../lib/server/db";
import { clearTenantCache } from "../../../lib/server/tenant";
import {
  COMISION_PLATAFORMA_CENTS,
  type StripeConnectClient,
} from "../../../lib/server/stripe-connect";
import { manejarIntent } from "./intent/route";

/**
 * T14 E2: `POST /api/payments/intent` (spec t14-payment-intent.md, casos 7-16).
 *
 * Postgres REAL y cliente de Stripe FALSO, como el arnes de T13. La ruta inyecta el
 * cliente (manejarIntent), y lo unico que es de verdad es lo que se debe poder defender
 * sin simular: la RLS de bookings (hold ajeno = 404), la coherencia nueva de T14 (los
 * checks de la migracion E1 no dejan meter una pendiente ya pagada), la lectura del
 * snapshot del precio y el estado de cobro del tenant.
 *
 * EL TENANT ES PROPIO, como en T13: `TENANT_SLUG` apunta a un slug de este fichero que
 * siembra su propio tenant, su socio y su pista, y lo borra al final.
 */

const TENANT_INT = "00000000-0000-4000-8000-0000000007a0";
const SLUG_INT = "club-t14-intent";
const SOCIO = "00000000-0000-4000-8000-0000000007a1";
const VECINO = "00000000-0000-4000-8000-0000000007a2";
const COURT_INT = "00000000-0000-4000-8000-0000000007a3";

/** El id de la cuenta Express del club en el fake. */
const CUENTA_CLUB = "acct_intent_falso";
/** El importe de la reserva sembrada: 24,00 EUR. */
const PRECIO_CENTS = 2400;

interface FilaSembrada {
  readonly id: string;
  readonly status: string;
  readonly user_id?: string;
  readonly hold_expires_at?: string | null;
  readonly stripe_payment_intent_id?: string | null;
  readonly payment_status?: string | null;
}

function bookingId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Un cliente falso que recuerda con que argumentos se le llamo. */
function clienteFalso() {
  // El id del intent es UNICO por booking (se deriva de la Idempotency-Key, que es el
  // id del hold): el indice unico de E1 no deja que dos reservas del mismo club usen el
  // mismo intent, igual que no lo dejaria Stripe con ids reales.
  const crearPaymentIntent = vi.fn(async (input: { idempotencyKey: string }) => ({
    paymentIntentId: `pi_falso_${input.idempotencyKey.slice(-4)}`,
    clientSecret: "sk_secret_falso",
  }));
  const recuperarPaymentIntent = vi.fn(async (id: string) => ({
    paymentIntentId: id,
    clientSecret: "sk_secret_falso",
  }));
  return {
    client: {
      crearCuentaExpress: vi.fn(async () => ({ id: CUENTA_CLUB })),
      obtenerAccountLink: vi.fn(async () => "https://connect.stripe.com/setup/falso"),
      obtenerCuenta: vi.fn(async () => ({ chargesEnabled: true, payoutsEnabled: false })),
      crearPaymentIntent,
      recuperarPaymentIntent,
      // T14b: las rutas de pago no reembolsan, pero el contrato lo exige.
      crearReembolso: vi.fn(async () => ({ refundId: "re_falso" })),
    } satisfies StripeConnectClient & {
      crearPaymentIntent: ReturnType<typeof vi.fn>;
      recuperarPaymentIntent: ReturnType<typeof vi.fn>;
    },
    crearPaymentIntent,
    recuperarPaymentIntent,
  };
}

/** Siembra un booking del SOCIO en el estado que pida el caso (y en el tenant del fichero). */
async function sembrarBooking(fila: FilaSembrada): Promise<void> {
  // Cada booking sembrado cae en SU PROPIO DIA: el EXCLUDE de bookings no deja dos
  // filas vigentes en la misma pista, y todos estos fixtures comparten la pista. El
  // dia sale de las ultimas cifras del id, asi que es determinista y unico por caso.
  const dia = parseInt(fila.id.slice(-2), 16);
  const inicio = new Date(Date.UTC(2026, 11, dia, 18, 0));
  const fin = new Date(inicio.getTime() + 90 * 60_000);
  const habitosFin = fila.status === "held" ? " now() + interval '3 minutes'" : "null";
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.bookings
         (id, tenant_id, court_id, user_id,
          starts_at, ends_at, status, hold_expires_at,
          price_cents, currency, price_breakdown, num_players, player_name,
          stripe_payment_intent_id, payment_status, confirmed_at, cancelled_at)
       values
         ($1, $2, $3, $4,
          $5, $6, $7, ${habitosFin},
          $8, 'eur', '{"regla":"base","total_cents":2400}', 4, 'Socio de T14',
          $9, $10, null, null)`,
      [
        fila.id,
        TENANT_INT,
        COURT_INT,
        fila.user_id ?? SOCIO,
        inicio.toISOString(),
        fin.toISOString(),
        fila.status,
        PRECIO_CENTS,
        fila.stripe_payment_intent_id ?? null,
        fila.payment_status ?? null,
      ],
    );
  });
}

function cookieCon(sub: string): string {
  return `frasapp_session=cabecera.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.firma`;
}

function peticionDe(sub: string | null, cuerpo: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sub !== null) headers["cookie"] = cookieCon(sub);
  return new Request("http://localhost/api/payments/intent", {
    method: "POST",
    headers,
    body: JSON.stringify(cuerpo),
  });
}

async function estadoDe(id: string) {
  return withAdmin(async (db) => {
    const filas = await db.query<{
      status: string;
      payment_status: string | null;
      hold_expires_at: string | null;
      stripe_payment_intent_id: string | null;
    }>(
      `select status, payment_status, hold_expires_at, stripe_payment_intent_id
         from public.bookings where id = $1`,
      [id],
    );
    return filas.rows[0];
  });
}

async function fijarEstadoCobro(accountId: string | null, charges: boolean): Promise<void> {
  await withAdmin(async (db) => {
    await db.query(
      `update public.tenants
          set stripe_account_id = $1,
              stripe_charges_enabled = $2
        where id = $3`,
      [accountId, charges, TENANT_INT],
    );
  });
}

afterAll(async () => {
  await withAdmin(async (db) => {
    await db.query(`delete from public.bookings where tenant_id = $1`, [TENANT_INT]);
    await db.query(`delete from auth.users where id = any($1::uuid[])`, [[SOCIO, VECINO]]);
    await db.query(`delete from public.tenants where id = $1`, [TENANT_INT]);
  });
  await closePool();
  await releaseDatabaseLease();
});

beforeAll(async () => {
  await prepareDatabase();
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.tenants (id, name, slug) values ($1, 'Club T14 Intent', $2)
       on conflict (id) do nothing`,
      [TENANT_INT, SLUG_INT],
    );
    for (const [id, email] of [
      [SOCIO, "t14-socio@example.test"],
      [VECINO, "t14-vecino@example.test"],
    ] as const) {
      await db.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [id, email],
      );
    }
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
       values ($1, $2, 'Pista A', 'cristal', 2400)
       on conflict (id) do nothing`,
      [COURT_INT, TENANT_INT],
    );
  });
  await fijarEstadoCobro(CUENTA_CLUB, true);
  process.env["NEXT_PUBLIC_APP_URL"] = process.env["NEXT_PUBLIC_APP_URL"] || "http://localhost:3000";
  process.env["TENANT_SLUG"] = SLUG_INT;
  clearTenantCache();
});

describe("T14 E2: POST /api/payments/intent", () => {
  it("sin sesion: 401", async () => {
    const { client } = clienteFalso();
    const respuesta = await manejarIntent(peticionDe(null, { hold_id: bookingId(1) }), client);
    expect(respuesta.status).toBe(401);
  });

  it("hold que no es mio (otro socio): 404, sin confirmar que existe", async () => {
    await sembrarBooking({ id: bookingId(10), status: "held", user_id: VECINO });
    const { client } = clienteFalso();
    const respuesta = await manejarIntent(
      peticionDe(SOCIO, { hold_id: bookingId(10) }),
      client,
    );
    expect(respuesta.status).toBe(404);
  });

  it("hold caducado (expired): 409 con code hold_expired y sin llamadas a Stripe", async () => {
    await sembrarBooking({
      id: bookingId(11),
      status: "expired",
      hold_expires_at: "2020-01-01T00:00:00Z",
    });
    const { client, crearPaymentIntent, recuperarPaymentIntent } = clienteFalso();
    const respuesta = await manejarIntent(
      peticionDe(SOCIO, { hold_id: bookingId(11) }),
      client,
    );
    expect(respuesta.status).toBe(409);
    expect(((await respuesta.json()) as { code?: string }).code).toBe("hold_expired");
    expect(crearPaymentIntent).not.toHaveBeenCalled();
    expect(recuperarPaymentIntent).not.toHaveBeenCalled();
  });

  it("club sin cuenta Express: 503 tenant_payments_not_ready y cero llamadas a Stripe", async () => {
    await sembrarBooking({ id: bookingId(12), status: "held" });
    await fijarEstadoCobro(null, true);
    const { client, crearPaymentIntent, recuperarPaymentIntent } = clienteFalso();
    try {
      const respuesta = await manejarIntent(
        peticionDe(SOCIO, { hold_id: bookingId(12) }),
        client,
      );
      expect(respuesta.status).toBe(503);
      expect(((await respuesta.json()) as { code?: string }).code).toBe(
        "tenant_payments_not_ready",
      );
      expect(crearPaymentIntent).not.toHaveBeenCalled();
      expect(recuperarPaymentIntent).not.toHaveBeenCalled();
    } finally {
      await fijarEstadoCobro(CUENTA_CLUB, true);
    }
  });

  it("club con charges deshabilitadas: 503 tenant_payments_not_ready y cero llamadas", async () => {
    await sembrarBooking({ id: bookingId(13), status: "held" });
    await fijarEstadoCobro(CUENTA_CLUB, false);
    const { client, crearPaymentIntent, recuperarPaymentIntent } = clienteFalso();
    try {
      const respuesta = await manejarIntent(
        peticionDe(SOCIO, { hold_id: bookingId(13) }),
        client,
      );
      expect(respuesta.status).toBe(503);
      expect(((await respuesta.json()) as { code?: string }).code).toBe(
        "tenant_payments_not_ready",
      );
      expect(crearPaymentIntent).not.toHaveBeenCalled();
      expect(recuperarPaymentIntent).not.toHaveBeenCalled();
    } finally {
      await fijarEstadoCobro(CUENTA_CLUB, true);
    }
  });

  it("camino feliz: intent por el snapshot, destino del club, y el hold pasa a pending_payment", async () => {
    await sembrarBooking({ id: bookingId(14), status: "held" });
    const { client, crearPaymentIntent } = clienteFalso();
    const respuesta = await manejarIntent(
      peticionDe(SOCIO, { hold_id: bookingId(14) }),
      client,
    );
    expect(respuesta.status).toBe(200);
    const cuerpo = (await respuesta.json()) as {
      payment_intent_id: string;
      client_secret: string;
    };
    expect(cuerpo.payment_intent_id).toBe("pi_falso_000e");
    expect(cuerpo.client_secret).toBe("sk_secret_falso");

    expect(crearPaymentIntent).toHaveBeenCalledTimes(1);
    expect(crearPaymentIntent).toHaveBeenCalledWith({
      amountCents: PRECIO_CENTS,
      currency: "eur",
      destination: CUENTA_CLUB,
      idempotencyKey: bookingId(14),
    });

    const fila = await estadoDe(bookingId(14));
    expect(fila?.status).toBe("pending_payment");
    expect(fila?.payment_status).toBe("unpaid");
    expect(fila?.hold_expires_at).toBeNull();
    expect(fila?.stripe_payment_intent_id).toBe("pi_falso_000e");
  });

  it("un importe en el body se descarta: el intent usa el snapshot del booking", async () => {
    await sembrarBooking({ id: bookingId(15), status: "held" });
    const { client, crearPaymentIntent } = clienteFalso();
    const respuesta = await manejarIntent(
      peticionDe(SOCIO, { hold_id: bookingId(15), amount_cents: 1 }),
      client,
    );
    expect(respuesta.status).toBe(200);
    expect(crearPaymentIntent).toHaveBeenCalledWith(
      expect.objectContaining({ amountCents: PRECIO_CENTS }),
    );
  });

  it("doble POST del mismo hold: el segundo recupera, mismo id, y crear se llama UNA vez", async () => {
    await sembrarBooking({ id: bookingId(16), status: "held" });
    const { client, crearPaymentIntent, recuperarPaymentIntent } = clienteFalso();

    const primero = await manejarIntent(
      peticionDe(SOCIO, { hold_id: bookingId(16) }),
      client,
    );
    const segundo = await manejarIntent(
      peticionDe(SOCIO, { hold_id: bookingId(16) }),
      client,
    );

    expect(primero.status).toBe(200);
    expect(segundo.status).toBe(200);
    const cuerpoPrimero = (await primero.json()) as {
      payment_intent_id: string;
      client_secret: string;
    };
    const cuerpoSegundo = (await segundo.json()) as {
      payment_intent_id: string;
      client_secret: string;
    };
    expect(cuerpoSegundo.payment_intent_id).toBe(cuerpoPrimero.payment_intent_id);
    expect(cuerpoSegundo.client_secret).toBe(cuerpoPrimero.client_secret);

    expect(crearPaymentIntent).toHaveBeenCalledTimes(1);
    expect(recuperarPaymentIntent).toHaveBeenCalledTimes(1);
    expect(recuperarPaymentIntent).toHaveBeenCalledWith(cuerpoPrimero.payment_intent_id);
  });

  it("booking ya confirmado (pago recibido): 200 con estado paid y sin pedir secret", async () => {
    await sembrarBooking({
      id: bookingId(17),
      status: "confirmed",
      stripe_payment_intent_id: "pi_falso_pagado",
      payment_status: "paid",
    });
    const { client, crearPaymentIntent, recuperarPaymentIntent } = clienteFalso();
    const respuesta = await manejarIntent(
      peticionDe(SOCIO, { hold_id: bookingId(17) }),
      client,
    );
    expect(respuesta.status).toBe(200);
    const cuerpo = (await respuesta.json()) as {
      payment_intent_id: string;
      estado: string;
    };
    expect(cuerpo.payment_intent_id).toBe("pi_falso_pagado");
    expect(cuerpo.estado).toBe("paid");
    expect(crearPaymentIntent).not.toHaveBeenCalled();
    expect(recuperarPaymentIntent).not.toHaveBeenCalled();
  });

  it("la comision de plataforma esta anclada a 0 (T14-D): no hay field extra que inventar", () => {
    expect(COMISION_PLATAFORMA_CENTS).toBe(0);
  });

  it("un hold ya cancelado: 409 de transicion invalida", async () => {
    await sembrarBooking({
      id: bookingId(18),
      status: "cancelled",
      payment_status: null,
    });
    const { client, crearPaymentIntent } = clienteFalso();
    const respuesta = await manejarIntent(
      peticionDe(SOCIO, { hold_id: bookingId(18) }),
      client,
    );
    expect(respuesta.status).toBe(409);
    expect(crearPaymentIntent).not.toHaveBeenCalled();
  });
});