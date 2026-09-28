import { expect, test } from "@playwright/test";
import { config as loadEnv } from "dotenv";
import { Client } from "pg";

/**
 * T13: la matriz de la pantalla 20 (`/admin/pagos`), spec t13-stripe-connect.md.
 *
 * Se suma al smoke de T0. Como en los tests de ruta, el tenant bajo prueba es el de
 * demo (TENANT_SLUG=club-padel-demo), cuyo gestor siembra `db:reset` con id fijo. La
 * cookie de sesion es el JWT de tres partes SIN firma que `session.ts` acepta: es la
 * forma real de la cookie hasta que la verificacion criptografica sea la decision de
 * T11, que es exactamente el hueco que esta spec NO cierra.
 *
 * El estado de Connect se cambia POR BASE (vi)a pg, no por la API de Stripe: aqui se
 * prueba la RENDICION de la pantalla, y el flujo real de onboarding (que de verdad
 * deja charges=true despues de visitar Stripe) es el E2E manual con Stripe CLI de la
 * seccion Verificacion.
 */

loadEnv({ path: ".env.local", override: false });

const TENANT_DEMO = "00000000-0000-4000-8000-000000000001";
const GESTOR_DEMO = "00000000-0000-4000-8000-0000000000d1";

function cookieDe(sub: string): string {
  return `cabecera.${Buffer.from(JSON.stringify({ sub })).toString("base64url")}.firma`;
}

async function apagarCobros(): Promise<void> {
  const pg = new Client();
  await pg.connect();
  try {
    await pg.query(
      `update public.tenants
          set stripe_account_id = null,
              stripe_charges_enabled = false,
              stripe_payouts_enabled = false,
              stripe_onboarding_completed_at = null
        where id = $1`,
      [TENANT_DEMO],
    );
  } finally {
    await pg.end();
  }
}

async function encenderCobros(): Promise<void> {
  const pg = new Client();
  await pg.connect();
  try {
    await pg.query(
      `update public.tenants
          set stripe_account_id = 'acct_e2e_demo',
              stripe_charges_enabled = true,
              stripe_payouts_enabled = true
        where id = $1`,
      [TENANT_DEMO],
    );
  } finally {
    await pg.end();
  }
}

test.describe("T13: /admin/pagos", () => {
  test.afterAll(async () => {
    await apagarCobros();
  });

  // Los cuatro tests de este fichero comparten la fila del tenant de demo, que
  // `encender/apagarCobros` mutan en `afterEach` del siguiente: con `fullyParallel`
  // (config raiz) dos tests corriendo a la vez dejarian el estado a medias y el
  // ganador se llevaria el de su vecino. En serie, cada uno ve su propio estado.
  test.describe.configure({ mode: "serial" });

  test("sin sesion de gestor redirige a la home", async ({ page }) => {
    await page.goto("/admin/pagos");
    await page.waitForURL("http://localhost:3000/");
  });

  test("gestor con cobros pendientes ve el boton de conectar", async ({ page }) => {
    await apagarCobros();
    await page.context().addCookies([
      { name: "frasapp_session", value: cookieDe(GESTOR_DEMO), domain: "localhost", path: "/" },
    ]);
    await page.goto("/admin/pagos");
    await expect(
      page.getByRole("heading", { name: "Conectar los cobros de mi club" }),
    ).toBeVisible();
  });

  test("gestor con cobros conectados ve el estado conectado", async ({ page }) => {
    await encenderCobros();
    await page.context().addCookies([
      { name: "frasapp_session", value: cookieDe(GESTOR_DEMO), domain: "localhost", path: "/" },
    ]);
    await page.goto("/admin/pagos");
    await expect(page.getByRole("heading", { name: "Los cobros estan conectados" })).toBeVisible();
  });

  test("un fallo del servidor se resume sin jerga, nunca un error de Stripe", async ({ page }) => {
    // Sin STRIPE_SECRET_KEY util en el entorno, el onboard contesta el 500 generico: a
    // la pantalla llega la frase de la spec y ninguna palabra tecnica.
    await apagarCobros();
    await page.context().addCookies([
      { name: "frasapp_session", value: cookieDe(GESTOR_DEMO), domain: "localhost", path: "/" },
    ]);
    await page.goto("/admin/pagos");
    await page.getByRole("button", { name: "Conectar los cobros de mi club" }).click();

    // El `#__next-route-announcer__` (rol alert vacio que Next anade a cada pagina)
    // rompe el strict mode de getByRole("alert"): nos quedamos con el nuestro.
    const alerta = page.locator('p[role="alert"]');
    await expect(alerta).toBeVisible();
    await expect(alerta).toContainText(
      "No se pudieron conectar los cobros. Vuelve a intentarlo en unos minutos.",
    );
    await expect(alerta).not.toContainText(/stripe|express|account|500/i);
  });
});