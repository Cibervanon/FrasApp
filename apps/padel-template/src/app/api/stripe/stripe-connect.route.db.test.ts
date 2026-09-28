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