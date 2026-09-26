import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * Aislamiento de tenant contra Postgres REAL. Nunca mocks.
 *
 * Una RLS probada con un mock no prueba nada: el mock no aplica la politica, asi
 * que el test pasaria con la politica rota. Este test abre sesiones reales, cambia
 * el `request.jwt.claims` y deja que sea Postgres quien decida que filas puede ver
 * cada tenant.
 *
 * Dos tenants, `A` y `B`, sembrados con filas propias. La prueba es siempre la
 * misma y en las dos direcciones: A no ve a B, y B no ve a A.
 *
 * Connexion: `supabase start` (Supabase local, Docker). Puerto 54322.
 */

const TENANT_A = "00000000-0000-4000-8000-00000000000a";
const TENANT_B = "00000000-0000-4000-8000-00000000000b";

const CONNECTION = {
  host: process.env["SUPABASE_DB_HOST"] ?? "localhost",
  port: Number(process.env["SUPABASE_DB_PORT"] ?? 54322),
  user: process.env["SUPABASE_DB_USER"] ?? "postgres",
  password: process.env["SUPABASE_DB_PASSWORD"] ?? "postgres",
  database: process.env["SUPABASE_DB_NAME"] ?? "postgres",
};

/**
 * Sesion con la identidad de un tenant concreto.
 *
 * Se cambia a `authenticated` porque las politas son `TO authenticated`: con el
 * rol `postgres` las RLS no aplican y el test pasaria siempre. Es el detalle que
 * hace que este test signifique algo.
 */
async function asTenant(tenantId: string): Promise<Client> {
  const client = new Client(CONNECTION);
  await client.connect();
  await client.query("begin");
  await client.query("set local role authenticated");
  await client.query(
    `select set_config('request.jwt.claims', $1, true)`,
    [JSON.stringify({ sub: "user-1", tenant_id: tenantId, role: "authenticated" })],
  );
  return client;
}

let admin: Client;

beforeAll(async () => {
  admin = new Client(CONNECTION);
  await admin.connect();

  await admin.query("delete from public.tenant_branding");
  await admin.query("delete from public.tenant_features");
  await admin.query("delete from public.tenant_content");
  await admin.query("delete from public.tenants where id in ($1, $2)", [TENANT_A, TENANT_B]);

  await admin.query(
    `insert into public.tenants (id, name, slug) values ($1, 'Club A', 'club-a'), ($2, 'Club B', 'club-b')`,
    [TENANT_A, TENANT_B],
  );

  for (const [tenantId, color] of [
    [TENANT_A, "#111111"],
    [TENANT_B, "#222222"],
  ] as const) {
    await admin.query(
      `insert into public.tenant_branding
         (tenant_id, primary_color, secondary_color, font_family, email_from_name, email_reply_to)
       values ($1, $2, $2, 'Inter', 'Club', 'padel@example.test')`,
      [tenantId, color],
    );
    await admin.query(
      `insert into public.tenant_features (tenant_id, feature_key, enabled) values ($1, 'booking', true)`,
      [tenantId],
    );
    await admin.query(
      `insert into public.tenant_content (tenant_id, content_key, value) values ($1, 'about_club', '"x"'::jsonb)`,
      [tenantId],
    );
  }
});

afterAll(async () => {
  if (admin) {
    await admin.end();
  }
});

const TENANCY_TABLES = ["tenant_branding", "tenant_features", "tenant_content"] as const;

describe("RLS: aislamiento entre tenants", () => {
  for (const table of TENANCY_TABLES) {
    it(`${table}: el tenant A no lee las filas del tenant B`, async () => {
      const a = await asTenant(TENANT_A);
      try {
        const result = await a.query(`select tenant_id from public.${table}`);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.tenant_id).toBe(TENANT_A);
      } finally {
        await a.query("rollback");
        await a.end();
      }
    });

    it(`${table}: el tenant B tampoco lee las del tenant A`, async () => {
      const b = await asTenant(TENANT_B);
      try {
        const result = await b.query(`select tenant_id from public.${table}`);
        expect(result.rows).toHaveLength(1);
        expect(result.rows[0]?.tenant_id).toBe(TENANT_B);
      } finally {
        await b.query("rollback");
        await b.end();
      }
    });

    it(`${table}: INSERT con un tenant_id ajeno es rechazado`, async () => {
      // El agujero clasico: una politica `USING` sin `WITH CHECK` deja INSERTAR
      // filas de otro tenant aunque no puedas leerlas. Comprueba que el `WITH
      // CHECK` esta.
      const a = await asTenant(TENANT_A);
      try {
        const columns =
          table === "tenant_branding"
            ? "primary_color, secondary_color, font_family, email_from_name, email_reply_to"
            : table === "tenant_features"
              ? "feature_key, enabled"
              : "content_key, value";

        const values =
          table === "tenant_content"
            ? ["about_club", "'y'::jsonb"]
            : table === "tenant_features"
              ? ["'news'", "true"]
              : ["'#333333'", "'#333333'", "'Inter'", "'Club'", "'padel@example.test'"];

        await expect(
          a.query(
            `insert into public.${table} (tenant_id, ${columns}) values ($1, ${values.join(", ")})`,
            [TENANT_B],
          ),
        ).rejects.toThrow();
      } finally {
        await a.query("rollback");
        await a.end();
      }
    });
  }

  it("un JWT sin tenant_id no ve nada de ninguna tabla", async () => {
    // El caso del socio sin sesion de club, o con un JWT manipulado al que le
    // quitaron el claim. Cero filas, no error: la politica simplemente no casa.
    const anon = new Client(CONNECTION);
    await anon.connect();
    await anon.query("begin");
    await anon.query("set local role authenticated");
    await anon.query(
      `select set_config('request.jwt.claims', '{"sub":"user-1","role":"authenticated"}', true)`,
    );
    try {
      for (const table of TENANCY_TABLES) {
        const result = await anon.query(`select tenant_id from public.${table}`);
        expect(result.rows).toHaveLength(0);
      }
    } finally {
      await anon.query("rollback");
      await anon.end();
    }
  });

  it("las 3 tablas de negocio tienen RLS activada y forzada", async () => {
    // FORCE es lo que hace que las politas apliquen tambien al dueno de la tabla.
    // Sin FORCE, el webhook de Stripe (service_role) se saltaria todo.
    const result = await admin.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `select relname, relrowsecurity, relforcerowsecurity
         from pg_class
        where relname = any($1)`,
      [[...TENANCY_TABLES]],
    );

    expect(result.rows).toHaveLength(3);
    for (const row of result.rows) {
      expect(row.relrowsecurity, `${row.relname} sin RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} sin FORCE RLS`).toBe(true);
    }
  });

  it("cada tabla de negocio tiene politica para las 4 operaciones", async () => {
    const result = await admin.query<{ tablename: string; cmd: string; count: string }>(
      `select tablename, cmd, count(*)::text as count
         from pg_policies
        where schemaname = 'public'
          and tablename = any($1)
        group by tablename, cmd`,
      [[...TENANCY_TABLES]],
    );

    for (const table of TENANCY_TABLES) {
      for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const row = result.rows.find((r) => r.tablename === table && r.cmd === cmd);
        expect(row, `sin politica ${cmd} en ${table}`).toBeDefined();
        expect(Number(row?.count)).toBeGreaterThan(0);
      }
    }
  });
});
