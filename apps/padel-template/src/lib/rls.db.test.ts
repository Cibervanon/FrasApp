import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TENANT_IDS,
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
  withClaims,
  withTenant,
} from "../test/db-harness.js";

/**
 * Aislamiento de tenant contra Postgres REAL, a traves del harness de T3.
 *
 * Los fixtures, el cambio de rol y la sesion los pone `db-harness`. Este fichero solo
 * afirma. Si el harness estropea el aislamiento, estos tests tienen que ponerse rojos:
 * por eso los tres casos van en las DOS direcciones (A no ve a B, B no ve a A) y el
 * `INSERT` con tenant ajeno se prueba con el mensaje EXACTO de la politica, no con
 * "rechazado".
 */

const TENANCY_TABLES = ["tenant_branding", "tenant_features", "tenant_content"] as const;

beforeAll(async () => {
  await prepareDatabase();
});

afterAll(async () => {
  await releaseDatabaseLease();
});

describe("RLS: aislamiento entre tenants", () => {
  for (const table of TENANCY_TABLES) {
    it(`${table}: el tenant A no lee las filas del tenant B`, async () => {
      const rows = await withTenant("a", async (db) => {
        const result = await db.query<{ tenant_id: string }>(
          `select tenant_id from public.${table}`,
        );
        return result.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenant_id).toBe(TENANT_IDS.a);
    });

    it(`${table}: el tenant B tampoco lee las del tenant A`, async () => {
      const rows = await withTenant("b", async (db) => {
        const result = await db.query<{ tenant_id: string }>(
          `select tenant_id from public.${table}`,
        );
        return result.rows;
      });
      expect(rows).toHaveLength(1);
      expect(rows[0]?.tenant_id).toBe(TENANT_IDS.b);
    });

    it(`${table}: INSERT con un tenant_id ajeno es rechazado`, async () => {
      // El agujero clasico: una politica `USING` sin `WITH CHECK` deja INSERTAR
      // filas de otro tenant aunque no puedas leerlas. Comprueba que el `WITH
      // CHECK` esta.
      const columns =
        table === "tenant_branding"
          ? "primary_color, secondary_color, font_family, email_from_name, email_reply_to"
          : table === "tenant_features"
            ? "feature_key, enabled"
            : "content_key, value";

      // El valor de `tenant_content` es jsonb, y un jsonb tiene que ser JSON VALIDO.
      // Con comillas dobles es la cadena "club", no la palabra suelta `club`: con
      // 'club'::jsonb Postgres responde "invalid input syntax for type json", que es
      // OTRO error, y el test pasaba verde porque aceptaba cualquier error como
      // rechazo valido.
      const values =
        table === "tenant_content"
          ? ["'about_club'", `'"club"'::jsonb`]
          : table === "tenant_features"
            ? ["'news'", "true"]
            : ["'#333333'", "'#333333'", "'Inter'", "'Club'", "'padel@example.test'"];

      // El mensaje EXACTO, no "rechazado". Postgres dice `new row violates
      // row-level security policy`, en espanol "viola la politica de seguridad de
      // registros"; se aceptan las dos formas porque el idioma lo decide el locale del
      // servidor, no el del proyecto. Con `.rejects.toThrow()` a secas este test
      // paso verde con "permiso denegado al esquema auth": la fila se rechazaba por
      // permisos, no por la politica. Un test que pasa por el motivo equivocado es
      // peor que uno rojo, porque informa de que el RLS esta bien sin haberlo probado.
      await expect(
        withTenant("a", async (db) =>
          db.query(
            `insert into public.${table} (tenant_id, ${columns}) values ($1, ${values.join(", ")})`,
            [TENANT_IDS.b],
          ),
        ),
      ).rejects.toThrow(
        /violates row-level security policy|viola la pol[ií]tica de seguridad/i,
      );
    });
  }

  it("un JWT sin tenant_id no ve nada de ninguna tabla", async () => {
    // El caso del socio sin sesion de club, o con un JWT manipulado al que le
    // quitaron el claim. Cero filas, no error: la politica simplemente no casa.
    for (const table of TENANCY_TABLES) {
      const rows = await withClaims({ sub: "user-1" }, async (db) => {
        const result = await db.query<{ tenant_id: string }>(
          `select tenant_id from public.${table}`,
        );
        return result.rows;
      });
      expect(rows).toHaveLength(0);
    }
  });

  it("un UPDATE no puede mover una fila al otro tenant", async () => {
    // El `USING` filtra el SELECT y el `WITH CHECK` filtra el INSERT, pero un UPDATE
    // tiene las dos cosas: `USING` decide que filas puedes tocar y `WITH CHECK` que
    // puede quedar el resultado. Sin el segundo, A puede leer su fila, moverle el
    // `tenant_id` a B, y escribir en el tenant ajeno sin haber insertado nunca.
    //
    // Y AQUI HAY UN HALLAZGO QUE NO ESPERABA: yo daba por hecho que esto devolvia
    // 0 filas afectadas, y NO. Postgres LANZA un error, porque la fila resultante
    // viola el `WITH CHECK`. Es mejor que devolver 0 en silencio: un 0 filas puede
    // ser "no tienes nada que actualizar" o "no te dejan", y quien lo lee no puede
    // saber cual de las dos cosas ha pasado. Un error lo dice claro.
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `update public.tenant_features
              set tenant_id = $2
            where tenant_id = $1
            returning tenant_id`,
          [TENANT_IDS.a, TENANT_IDS.b],
        ),
      ),
    ).rejects.toThrow(/violates row-level security policy|viola la pol[ií]tica de seguridad/i);
  });

  it("las 3 tablas de negocio tienen RLS activada y forzada", async () => {
    // FORCE es lo que hace que las politas apliquen tambien al dueno de la tabla.
    // Sin FORCE, el webhook de Stripe (service_role) se saltaria todo.
    const rows = await withAdmin(async (db) => {
      const result = await db.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relname, relrowsecurity, relforcerowsecurity
           from pg_class
          where relname = any($1)`,
        [[...TENANCY_TABLES]],
      );
      return result.rows;
    });

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} sin RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} sin FORCE RLS`).toBe(true);
    }
  });

  it("cada tabla de negocio tiene politica para las 4 operaciones", async () => {
    const rows = await withAdmin(async (db) => {
      const result = await db.query<{ tablename: string; cmd: string }>(
        `select tablename, cmd
           from pg_policies
          where schemaname = 'public'
            and tablename = any($1)`,
        [[...TENANCY_TABLES]],
      );
      return result.rows;
    });

    for (const table of TENANCY_TABLES) {
      for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const found = rows.some((r) => r.tablename === table && r.cmd === cmd);
        expect(found, `sin politica ${cmd} en ${table}`).toBe(true);
      }
    }
  });
});
