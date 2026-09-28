import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { TENANT_IDS, prepareDatabase, releaseDatabaseLease, withAdmin } from "../../test/db-harness.js";
import { baseQuery } from "./db";
import {
  COMISION_PLATAFORMA_CENTS,
  cuentaExpressOIdExistente,
  esGestor,
  sincronizarEstadoConnect,
  type StripeConnectClient,
} from "./stripe-connect";

/**
 * T13: la logica del lib de Stripe Connect contra Postgres REAL.
 *
 * Stripe NO se llama nunca: es el DSP de terceros y un test que llame a su API de
 * verdad necesita una cuenta, una key y dinero. Por eso el `StripeConnectClient` se
 * inyecta, y aqui se inyecta un cliente falso cuyo contrato es el del lib. Lo que
 * este fichero prueba es TODO LO QUE TOCA LA BASE:
 *
 *   - `cuentaExpressOIdExistente`: lee/guarda `tenants.stripe_account_id`.
 *   - `sincronizarEstadoConnect`: los flags y la fecha del onboarding.
 *   - `esGestor`: la comprobacion de gestor bajo `tenantQuery` (RLS de verdad).
 *
 * Y el anclaje de la comision, que no toca la base pero es la pieza que T14 importa.
 *
 * Las filas de `tenants` se tocan con `withAdmin` (la tabla no tiene RLS, y ademas
 * este es catalogo del despliegue, no aislamiento entre tenants). La RLS se prueba en
 * `esGestor`, que corre por `tenantQuery` y le compite al aislamiento de verdad.
 */

const SUB_A = "00000000-0000-4000-8000-0000000000f1";
const SUB_B = "00000000-0000-4000-8000-0000000000f3";

/** Cliente falso con los tres metodos del contrato; los contadores son de `vi.fn`. */
function clienteFalso(): StripeConnectClient & {
  crearCuentaExpress: ReturnType<typeof vi.fn>;
  obtenerCuenta: ReturnType<typeof vi.fn>;
} {
  return {
    crearCuentaExpress: vi.fn(async () => ({ id: "acct_falso_t13" })),
    obtenerAccountLink: vi.fn(async () => "https://connect.stripe.com/setup/falso"),
    obtenerCuenta: vi.fn(async () => ({ chargesEnabled: true, payoutsEnabled: false })),
  };
}

function filaConnect(tenantId = TENANT_IDS.a) {
  return baseQuery<{
    stripe_account_id: string | null;
    stripe_charges_enabled: boolean;
    stripe_payouts_enabled: boolean;
    stripe_onboarding_completed_at: string | null;
  }>(
    `select stripe_account_id, stripe_charges_enabled, stripe_payouts_enabled,
            stripe_onboarding_completed_at
       from public.tenants where id = $1`,
    [tenantId],
  );
}

function fechaOnboarding(tenantId = TENANT_IDS.a) {
  return filaConnect(tenantId).then((f) => f[0]?.stripe_onboarding_completed_at ?? null);
}

/** Deja la fila de Connect del tenant como la deja `db:reset`, para que cada test
 * arranque igual y no dependa del que corrio antes. */
async function limpiarConnect(tenantId: string): Promise<void> {
  await withAdmin(async (db) => {
    await db.query(
      `update public.tenants
          set stripe_account_id = null,
              stripe_charges_enabled = false,
              stripe_payouts_enabled = false,
              stripe_onboarding_completed_at = null
        where id = $1`,
      [tenantId],
    );
  });
}

afterAll(async () => {
  await limpiarConnect(TENANT_IDS.a);
  await limpiarConnect(TENANT_IDS.b);
  await releaseDatabaseLease();
});

beforeAll(async () => {
  await prepareDatabase();

  // Gestores para `esGestor`: A y B, con la RLS de `tenant_members` aplicando. La
  // seed global no toca los tenants del harness, asi que se siembran aqui.
  await withAdmin(async (db) => {
    for (const id of [SUB_A, SUB_B]) {
      await db.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [id, `t13-connect-${id}@example.test`],
      );
    }
    await db.query(
      `insert into public.tenant_members (tenant_id, user_id, role)
       values ($1, $2, 'gestor')
       on conflict (tenant_id, user_id) do nothing`,
      [TENANT_IDS.a, SUB_A],
    );
    await db.query(
      `insert into public.tenant_members (tenant_id, user_id, role)
       values ($1, $2, 'gestor')
       on conflict (tenant_id, user_id) do nothing`,
      [TENANT_IDS.b, SUB_B],
    );
  });
  await limpiarConnect(TENANT_IDS.a);
  await limpiarConnect(TENANT_IDS.b);
});

describe("T13: anclaje de la comision de plataforma", () => {
  it("COMISION_PLATAFORMA_CENTS es 0: subirla sin tocar la spec hace fallar esto", () => {
    expect(COMISION_PLATAFORMA_CENTS).toBe(0);
  });
});

describe("T13: cuentaExpressOIdExistente", () => {
  it("sin cuenta, crea la Express, la guarda y la devuelve", async () => {
    await limpiarConnect(TENANT_IDS.a);
    const cliente = clienteFalso();

    const id = await cuentaExpressOIdExistente(cliente, TENANT_IDS.a);

    expect(id).toBe("acct_falso_t13");
    expect(cliente.crearCuentaExpress).toHaveBeenCalledTimes(1);
    const fila = await filaConnect(TENANT_IDS.a);
    expect(fila[0]?.stripe_account_id).toBe("acct_falso_t13");
  });

  it("con cuenta ya guardada la reutiliza y NO crea otra", async () => {
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenants set stripe_account_id = 'acct_existente_t13' where id = $1`,
        [TENANT_IDS.a],
      );
    });
    const cliente = clienteFalso();

    const id = await cuentaExpressOIdExistente(cliente, TENANT_IDS.a);

    expect(id).toBe("acct_existente_t13");
    expect(cliente.crearCuentaExpress).not.toHaveBeenCalled();
  });
});

describe("T13: sincronizarEstadoConnect", () => {
  it("actualiza charges y payouts desde la cuenta, y pone la fecha en la transicion", async () => {
    await limpiarConnect(TENANT_IDS.a);
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenants set stripe_account_id = 'acct_cualquiera' where id = $1`,
        [TENANT_IDS.a],
      );
    });
    const cliente = clienteFalso();

    await sincronizarEstadoConnect(cliente, "acct_cualquiera");

    const fila = await filaConnect(TENANT_IDS.a);
    // El cliente falso devuelve charges=true, payouts=false.
    expect(fila[0]?.stripe_charges_enabled).toBe(true);
    expect(fila[0]?.stripe_payouts_enabled).toBe(false);
    // Como iba false y la fecha era null, esto SI es la transicion: fecha puesta.
    expect(await fechaOnboarding(TENANT_IDS.a)).not.toBeNull();
  });

  it("no machaca una fecha de onboarding ya puesta", async () => {
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenants
            set stripe_account_id = 'acct_cualquiera',
                stripe_charges_enabled = false,
                stripe_payouts_enabled = false,
                stripe_onboarding_completed_at = $1
          where id = $2`,
        ["2026-09-01T10:00:00Z", TENANT_IDS.a],
      );
    });
    const cliente = clienteFalso();

    await sincronizarEstadoConnect(cliente, "acct_cualquiera");

    const igual = await withAdmin(async (db) => {
      const res = await db.query<{ igual: boolean }>(
        `select (stripe_onboarding_completed_at = $1::timestamptz) as igual
           from public.tenants where id = $2`,
        ["2026-09-01T10:00:00Z", TENANT_IDS.a],
      );
      return res.rows[0]?.igual;
    });
    expect(igual).toBe(true);
  });

  it("busca al tenant por su stripe_account_id, no por id", async () => {
    await limpiarConnect(TENANT_IDS.a);
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenants set stripe_account_id = 'acct_uno' where id = $1`,
        [TENANT_IDS.a],
      );
    });
    const cliente = clienteFalso();

    // Cuenta distinta de la guardada: no debe tocar la fila.
    await sincronizarEstadoConnect(cliente, "acct_otra");
    expect((await filaConnect(TENANT_IDS.a))[0]?.stripe_charges_enabled).toBe(false);

    // La cuenta correcta: si la toca.
    await sincronizarEstadoConnect(cliente, "acct_uno");
    expect((await filaConnect(TENANT_IDS.a))[0]?.stripe_charges_enabled).toBe(true);
  });
});

describe("T13: esGestor", () => {
  it("true para un sub con fila de gestor en ESTE tenant", async () => {
    await expect(esGestor(TENANT_IDS.a, SUB_A)).resolves.toBe(true);
  });

  it("false para un sub sin fila de gestor", async () => {
    const subSinRol = "00000000-0000-4000-8000-0000000000bb";
    await withAdmin(async (db) => {
      await db.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [subSinRol, "t13-sin-rol@example.test"],
      );
    });
    await expect(esGestor(TENANT_IDS.a, subSinRol)).resolves.toBe(false);
  });

  it("el gestor de B consultado desde A es false: la RLS aísla", async () => {
    // SUB_B SI es gestor de B; preguntado por el tenant A no debe ver su fila.
    await expect(esGestor(TENANT_IDS.a, SUB_B)).resolves.toBe(false);
    await expect(esGestor(TENANT_IDS.b, SUB_B)).resolves.toBe(true);
  });
});