import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Stripe from "stripe";

import { prepareDatabase, releaseDatabaseLease, withAdmin } from "../../../test/db-harness";
import { baseQuery, closePool } from "../../../lib/server/db";
import { clearTenantCache } from "../../../lib/server/tenant";
import type { StripeConnectClient } from "../../../lib/server/stripe-connect";
import { manejarOnboard } from "./connect/onboard/route";
import { manejarReturn } from "./connect/return/route";
import { manejarWebhook } from "./webhook/route";

/**
 * T13: la matriz de las tres rutas de Stripe (spec t13-stripe-connect.md), contra
 * Postgres REAL y con el cliente de Stripe FALSO.
 *
 * TENANT PROPIO, COMO EN T5d Y T11. Las rutas resuelven el tenant desde TENANT_SLUG
 * (instancia por club), asi que este fichero se apunta a un slug propio con su propio
 * tenant, y lo borra al final: ni roza el tenant de demo ni los del harness.
 *
 * El cliente falso tiene el mismo contrato que `StripeConnectClient`; lo que no se
 * inyecta es lo que debe ser real: la firma del webhook sale del SDK (`constructEvent`
 * + `generateTestHeaderString`) porque validar la firma es codigo criptografico y no
 * se simula. `esGestor` y la RLS son de verdad.
 */

const TENANT_T13 = "00000000-0000-4000-8000-0000000006b0";
const SLUG_T13 = "club-t13-a";
const COURT_T13 = "00000000-0000-4000-8000-0000000006b5";

const GESTOR = "00000000-0000-4000-8000-0000000006b1";
const NO_GESTOR = "00000000-0000-4000-8000-0000000006b2";

/**
 * El secreto con el que se firman los eventos del webhook.
 * `constructEvent` y `generateTestHeaderString` solo exigen que firmar y verificar
 * usen el MISMO valor: no hace falta una clave real de Stripe para probar el 401 ni
 * el 200. Si el entorno trae un secreto se usa; si viene vacio (`.env.local` los
 * tiene como ejemplo), se fija uno de test.
 */
const SECRETO_WEBHOOK = process.env["STRIPE_WEBHOOK_SECRET"] || "whsec_test_t13_solo_firma";

function clienteFalso(): StripeConnectClient & {
  crearCuentaExpress: ReturnType<typeof vi.fn>;
  obtenerCuenta: ReturnType<typeof vi.fn>;
} {
  return {
    crearCuentaExpress: vi.fn(async () => ({ id: "acct_falso_ruta" })),
    obtenerAccountLink: vi.fn(async () => "https://connect.stripe.com/setup/falso"),
    obtenerCuenta: vi.fn(async () => ({ chargesEnabled: true, payoutsEnabled: false })),
    // Informes inertes: las rutas de T13 no los llaman, pero el contrato de Stripe
    // Connect los exige desde T14-G y un fake del interfaz tiene que implementarlos.
    crearPaymentIntent: vi.fn(async () => ({
      paymentIntentId: "pi_falso_ruta",
      clientSecret: "sk_secret_falso",
    })),
    recuperarPaymentIntent: vi.fn(async (id: string) => ({
      paymentIntentId: id,
      clientSecret: "sk_secret_falso",
    })),
  };
}

function limpiarConnect(): Promise<void> {
  return withAdmin(async (db) => {
    await db.query(
      `update public.tenants
          set stripe_account_id = null,
              stripe_charges_enabled = false,
              stripe_payouts_enabled = false,
              stripe_onboarding_completed_at = null
        where id = $1`,
      [TENANT_T13],
    );
  });
}

function cuentaDeTenant(): Promise<string | null> {
  return baseQuery<{ stripe_account_id: string | null }>(
    `select stripe_account_id from public.tenants where id = $1`,
    [TENANT_T13],
  ).then((f) => f[0]?.stripe_account_id ?? null);
}

function estadoDeTenant() {
  return baseQuery<{ charges: boolean; payouts: boolean }>(
    `select stripe_charges_enabled as charges, stripe_payouts_enabled as payouts
       from public.tenants where id = $1`,
    [TENANT_T13],
  ).then((f) => ({ charges: f[0]?.charges ?? false, payouts: f[0]?.payouts ?? false }));
}

function cookieCon(sub: string): string {
  return `frasapp_session=cabecera.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.firma`;
}

/** Una peticion con la cookie de sesion puesta (o sin ella). */
function peticionDe(sub: string | null, url = "http://localhost/api/stripe/connect/onboard"): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (sub !== null) headers["cookie"] = cookieCon(sub);
  return new Request(url, { method: "POST", headers });
}

/** Un evento de Stripe firmado con el secreto real del entorno. */
function eventoFirmado(evento: Record<string, unknown>): { cuerpo: string; firma: string } {
  const cuerpo = JSON.stringify(evento);
  const firma = Stripe.webhooks.generateTestHeaderString({
    payload: cuerpo,
    secret: SECRETO_WEBHOOK,
  });
  return { cuerpo, firma };
}

function peticionWebhook(cuerpo: string, firma: string | null): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (firma !== null) headers["stripe-signature"] = firma;
  return new Request("http://localhost/api/stripe/webhook", { method: "POST", headers, body: cuerpo });
}

afterAll(async () => {
  await withAdmin(async (db) => {
    await db.query(`delete from public.bookings where tenant_id = $1`, [TENANT_T13]);
    await db.query(`delete from public.tenants where id = $1`, [TENANT_T13]);
    await db.query(`delete from auth.users where id = any($1::uuid[])`, [[GESTOR, NO_GESTOR]]);
  });
  await closePool();
  await releaseDatabaseLease();
});

beforeAll(async () => {
  await prepareDatabase();
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.tenants (id, name, slug)
       values ($1, 'Club T13', $2)
       on conflict (id) do update set name = excluded.name, slug = excluded.slug`,
      [TENANT_T13, SLUG_T13],
    );
    for (const [id, email] of [
      [GESTOR, "t13-gestor@example.test"],
      [NO_GESTOR, "t13-no-gestor@example.test"],
    ] as const) {
      await db.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [id, email],
      );
    }
    await db.query(
      `insert into public.tenant_members (tenant_id, user_id, role)
       values ($1, $2, 'gestor')
       on conflict (tenant_id, user_id) do nothing`,
      [TENANT_T13, GESTOR],
    );
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
       values ($1, $2, 'Pista T13', 'cristal', 1200)
       on conflict (id) do nothing`,
      [COURT_T13, TENANT_T13],
    );
  });
  // La ruta lee el secreto y `NEXT_PUBLIC_APP_URL` de process.env en cada peticion:
  // se fijan aqui (valores de test) para tener entorno consistente con o sin valores
  // reales en `.env.local`.
  process.env["STRIPE_WEBHOOK_SECRET"] = SECRETO_WEBHOOK;
  process.env["NEXT_PUBLIC_APP_URL"] = process.env["NEXT_PUBLIC_APP_URL"] || "http://localhost:3000";
  process.env["TENANT_SLUG"] = SLUG_T13;
  clearTenantCache();
  await limpiarConnect();
});

describe("T13: POST /api/stripe/connect/onboard", () => {
  it("sin cookie: 401", async () => {
    const respuesta = await manejarOnboard(peticionDe(null), clienteFalso());
    expect(respuesta.status).toBe(401);
  });

  it("con sesion que no es gestor: 403 con el copy de la spec", async () => {
    const respuesta = await manejarOnboard(peticionDe(NO_GESTOR), clienteFalso());
    expect(respuesta.status).toBe(403);
    const cuerpo = (await respuesta.json()) as { error: string };
    expect(cuerpo.error).toBe("No tienes permiso para gestionar los cobros de este club.");
  });

  it("gestor sin cuenta: crea la Express, la guarda y devuelve el Account Link", async () => {
    await limpiarConnect();
    const cliente = clienteFalso();

    const respuesta = await manejarOnboard(peticionDe(GESTOR), cliente);

    expect(respuesta.status).toBe(200);
    const cuerpo = (await respuesta.json()) as { accountLinkUrl: string };
    expect(cuerpo.accountLinkUrl).toBe("https://connect.stripe.com/setup/falso");
    expect(cliente.crearCuentaExpress).toHaveBeenCalledTimes(1);
    expect(await cuentaDeTenant()).toBe("acct_falso_ruta");
  });

  it("gestor con cuenta: reutiliza y no crea otra", async () => {
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenants set stripe_account_id = 'acct_existente_ruta' where id = $1`,
        [TENANT_T13],
      );
    });
    const cliente = clienteFalso();

    const respuesta = await manejarOnboard(peticionDe(GESTOR), cliente);

    expect(respuesta.status).toBe(200);
    expect(cliente.crearCuentaExpress).not.toHaveBeenCalled();
    expect(await cuentaDeTenant()).toBe("acct_existente_ruta");
  });

  it("fallo de Stripe: 500 generico y el detalle solo al log", async () => {
    await limpiarConnect();
    const errorOriginal = new Error("request failed for account");
    const cliente = clienteFalso();
    cliente.crearCuentaExpress.mockRejectedValue(errorOriginal);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);

    const respuesta = await manejarOnboard(peticionDe(GESTOR), cliente);

    expect(respuesta.status).toBe(500);
    const cuerpo = (await respuesta.json()) as { error: string };
    expect(cuerpo.error).toBe(
      "No se pudieron conectar los cobros. Vuelve a intentarlo en unos minutos.",
    );
    expect(cuerpo.error).not.toContain("request failed for account");
    expect(log).toHaveBeenCalled();
    log.mockRestore();
  });
});

describe("T13: GET /api/stripe/connect/return", () => {
  it("sin cookie: 401; con sesion que no es gestor: 403", async () => {
    const sinSesion = await manejarReturn(peticionDe(null), clienteFalso());
    expect(sinSesion.status).toBe(401);

    const sinRol = await manejarReturn(peticionDe(NO_GESTOR), clienteFalso());
    expect(sinRol.status).toBe(403);
  });

  it("sin stripe_account_id: 302 al panel, cero llamadas a Stripe", async () => {
    await limpiarConnect();
    const cliente = clienteFalso();

    const respuesta = await manejarReturn(peticionDe(GESTOR), cliente);

    expect(respuesta.status).toBe(302);
    expect(respuesta.headers.get("location")).toBe("/admin/pagos");
    expect(cliente.obtenerCuenta).not.toHaveBeenCalled();
    expect(cliente.crearCuentaExpress).not.toHaveBeenCalled();
  });

  it("setup=complete: sincroniza el estado con Stripe y 302", async () => {
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenants set stripe_account_id = 'acct_ruta' where id = $1`,
        [TENANT_T13],
      );
    });
    const cliente = clienteFalso();

    const respuesta = await manejarReturn(
      peticionDe(GESTOR, "http://localhost/api/stripe/connect/return?setup=complete"),
      cliente,
    );

    expect(respuesta.status).toBe(302);
    expect(cliente.obtenerCuenta).toHaveBeenCalledWith("acct_ruta");
    expect(await estadoDeTenant()).toEqual({ charges: true, payouts: false });
  });

  it("sin setup=complete no sincroniza, solo 302", async () => {
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenants set stripe_account_id = 'acct_ruta' where id = $1`,
        [TENANT_T13],
      );
    });
    const cliente = clienteFalso();

    const respuesta = await manejarReturn(peticionDe(GESTOR), cliente);

    expect(respuesta.status).toBe(302);
    expect(cliente.obtenerCuenta).not.toHaveBeenCalled();
  });
});

describe("T13: POST /api/stripe/webhook", () => {
  it("sin cabecera de firma: 401", async () => {
    const cliente = clienteFalso();
    const respuesta = await manejarWebhook(peticionWebhook("{}", null), cliente);
    expect(respuesta.status).toBe(401);
    expect(cliente.obtenerCuenta).not.toHaveBeenCalled();
  });

  it("firma invalida: 401", async () => {
    const cliente = clienteFalso();
    const respuesta = await manejarWebhook(peticionWebhook("{}", "firma_inventada"), cliente);
    expect(respuesta.status).toBe(401);
    expect(cliente.obtenerCuenta).not.toHaveBeenCalled();
  });

  it("account.updated firmado actualiza los flags del tenant correcto", async () => {
    await limpiarConnect();
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenants set stripe_account_id = 'acct_uno' where id = $1`,
        [TENANT_T13],
      );
    });
    const cliente = clienteFalso();
    const { cuerpo, firma } = eventoFirmado({
      id: "evt_cuenta",
      type: "account.updated",
      data: {
        object: { id: "acct_uno", object: "account", charges_enabled: true, payouts_enabled: false },
      },
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), cliente);

    expect(respuesta.status).toBe(200);
    expect(await estadoDeTenant()).toEqual({ charges: true, payouts: false });
  });

  it("account.updated de una cuenta ajena: 200 sin efectos", async () => {
    await limpiarConnect();
    const cliente = clienteFalso();
    const { cuerpo, firma } = eventoFirmado({
      id: "evt_ajena",
      type: "account.updated",
      data: { object: { id: "acct_ajena", object: "account" } },
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), cliente);

    expect(respuesta.status).toBe(200);
    // No hubo ningun tenant con esa cuenta: cero llamadas a Stripe y flags intactos.
    expect(cliente.obtenerCuenta).not.toHaveBeenCalled();
    expect(await estadoDeTenant()).toEqual({ charges: false, payouts: false });
  });

  it("un evento no controlado se ACK con 200 y sin efectos (es T14)", async () => {
    await limpiarConnect();
    const cliente = clienteFalso();
    const { cuerpo, firma } = eventoFirmado({
      id: "evt_pi",
      type: "payment_intent.succeeded",
      data: { object: { id: "pi_xxx" } },
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), cliente);

    expect(respuesta.status).toBe(200);
    expect(cliente.obtenerCuenta).not.toHaveBeenCalled();
  });
});

/**
 * T14 E3 (spec t14-payment-intent.md, casos 17-25): las ramas `payment_intent.*` del
 * webhook.
 *
 * La firma y el bind por `stripe_payment_intent_id` se prueban contra Postgres REAL: el
 * indice unico de E1 garantiza que un intent tiene a lo sumo una fila, y la idempotencia
 * por estado (T14-F) se mide reenviando el MISMO `event.id` y comprobando que solo el
 * primer pase escribe `confirmed_at` / `cancelled_at`.
 */

/** Un "booking de cobro" del tenant T13, en el estado de pago que diga el caso. */
interface FilaE3 {
  readonly id: string;
  readonly intent: string;
  readonly status: "pending_payment" | "confirmed" | "cancelled";
  readonly paymentStatus: "unpaid" | "paid" | null;
  readonly dia: number;
}

function sembrarCobro(fila: FilaE3): Promise<void> {
  return withAdmin(async (db) => {
    const inicio = new Date(Date.UTC(2026, 11, fila.dia, 18, 0));
    const fin = new Date(inicio.getTime() + 90 * 60_000);
    await db.query(
      `insert into public.bookings
         (id, tenant_id, court_id, user_id,
          starts_at, ends_at, status, hold_expires_at,
          price_cents, currency, price_breakdown, num_players, player_name,
          stripe_payment_intent_id, payment_status)
       values
         ($1, $2, $3, $4,
          $5, $6, $7, null,
          2400, 'eur', '{"regla":"base","total_cents":2400}', 4, 'Socio de T14',
          $8, $9)`,
      [
        fila.id,
        TENANT_T13,
        COURT_T13,
        GESTOR,
        inicio.toISOString(),
        fin.toISOString(),
        fila.status,
        fila.intent,
        fila.paymentStatus,
      ],
    );
  });
}

function filaDeBooking(id: string) {
  return withAdmin(async (db) => {
    const filas = await db.query<{
      status: string;
      payment_status: string | null;
      confirmed_at: string | null;
      cancelled_at: string | null;
      hold_expires_at: string | null;
    }>(
      `select status, payment_status, confirmed_at, cancelled_at, hold_expires_at
         from public.bookings where id = $1`,
      [id],
    );
    return filas.rows[0];
  });
}

function intentEvento(evento: {
  id: string;
  type: "payment_intent.succeeded" | "payment_intent.payment_failed" | "payment_intent.amount_capturable_updated";
  intent: string;
}) {
  return eventoFirmado({
    id: evento.id,
    type: evento.type,
    data: { object: { id: evento.intent } },
  });
}

describe("T14 E3: webhook de payment_intent.succeeded / payment_failed", () => {
  it("succeeded desde pending_payment: confirmed + paid + confirmed_at", async () => {
    await sembrarCobro({
      id: bookingT13(17),
      intent: "pi_e3_17",
      status: "pending_payment",
      paymentStatus: "unpaid",
      dia: 17,
    });
    const { cuerpo, firma } = intentEvento({
      id: "evt_17",
      type: "payment_intent.succeeded",
      intent: "pi_e3_17",
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());

    expect(respuesta.status).toBe(200);
    const fila = await filaDeBooking(bookingT13(17));
    expect(fila?.status).toBe("confirmed");
    expect(fila?.payment_status).toBe("paid");
    expect(fila?.confirmed_at).not.toBeNull();
  });

  it("el MISMO event.id succeeded 3 veces: UN solo efecto y confirmed_at estable", async () => {
    await sembrarCobro({
      id: bookingT13(18),
      intent: "pi_e3_18",
      status: "pending_payment",
      paymentStatus: "unpaid",
      dia: 18,
    });
    for (const vez of [1, 2, 3]) {
      const { cuerpo, firma } = intentEvento({
        id: "evt_18_replay",
        type: "payment_intent.succeeded",
        intent: "pi_e3_18",
      });
      const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());
      expect(respuesta.status).toBe(200);
      if (vez === 1) continue;
    }

    const fila = await filaDeBooking(bookingT13(18));
    expect(fila?.status).toBe("confirmed");
    expect(fila?.payment_status).toBe("paid");

    const marca = fila?.confirmed_at ?? null;
    const segunda = await filaDeBooking(bookingT13(18));
    expect(segunda?.confirmed_at).toEqual(marca);
  });

  it("succeeded sin booking por ese intent: 200 ack y no crea nada", async () => {
    const { cuerpo, firma } = intentEvento({
      id: "evt_19",
      type: "payment_intent.succeeded",
      intent: "pi_e3_19_inexistente",
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());

    expect(respuesta.status).toBe(200);
    const fila = await withAdmin((db) =>
      db.query<{ uno: number }>(
        `select 1 as uno from public.bookings where stripe_payment_intent_id = $1`,
        ["pi_e3_19_inexistente"],
      ),
    );
    expect(fila.rows.length).toBe(0);
  });

  it("succeeded sobre un booking cancelado: no resucita, queda cancelled", async () => {
    await sembrarCobro({
      id: bookingT13(20),
      intent: "pi_e3_20",
      status: "cancelled",
      paymentStatus: null,
      dia: 20,
    });
    const { cuerpo, firma } = intentEvento({
      id: "evt_20",
      type: "payment_intent.succeeded",
      intent: "pi_e3_20",
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());

    expect(respuesta.status).toBe(200);
    const fila = await filaDeBooking(bookingT13(20));
    expect(fila?.status).toBe("cancelled");
    expect(fila?.payment_status).toBeNull();
  });

  it("payment_failed desde pending_payment: cancelled + cancelled_at, sigue unpaid", async () => {
    await sembrarCobro({
      id: bookingT13(21),
      intent: "pi_e3_21",
      status: "pending_payment",
      paymentStatus: "unpaid",
      dia: 21,
    });
    const { cuerpo, firma } = intentEvento({
      id: "evt_21",
      type: "payment_intent.payment_failed",
      intent: "pi_e3_21",
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());

    expect(respuesta.status).toBe(200);
    const fila = await filaDeBooking(bookingT13(21));
    expect(fila?.status).toBe("cancelled");
    expect(fila?.cancelled_at).not.toBeNull();
    expect(fila?.payment_status).toBe("unpaid");
  });

  it("el MISMO event.id payment_failed 3 veces: UN solo efecto", async () => {
    await sembrarCobro({
      id: bookingT13(22),
      intent: "pi_e3_22",
      status: "pending_payment",
      paymentStatus: "unpaid",
      dia: 22,
    });
    for (let vez = 1; vez <= 3; vez++) {
      const { cuerpo, firma } = intentEvento({
        id: "evt_22_replay",
        type: "payment_intent.payment_failed",
        intent: "pi_e3_22",
      });
      const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());
      expect(respuesta.status).toBe(200);
    }

    const fila = await filaDeBooking(bookingT13(22));
    expect(fila?.status).toBe("cancelled");
    const marca = fila?.cancelled_at ?? null;
    const relectura = await filaDeBooking(bookingT13(22));
    expect(relectura?.cancelled_at).toEqual(marca);
  });

  it("payment_failed sobre un booking ya confirmed: no toca nada", async () => {
    await sembrarCobro({
      id: bookingT13(23),
      intent: "pi_e3_23",
      status: "confirmed",
      paymentStatus: "paid",
      dia: 23,
    });
    const { cuerpo, firma } = intentEvento({
      id: "evt_23",
      type: "payment_intent.payment_failed",
      intent: "pi_e3_23",
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());

    expect(respuesta.status).toBe(200);
    const fila = await filaDeBooking(bookingT13(23));
    expect(fila?.status).toBe("confirmed");
    expect(fila?.payment_status).toBe("paid");
  });

  it("un payment_intent.* desconocido se ACK con 200 y sin efectos", async () => {
    const { cuerpo, firma } = intentEvento({
      id: "evt_24",
      type: "payment_intent.amount_capturable_updated",
      intent: "pi_e3_24",
    });

    const respuesta = await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());

    expect(respuesta.status).toBe(200);
  });

  it("tras payment_failed el mismo slot vuelve a entrar: el EXCLUDE libero la pista", async () => {
    await sembrarCobro({
      id: bookingT13(25),
      intent: "pi_e3_25",
      status: "pending_payment",
      paymentStatus: "unpaid",
      dia: 25,
    });
    const { cuerpo, firma } = intentEvento({
      id: "evt_25",
      type: "payment_intent.payment_failed",
      intent: "pi_e3_25",
    });
    await manejarWebhook(peticionWebhook(cuerpo, firma), clienteFalso());

    const inicio = new Date(Date.UTC(2026, 11, 25, 18, 0));
    const fin = new Date(inicio.getTime() + 90 * 60_000);
    await expect(
      withAdmin((db) =>
        db.query(
          `insert into public.bookings
             (id, tenant_id, court_id, user_id, starts_at, ends_at,
              status, hold_expires_at, price_cents, currency, price_breakdown,
              num_players, player_name)
           values
             ($1, $2, $3, $4, $5, $6, 'held', now() + interval '3 minutes',
              2400, 'eur', '{}', 4, 'Reemplazo de T14')`,
          [bookingT13(99), TENANT_T13, COURT_T13, GESTOR, inicio.toISOString(), fin.toISOString()],
        ),
      ),
    ).resolves.toBeDefined();
  });
});

/** uuid determinista para los bookings del bloque E3. */
function bookingT13(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}