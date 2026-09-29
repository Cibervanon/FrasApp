import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prepareDatabase, releaseDatabaseLease, withAdmin } from "../../../../../test/db-harness";
import { closePool } from "../../../../../lib/server/db";
import { clearTenantCache } from "../../../../../lib/server/tenant";
import type { StripeConnectClient } from "../../../../../lib/server/stripe-connect";
import { manejarCancelar } from "./route";

/**
 * T14b E2: `POST /api/bookings/[id]/cancel` (spec t14b-cancel-refund.md, casos 1-14).
 *
 * Postgres REAL y cliente de Stripe FALSO, como las rutas de T13 y T14: la ruta recibe
 * el cliente inyectado y lo que se comprueba de verdad es lo que no se puede simular
 * (RLS de `bookings`, titularidad, los guards de estado contra los `check` de la
 * migracion de T14, la politica de `tenant_content` y la liberacion del slot por el
 * `EXCLUDE`).
 *
 * Aqui NO se vuelve a probar la tabla de 5 tramos del motor (`cancelaciones.db.test.ts`
 * ya lo hace contra la fila y el jsonb): lo que se prueba es el contrato HTTP, que es
 * lo que unica la ruta.
 */

const TENANT = "00000000-0000-4000-8000-0000000007c0";
const SLUG = "club-t14b-cancel";
const DUENO = "00000000-0000-4000-8000-0000000007c1";
const GESTOR = "00000000-0000-4000-8000-0000000007c2";
const TERCERO = "00000000-0000-4000-8000-0000000007c3";

/** El importe de la reserva sembrada: 24,00 EUR. */
const PRECIO_CENTS = 2400;

/** El cuerpo 200 tal y como lo ve la pantalla de cancelar. */
const REEMBOLSO_TOTAL = {
  refund_id: expect.any(String),
  refund_cents: PRECIO_CENTS,
  tier_hours_before: 24,
  percent_applied: 100,
  label: "Cancelacion gratuita hasta 24h antes",
  pendiente: false,
};

function bookingId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Una pista por caso. El `EXCLUDE bookings_no_overlap` no deja dos filas vigentes en
 * la misma pista, y estos casos comparten `starts_at` relativo ("dentro de 25 horas"),
 * asi que separarlos por pista es lo que permite sembrarlos a la hora EXACTA que cada
 * caso necesita: el tramo de la politica depende de las horas que faltan, y aquí no
 * vale el truco del dia distinto que usa la ruta de pagos (mover la reserva unos dias
 * la echaria de cabeza al tramo del 100%).
 */
function pistaDe(n: number): string {
  return `00000000-0000-4000-9000-${n.toString(16).padStart(12, "0")}`;
}

function clienteFalso(): { client: StripeConnectClient; crearReembolso: ReturnType<typeof vi.fn> } {
  const crearReembolso = vi.fn(async (input: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }) => ({ refundId: `re_${input.idempotencyKey}` }));

  return {
    client: {
      crearCuentaExpress: vi.fn(async () => ({ id: "acct_falso_t14b_ruta" })),
      obtenerAccountLink: vi.fn(async () => "https://connect.stripe.com/setup/falso"),
      obtenerCuenta: vi.fn(async () => ({ chargesEnabled: true, payoutsEnabled: true })),
      crearPaymentIntent: vi.fn(async () => ({
        paymentIntentId: "pi_falso_t14b_ruta",
        clientSecret: "sk_falso_t14b_ruta",
      })),
      recuperarPaymentIntent: vi.fn(async (id: string) => ({
        paymentIntentId: id,
        clientSecret: "sk_falso_t14b_ruta",
      })),
      crearReembolso,
    },
    crearReembolso,
  };
}

function cookieCon(sub: string): string {
  return `frasapp_session=cabecera.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.firma`;
}

/** Una peticion con la cookie puesta (o sin ella) y, si se pasa, con cuerpo JSON. */
function peticionDe(sub: string | null, cuerpo?: unknown): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sub !== null) headers["cookie"] = cookieCon(sub);
  // El body va condicionado, no a `undefined`: con `exactOptionalPropertyTypes` una
  // propiedad presente con valor `undefined` no es un `RequestInit` valido.
  return new Request("http://localhost/api/bookings/x/cancel", {
    method: "POST",
    headers,
    ...(cuerpo === undefined ? {} : { body: JSON.stringify(cuerpo) }),
  });
}

function paramsDe(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

/** `starts_at` dentro de `horas` horas respecto a ahora. */
function dentroDe(horas: number): string {
  return new Date(Date.now() + horas * 3_600_000).toISOString();
}

/**
 * Siembra una reserva CONFIRMADA (o en el estado que pida el caso) en la pista del
 * caso, en el instante EXACTO que le pasa el llamante: el tramo de la politica lo
 * decide `hoursBefore`, y por eso no se toca la fecha.
 */
function sembrarReserva(fila: {
  id: string;
  status: "pending_payment" | "confirmed";
  paymentStatus: "unpaid" | "paid";
  intent: string;
  userId?: string;
  inicio: string;
}): Promise<void> {
  const n = parseInt(fila.id.slice(-12), 16);
  return withAdmin(async (db) => {
    const pista = pistaDe(n);
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
       values ($1, $2, $3, 'cristal', 2400) on conflict (id) do nothing`,
      [pista, TENANT, `Pista ${n}`],
    );
    const inicio = new Date(fila.inicio);
    const fin = new Date(inicio.getTime() + 90 * 60_000);
    await db.query(
      `insert into public.bookings
         (id, tenant_id, court_id, user_id,
          starts_at, ends_at, status, price_cents, currency, price_breakdown,
          num_players, player_name, stripe_payment_intent_id, payment_status)
       values
         ($1, $2, $3, $4, $5, $6, $7, $8, 'eur',
          '{"regla":"base","total_cents":2400}', 4, 'Socio de T14b',
          $9, $10)`,
      [
        fila.id,
        TENANT,
        pista,
        fila.userId ?? DUENO,
        inicio.toISOString(),
        fin.toISOString(),
        fila.status,
        PRECIO_CENTS,
        fila.intent,
        fila.paymentStatus,
      ],
    );
  });
}

async function filaDe(id: string) {
  return withAdmin(async (db) => {
    const filas = await db.query<{
      status: string;
      payment_status: string | null;
      amount_refunded_cents: number;
      refund_tier_hours_before: number | null;
      refund_percent_applied: number | null;
    }>(
      `select status, payment_status, amount_refunded_cents,
              refund_tier_hours_before, refund_percent_applied
         from public.bookings where id = $1`,
      [id],
    );
    const fila = filas.rows[0];
    if (fila === undefined) throw new Error(`No hay reserva '${id}' en la base.`);
    return fila;
  });
}

afterAll(async () => {
  await withAdmin(async (db) => {
    await db.query(`delete from public.bookings where tenant_id = $1`, [TENANT]);
    await db.query(`delete from auth.users where id = any($1::uuid[])`, [
      [DUENO, GESTOR, TERCERO],
    ]);
    await db.query(`delete from public.tenant_content where tenant_id = $1`, [TENANT]);
    await db.query(`delete from public.tenant_members where tenant_id = $1`, [TENANT]);
    await db.query(`delete from public.courts where tenant_id = $1`, [TENANT]);
    await db.query(`delete from public.tenants where id = $1`, [TENANT]);
  });
  await closePool();
  await releaseDatabaseLease();
});

beforeAll(async () => {
  await prepareDatabase();
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.tenants (id, name, slug) values ($1, 'Club T14b Cancel', $2)
       on conflict (id) do nothing`,
      [TENANT, SLUG],
    );
    for (const [id, email] of [
      [DUENO, "t14b-cancel-dueno@example.test"],
      [GESTOR, "t14b-cancel-gestor@example.test"],
      [TERCERO, "t14b-cancel-tercero@example.test"],
    ] as const) {
      await db.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [id, email],
      );
    }
    await db.query(
      `insert into public.tenant_members (tenant_id, user_id, role)
       values ($1, $2, 'gestor') on conflict (tenant_id, user_id) do nothing`,
      [TENANT, GESTOR],
    );
    await db.query(
      `insert into public.tenant_content (tenant_id, content_key, value)
       values ($1, 'cancellation_policy', $2::jsonb)`,
      [
        TENANT,
        JSON.stringify({
          tiers: [
            { hours_before: 24, refund_percent: 100, label: "Cancelacion gratuita hasta 24h antes" },
            { hours_before: 12, refund_percent: 50, label: "Entre 24h y 12h antes se devuelve el 50%" },
            { hours_before: 0, refund_percent: 0, label: "Con menos de 12h no hay devolucion" },
          ],
          policy_text: "Politica de T14b",
          notice_text: "Aviso de T14b",
        }),
      ],
    );
  });
  process.env["TENANT_SLUG"] = SLUG;
  clearTenantCache();
});

describe("T14b E2: POST /api/bookings/[id]/cancel", () => {
  it("caso 13: sin sesion -> 401 y cero efectos", async () => {
    const id = bookingId(1);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_sin_sesion",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(null), paramsDe(id), client);

    expect(respuesta.status).toBe(401);
    expect(crearReembolso).not.toHaveBeenCalled();
    expect((await filaDe(id)).status).toBe("confirmed");
  });

  it("un id que no es uuid -> 400", async () => {
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(DUENO), paramsDe("no-es-uuid"), client);

    expect(respuesta.status).toBe(400);
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("caso 1: el dueno cancela con 25h de margen y se le devuelve el total", async () => {
    const id = bookingId(2);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_25h_ruta",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(DUENO), paramsDe(id), client);

    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({
      estado: "cancelado",
      reembolso: REEMBOLSO_TOTAL,
    });
    expect(crearReembolso).toHaveBeenCalledWith({
      paymentIntentId: "pi_25h_ruta",
      amountCents: PRECIO_CENTS,
      idempotencyKey: `reembolso_${id}`,
    });
    const fila = await filaDe(id);
    expect(fila.status).toBe("cancelled");
    expect(fila.payment_status).toBe("refunded");
    expect(fila.amount_refunded_cents).toBe(PRECIO_CENTS);
    expect(fila.refund_tier_hours_before).toBe(24);
    expect(fila.refund_percent_applied).toBe(100);
  });

  it("caso 7: un gestor que no es el dueno puede cancelar", async () => {
    const id = bookingId(3);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_gestor_ruta",
      inicio: dentroDe(25),
    });
    const { client } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(GESTOR), paramsDe(id), client);

    expect(respuesta.status).toBe(200);
    expect((await filaDe(id)).status).toBe("cancelled");
  });

  it("caso 6: un tercero recibe 404 y no hay ni Stripe ni update", async () => {
    const id = bookingId(4);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_tercero_ruta",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(TERCERO), paramsDe(id), client);

    expect(respuesta.status).toBe(404);
    expect(crearReembolso).not.toHaveBeenCalled();
    const fila = await filaDe(id);
    expect(fila.status).toBe("confirmed");
    expect(fila.payment_status).toBe("paid");
    expect(fila.amount_refunded_cents).toBe(0);
  });

  it("una reserva inexistente -> 404", async () => {
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(DUENO), paramsDe(bookingId(90)), client);

    expect(respuesta.status).toBe(404);
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("caso 8: cancelar dos veces -> la segunda es 409 y no vuelve a pagar dos veces", async () => {
    const id = bookingId(5);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_doble_ruta",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const primera = await manejarCancelar(peticionDe(DUENO), paramsDe(id), client);
    expect(primera.status).toBe(200);

    const segunda = await manejarCancelar(peticionDe(DUENO), paramsDe(id), client);

    expect(segunda.status).toBe(409);
    await expect(segunda.json()).resolves.toMatchObject({ code: "transicion_invalida" });
    expect(crearReembolso).toHaveBeenCalledTimes(1);
    expect((await filaDe(id)).amount_refunded_cents).toBe(PRECIO_CENTS);
  });

  it("caso 9: una reserva ya empezada -> 422 sin llamar a Stripe", async () => {
    const id = bookingId(6);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_pasada_ruta",
      inicio: dentroDe(-1),
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(DUENO), paramsDe(id), client);

    expect(respuesta.status).toBe(422);
    await expect(respuesta.json()).resolves.toMatchObject({ code: "reserva_pasada" });
    expect(crearReembolso).not.toHaveBeenCalled();
    expect((await filaDe(id)).status).toBe("confirmed");
  });

  it("caso 10: una reserva en pending_payment -> 409 (el cobro esta en curso)", async () => {
    const id = bookingId(7);
    await sembrarReserva({
      id,
      status: "pending_payment",
      paymentStatus: "unpaid",
      intent: "pi_en_curso_ruta",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(DUENO), paramsDe(id), client);

    expect(respuesta.status).toBe(409);
    expect(crearReembolso).not.toHaveBeenCalled();
    expect((await filaDe(id)).status).toBe("pending_payment");
  });

  it("caso 5: 5h antes -> 0%, sin llamada a Stripe y el pago sigue 'paid'", async () => {
    const id = bookingId(8);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_5h_ruta",
      inicio: dentroDe(5),
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(peticionDe(DUENO), paramsDe(id), client);

    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({
      estado: "cancelado",
      reembolso: {
        refund_id: null,
        refund_cents: 0,
        tier_hours_before: 0,
        percent_applied: 0,
        label: "Con menos de 12h no hay devolucion",
        pendiente: false,
      },
    });
    expect(crearReembolso).not.toHaveBeenCalled();
    const fila = await filaDe(id);
    expect(fila.status).toBe("cancelled");
    expect(fila.payment_status).toBe("paid");
    expect(fila.amount_refunded_cents).toBe(0);
    expect(fila.refund_tier_hours_before).toBe(0);
    expect(fila.refund_percent_applied).toBe(0);
  });

  it("caso 12: un importe en el cuerpo se descarta (manda el motor)", async () => {
    const id = bookingId(9);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_body_ruta",
      inicio: dentroDe(20),
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarCancelar(
      peticionDe(DUENO, { amount_cents: 999_999, refund_percent: 100, motivo: "se me ha pasado" }),
      paramsDe(id),
      client,
    );

    expect(respuesta.status).toBe(200);
    // 20h antes cae en el tramo del 50%: si el cuerpo mandara, serian 999.999 centimos.
    expect(crearReembolso).toHaveBeenCalledWith(expect.objectContaining({ amountCents: 1200 }));
    const fila = await filaDe(id);
    expect(fila.amount_refunded_cents).toBe(1200);
    expect(fila.refund_percent_applied).toBe(50);
  });

  it("caso 11: si Stripe falla, el 200 dice que el reembolso queda pendiente", async () => {
    const id = bookingId(10);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_caido_ruta",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();
    crearReembolso.mockRejectedValueOnce(new Error("stripe caido"));

    const respuesta = await manejarCancelar(peticionDe(DUENO), paramsDe(id), client);

    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({
      estado: "cancelado",
      reembolso: {
        refund_id: null,
        refund_cents: PRECIO_CENTS,
        tier_hours_before: 24,
        percent_applied: 100,
        label: "Cancelacion gratuita hasta 24h antes",
        pendiente: true,
      },
    });
    const fila = await filaDe(id);
    expect(fila.status).toBe("cancelled");
    expect(fila.payment_status).toBe("paid");
    expect(fila.amount_refunded_cents).toBe(0);
    expect(fila.refund_tier_hours_before).toBe(24);
  });

  it("caso 14: tras cancelar, la pista vuelve (el EXCLUDE deja de tapar)", async () => {
    const id = bookingId(11);
    await sembrarReserva({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_slot_ruta",
      inicio: dentroDe(40),
    });
    const { client } = clienteFalso();
    const cancelada = await manejarCancelar(peticionDe(DUENO), paramsDe(id), client);
    expect(cancelada.status).toBe(200);

    // Un hold nuevo en el MISMO slot tiene que entrar: si la cancelacion no hubiera
    // soltado la fila, el `EXCLUDE bookings_no_overlap` rechazaria este insert.
    const reutilizable = await withAdmin(async (db) => {
      const original = await db.query<{ starts_at: string; ends_at: string }>(
        `select starts_at, ends_at from public.bookings where id = $1`,
        [id],
      );
      const ventana = original.rows[0];
      if (ventana === undefined) throw new Error(`No hay reserva '${id}'.`);
      const fin = new Date(new Date(ventana.ends_at).getTime() + 60 * 60_000);
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status, hold_expires_at,
            price_cents, currency, price_breakdown, num_players, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', now() + interval '3 minutes',
                 $7, 'eur', '{"regla":"base","total_cents":2400}', 4, 'Socio de T14b')`,
        [
          bookingId(12),
          TENANT,
          pistaDe(11),
          DUENO,
          ventana.starts_at,
          fin.toISOString(),
          PRECIO_CENTS,
        ],
      );
      return true;
    });

    expect(reutilizable).toBe(true);
  });
});
