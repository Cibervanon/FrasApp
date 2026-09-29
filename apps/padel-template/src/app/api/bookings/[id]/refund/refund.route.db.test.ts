import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prepareDatabase, releaseDatabaseLease, withAdmin } from "../../../../../test/db-harness";
import { closePool } from "../../../../../lib/server/db";
import { clearTenantCache } from "../../../../../lib/server/tenant";
import type { StripeConnectClient } from "../../../../../lib/server/stripe-connect";
import { manejarReembolso } from "./route";
import { manejarCancelar } from "../cancel/route";

/**
 * T14b E3: `POST /api/bookings/[id]/refund` (spec t14b-cancel-refund.md, casos 15-19).
 *
 * El reintento del gestor. Lo que esta ruta tiene que defender, y que por eso va con
 * Postgres real y cliente de Stripe falso:
 *
 *  - SOLO reembolsa lo que la cancelacion dejo a medias: `cancelled` + `paid` +
 *    `amount_refunded_cents = 0`. Ni una confirmada, ni una cancelada sin pagar, ni una
 *    ya reembolsada.
 *  - El importe sale del SNAPSHOT (`refund_percent_applied`), no de la politica de
 *    ahora: por eso el caso de Stripe caido es aqui decia, y no una copia de la fila
 *    sembrada a mano.
 */

const TENANT = "00000000-0000-4000-8000-0000000007d0";
const SLUG = "club-t14b-refund";
const DUENO = "00000000-0000-4000-8000-0000000007d1";
const GESTOR = "00000000-0000-4000-8000-0000000007d2";
const TERCERO = "00000000-0000-4000-8000-0000000007d3";

const PRECIO_CENTS = 2400;

function bookingId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** Una pista por caso: el `EXCLUDE` no deja dos filas vigentes en la misma (ver test de E2). */
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
      crearCuentaExpress: vi.fn(async () => ({ id: "acct_falso_t14b_reembolso" })),
      obtenerAccountLink: vi.fn(async () => "https://connect.stripe.com/setup/falso"),
      obtenerCuenta: vi.fn(async () => ({ chargesEnabled: true, payoutsEnabled: true })),
      crearPaymentIntent: vi.fn(async () => ({
        paymentIntentId: "pi_falso_t14b_reembolso",
        clientSecret: "sk_falso_t14b_reembolso",
      })),
      recuperarPaymentIntent: vi.fn(async (id: string) => ({
        paymentIntentId: id,
        clientSecret: "sk_falso_t14b_reembolso",
      })),
      crearReembolso,
    },
    crearReembolso,
  };
}

function cookieCon(sub: string): string {
  return `frasapp_session=cabecera.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.firma`;
}

function peticionDe(sub: string | null, ruta = "refund"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sub !== null) headers["cookie"] = cookieCon(sub);
  return new Request(`http://localhost/api/bookings/x/${ruta}`, { method: "POST", headers });
}

function paramsDe(id: string): { params: Promise<{ id: string }> } {
  return { params: Promise.resolve({ id }) };
}

function dentroDe(horas: number): string {
  return new Date(Date.now() + horas * 3_600_000).toISOString();
}

/** Siembra una reserva ya CANCELADA, con el snapshot que dejo la cancelacion. */
function sembrarCancelada(fila: {
  id: string;
  paymentStatus: "unpaid" | "paid" | "refunded";
  amountRefunded: number;
  percent: number | null;
  tier: number | null;
  intent: string;
  userId?: string;
  status?: "cancelled" | "confirmed";
}): Promise<void> {
  const n = parseInt(fila.id.slice(-12), 16);
  return withAdmin(async (db) => {
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
       values ($1, $2, $3, 'cristal', 2400) on conflict (id) do nothing`,
      [pistaDe(n), TENANT, `Pista ${n}`],
    );
    const inicio = new Date(Date.now() + 30 * 3_600_000);
    const fin = new Date(inicio.getTime() + 90 * 60_000);
    await db.query(
      `insert into public.bookings
         (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
          price_cents, currency, price_breakdown, num_players, player_name,
          stripe_payment_intent_id, payment_status, amount_refunded_cents,
          refund_tier_hours_before, refund_percent_applied,
          cancelled_at, confirmed_at)
       values
         ($1, $2, $3, $4, $5, $6, $7,
          $8, 'eur', '{"regla":"base","total_cents":2400}', 4, 'Socio de T14b',
          $9, $10, $11, $12, $13, $14, null)`,
      [
        fila.id,
        TENANT,
        pistaDe(n),
        fila.userId ?? DUENO,
        inicio.toISOString(),
        fin.toISOString(),
        fila.status ?? "cancelled",
        PRECIO_CENTS,
        fila.intent,
        fila.paymentStatus,
        fila.amountRefunded,
        fila.tier,
        fila.percent,
        fila.status === "confirmed" ? null : new Date().toISOString(),
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
      refund_percent_applied: number | null;
    }>(
      `select status, payment_status, amount_refunded_cents, refund_percent_applied
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
      `insert into public.tenants (id, name, slug) values ($1, 'Club T14b Refund', $2)
       on conflict (id) do nothing`,
      [TENANT, SLUG],
    );
    for (const [id, email] of [
      [DUENO, "t14b-refund-dueno@example.test"],
      [GESTOR, "t14b-refund-gestor@example.test"],
      [TERCERO, "t14b-refund-tercero@example.test"],
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

describe("T14b E3: POST /api/bookings/[id]/refund", () => {
  it("sin sesion -> 401", async () => {
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarReembolso(peticionDe(null), paramsDe(bookingId(1)), client);

    expect(respuesta.status).toBe(401);
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("un id que no es uuid -> 400", async () => {
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarReembolso(peticionDe(GESTOR), paramsDe("no-es-uuid"), client);

    expect(respuesta.status).toBe(400);
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("caso 15: una cancelada con el 50% pendiente devuelve ese mismo 50%", async () => {
    const id = bookingId(2);
    await sembrarCancelada({
      id,
      paymentStatus: "paid",
      amountRefunded: 0,
      percent: 50,
      tier: 12,
      intent: "pi_reintento_50",
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), client);

    expect(respuesta.status).toBe(200);
    await expect(respuesta.json()).resolves.toEqual({
      estado: "reembolsado",
      reembolso: {
        refund_id: `re_reembolso_${id}`,
        refund_cents: 1200,
        tier_hours_before: 12,
        percent_applied: 50,
        label: null,
      },
    });
    expect(crearReembolso).toHaveBeenCalledWith({
      paymentIntentId: "pi_reintento_50",
      amountCents: 1200,
      idempotencyKey: `reembolso_${id}`,
    });
    const fila = await filaDe(id);
    expect(fila.payment_status).toBe("refunded");
    expect(fila.amount_refunded_cents).toBe(1200);
  });

  it("caso 16: un segundo reintento -> 409 y el dinero no se duplica", async () => {
    const id = bookingId(3);
    await sembrarCancelada({
      id,
      paymentStatus: "paid",
      amountRefunded: 0,
      percent: 100,
      tier: 24,
      intent: "pi_reintento_doble",
    });
    const { client, crearReembolso } = clienteFalso();
    const primera = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), client);
    expect(primera.status).toBe(200);

    const segunda = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), client);

    expect(segunda.status).toBe(409);
    await expect(segunda.json()).resolves.toMatchObject({ code: "transicion_invalida" });
    expect(crearReembolso).toHaveBeenCalledTimes(1);
    expect((await filaDe(id)).amount_refunded_cents).toBe(PRECIO_CENTS);
  });

  it("caso 17: sobre una reserva confirmada (sin cancelar) -> 409", async () => {
    const id = bookingId(4);
    await sembrarCancelada({
      id,
      status: "confirmed",
      paymentStatus: "paid",
      amountRefunded: 0,
      percent: 100,
      tier: 24,
      intent: "pi_confirmada",
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), client);

    expect(respuesta.status).toBe(409);
    expect(crearReembolso).not.toHaveBeenCalled();
    expect((await filaDe(id)).payment_status).toBe("paid");
  });

  it("caso 18: un tercero -> 404 y cero llamadas", async () => {
    const id = bookingId(5);
    await sembrarCancelada({
      id,
      paymentStatus: "paid",
      amountRefunded: 0,
      percent: 100,
      tier: 24,
      intent: "pi_ajena",
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarReembolso(peticionDe(TERCERO), paramsDe(id), client);

    expect(respuesta.status).toBe(404);
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("caso 19: cancelada sin pagar (unpaid) -> 409", async () => {
    const id = bookingId(6);
    await sembrarCancelada({
      id,
      paymentStatus: "unpaid",
      amountRefunded: 0,
      percent: 100,
      tier: 24,
      intent: "pi_sin_pagar",
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), client);

    expect(respuesta.status).toBe(409);
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("un tramo del 0% -> 409 sin_importe (no hay nada que devolver)", async () => {
    const id = bookingId(7);
    await sembrarCancelada({
      id,
      paymentStatus: "paid",
      amountRefunded: 0,
      percent: 0,
      tier: 0,
      intent: "pi_tramo_cero",
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), client);

    expect(respuesta.status).toBe(409);
    await expect(respuesta.json()).resolves.toMatchObject({ code: "sin_importe" });
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("una cancelada sin snapshot (null) -> 409 sin_importe", async () => {
    const id = bookingId(8);
    await sembrarCancelada({
      id,
      paymentStatus: "paid",
      amountRefunded: 0,
      percent: null,
      tier: null,
      intent: "pi_sin_snapshot",
    });
    const { client, crearReembolso } = clienteFalso();

    const respuesta = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), client);

    expect(respuesta.status).toBe(409);
    await expect(respuesta.json()).resolves.toMatchObject({ code: "sin_importe" });
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("si Stripe vuelve a caer -> 500 y la fila se queda reintentable", async () => {
    const id = bookingId(9);
    await sembrarCancelada({
      id,
      paymentStatus: "paid",
      amountRefunded: 0,
      percent: 100,
      tier: 24,
      intent: "pi_caido_reintento",
    });
    const { client, crearReembolso } = clienteFalso();
    crearReembolso.mockRejectedValueOnce(new Error("stripe sigue caido"));

    const respuesta = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), client);

    expect(respuesta.status).toBe(500);
    const fila = await filaDe(id);
    expect(fila.status).toBe("cancelled");
    expect(fila.payment_status).toBe("paid");
    expect(fila.amount_refunded_cents).toBe(0);
  });

  it("caso 11 cerrado: cancelado con Stripe caido, reintentado con el gestor y la politica cambiada", async () => {
    const id = bookingId(10);
    await sembrarConfirmada(id, "pi_caido_y_reintentado", dentroDe(20));
    const caido = clienteFalso();
    caido.crearReembolso.mockRejectedValue(new Error("stripe caido en la cancelacion"));

    const cancelada = await manejarCancelar(peticionDe(DUENO, "cancel"), paramsDe(id), caido.client);

    expect(cancelada.status).toBe(200);
    await expect(cancelada.json()).resolves.toMatchObject({
      estado: "cancelado",
      reembolso: { refund_cents: 1200, percent_applied: 50, pendiente: true },
    });

    // El club cambia la politica a "todo se devuelve" ENTRE medias. Si `/refund`
    // recalculara, devolveria 2400; el snapshot de la cancelacion dice 1200 y manda
    // (T14b-G).
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenant_content
            set value = $2::jsonb
          where tenant_id = $1 and content_key = 'cancellation_policy'`,
        [
          TENANT,
          JSON.stringify({
            tiers: [{ hours_before: 48, refund_percent: 100, label: "Ahora todo se devuelve" }],
            policy_text: "Politica cambiada T14b",
            notice_text: "Aviso de T14b",
          }),
        ],
      );
    });

    const bueno = clienteFalso();
    const reintentado = await manejarReembolso(peticionDe(GESTOR), paramsDe(id), bueno.client);

    expect(reintentado.status).toBe(200);
    await expect(reintentado.json()).resolves.toMatchObject({
      estado: "reembolsado",
      reembolso: { refund_cents: 1200, percent_applied: 50 },
    });
    expect(bueno.crearReembolso).toHaveBeenCalledWith({
      paymentIntentId: "pi_caido_y_reintentado",
      amountCents: 1200,
      idempotencyKey: `reembolso_${id}`,
    });
    const fila = await filaDe(id);
    expect(fila.payment_status).toBe("refunded");
    expect(fila.amount_refunded_cents).toBe(1200);
  });
});

/** Siembra una reserva CONFIRMADA en el instante que le pase el caso. */
async function sembrarConfirmada(id: string, intent: string, inicioIso: string): Promise<void> {
  const n = parseInt(id.slice(-12), 16);
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
       values ($1, $2, $3, 'cristal', 2400) on conflict (id) do nothing`,
      [pistaDe(n), TENANT, `Pista ${n}`],
    );
    const inicio = new Date(inicioIso);
    const fin = new Date(inicio.getTime() + 90 * 60_000);
    await db.query(
      `insert into public.bookings
         (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
          price_cents, currency, price_breakdown, num_players, player_name,
          stripe_payment_intent_id, payment_status)
       values ($1, $2, $3, $4, $5, $6, 'confirmed',
               $7, 'eur', '{"regla":"base","total_cents":2400}', 4, 'Socio de T14b',
               $8, 'paid')`,
      [id, TENANT, pistaDe(n), DUENO, inicio.toISOString(), fin.toISOString(), PRECIO_CENTS, intent],
    );
  });
}
