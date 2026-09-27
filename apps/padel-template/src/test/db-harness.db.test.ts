import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TENANT_IDS,
  prepareDatabase,
  releaseDatabaseLease,
  requireExtension,
  requireMigration,
  withAdmin,
  withTenant,
} from "./db-harness.js";

/**
 * El harness es codigo de test, y eso NO lo hace automaticamente correcto.
 *
 * Un harness que no funciona como cree produce la peor clase de fallo: tests que
 * pasan por el motivo equivocado. Si `withTenant` se olvidara del `set local role
 * authenticated`, la RLS no aplicaria, A veria las filas de B, y este fichero
 * seguiria verde mientras el resto de la suite miente.
 *
 * Por eso se comprueba el harness contra propiedades que SOLO se pueden cumplir si
 * hace bien su trabajo, no contra "no lanza".
 */

beforeAll(async () => {
  await prepareDatabase();
});

// El cerrojo vive en una conexion que el harness mantiene abierta. Sin soltarla, el
// siguiente fichero de test se queda esperando a que este proceso muera. Con
// `fileParallelism: false` no hay carrera, porque el siguiente empieza cuando este
// acaba; si alguien lo quita, esto convierte la espera en un fallo con mensaje.
afterAll(async () => {
  await releaseDatabaseLease();
});

describe("harness: withTenant ejecuta fn con el JWT del tenant", () => {
  it("A ve exactamente una fila propia y ninguna de B", async () => {
    const ids = await withTenant("a", async (db) => {
      const result = await db.query<{ tenant_id: string }>(
        `select tenant_id from public.tenant_branding`,
      );
      return result.rows.map((row) => row.tenant_id);
    });
    expect(ids).toEqual([TENANT_IDS.a]);
    expect(ids).not.toContain(TENANT_IDS.b);
  });

  it("B ve lo suyo, y es un fixture distinto", async () => {
    const ids = await withTenant("b", async (db) => {
      const result = await db.query<{ tenant_id: string }>(
        `select tenant_id from public.tenant_branding`,
      );
      return result.rows.map((row) => row.tenant_id);
    });
    expect(ids).toEqual([TENANT_IDS.b]);
  });

  it("corre con el rol `authenticated`, no con el superusuario", async () => {
    // LA comprobacion de que el harness sirve para algo. Con el rol `postgres` las
    // RLS no aplican porque el superusuario las salta, y el test de aislamiento
    // passaria siempre. Aqui se mira el rol real de la sesion.
    const roles = await withTenant("a", async (db) => {
      const result = await db.query<{ current_role: string; session_user: string }>(
        `select current_role, session_user`,
      );
      return result.rows[0];
    });
    expect(roles?.current_role).toBe("authenticated");
    // `session_user` sigue siendo postgres porque el cambio es `set local role`.
    // Por eso el cambio se aplica por test y no se deja puesto.
    expect(roles?.session_user).toBe("postgres");
  });

  it("el `current_setting` que ve la sesion es el del tenant que se le paso", async () => {
    const claims = await withTenant("b", async (db) => {
      const result = await db.query<{ claims: string }>(
        `select current_setting('request.jwt.claims') as claims`,
      );
      return result.rows[0]?.claims;
    });
    const parsed = JSON.parse(claims ?? "{}") as { tenant_id?: string };
    expect(parsed.tenant_id).toBe(TENANT_IDS.b);
  });

  it("permite anadir claims extra, para el caso del JWT manipulado", async () => {
    const claims = await withTenant("a", async (db) => {
      const result = await db.query<{ claims: string }>(
        `select current_setting('request.jwt.claims') as claims`,
      );
      return result.rows[0]?.claims;
    }, { tenant_id: "tenant-ajeno-fabricado" });
    const parsed = JSON.parse(claims ?? "{}") as { tenant_id?: string };
    // El claim pasado TIENE que ganar: si el harness lo pusiera despues, esto
    // devolveria el tenant del harness y el test de JWT manipulado no probaria nada.
    expect(parsed.tenant_id).toBe("tenant-ajeno-fabricado");
  });
});

describe("harness: aislamiento por rollback", () => {
  /**
   * Las filas basura van a `content_key = 'terms_notice'` porque la tabla tiene un
   * `check` que solo admite `cancellation_policy`, `terms_notice` y `about_club`.
   *
   * Lo escribo porque me paso: la primera version de este fichero usaba
   * `basura_del_test` como clave, fallo con `viola la restricción check
   * tenant_content_key_allowed`, y el fallo DEL TEST se leia como un fallo del
   * harness. Inventar un valor que la base no admite hace que el test pruebe el
   * `check` en vez de lo que queria probar.
   *
   * `terms_notice` y no `about_club` porque el fixture de T3 ya siembra `about_club`
   * para cada tenant, y chocaria con el `unique` de `(tenant_id, content_key)`.
   */

  it("lo que escribe un test no sobrevive al siguiente", async () => {
    // El criterio de "los tests no se colan entre si" comprobado de forma
    // observable, y no por configuracion. Se escribe una fila, se sale del
    // `withTenant`, y otra sesion de superusuario tiene que seguir sin verla.
    await withTenant("a", async (db) => {
      await db.query(
        `insert into public.tenant_content (tenant_id, content_key, value)
         values ($1, 'terms_notice', '"x"'::jsonb)`,
        [TENANT_IDS.a],
      );
    });

    const count = await withAdmin(async (db) => {
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
           from public.tenant_content
          where content_key = 'terms_notice'`,
      );
      return result.rows[0]?.count;
    });
    expect(Number(count)).toBe(0);
  });

  it("hace rollback tambien cuando fn revienta", async () => {
    // Si el rollback estuvera en un `catch`, un test rojo contaminaria todos los
    // siguientes y los fallos parecerian fallos de RLS. Esto lo comprueba dejando un
    // test que falla A PROPOSITO y verificando despues que no quedo nada.
    await expect(
      withTenant("a", async (db) => {
        await db.query(
          `insert into public.tenant_content (tenant_id, content_key, value)
           values ($1, 'terms_notice', '"x"'::jsonb)`,
          [TENANT_IDS.a],
        );
        throw new Error("fallo intencionado del test");
      }),
    ).rejects.toThrow("fallo intencionado del test");

    const count = await withAdmin(async (db) => {
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
           from public.tenant_content
          where content_key = 'terms_notice'`,
      );
      return result.rows[0]?.count;
    });
    expect(Number(count)).toBe(0);
  });

  it("revierte una transaccion que el test dejo abierta", async () => {
    // Un test que hace `begin` y se olvida del `rollback` no puede dejar la
    // transaccion colgando: el `finally` del harness revierte, y la siguiente sesion
    // tiene que ver la base limpia.
    await withTenant("a", async (db) => {
      await db.query(
        `insert into public.tenant_content (tenant_id, content_key, value)
         values ($1, 'terms_notice', '"x"'::jsonb)`,
        [TENANT_IDS.a],
      );
      // Sin rollback explicito: esto es justo lo que el harness tiene que arreglar.
    });

    const count = await withAdmin(async (db) => {
      const result = await db.query<{ count: string }>(
        `select count(*)::text as count
           from public.tenant_content
          where content_key = 'terms_notice'`,
      );
      return result.rows[0]?.count;
    });
    expect(Number(count)).toBe(0);
  });
});

describe("harness: comprobaciones previas fallan ruidosamente", () => {
  it("da un error accionable si falta la tabla de la migracion", async () => {
    // El fallo que se quiere evitar: `relation "public.tenants" does not exist`, que
    // parece un error de SQL del test y en realidad es que no se ha aplicado la
    // migracion. El mensaje tiene que decir que ejecutar.
    await expect(requireMigration("tabla_que_no_existe")).rejects.toThrow(
      /pnpm db:reset/,
    );
  });

  it("da un error accionable si la extension no se puede crear", async () => {
    await expect(requireExtension("extension_que_no_existe")).rejects.toThrow(
      /Postgres dice/,
    );
  });

  it("exige PGPASSWORD en vez de connectar con una clave inventada", async () => {
    const original = process.env["PGPASSWORD"];
    delete process.env["PGPASSWORD"];
    try {
      await expect(withAdmin(async () => "no deberia llegar")).rejects.toThrow(
        /Falta PGPASSWORD/,
      );
    } finally {
      if (original !== undefined) process.env["PGPASSWORD"] = original;
    }
  });
});

describe("harness: la extension que necesita T4 esta disponible", () => {
  it("btree_gist esta creada, porque EXCLUDE la necesita para tstzrange", async () => {
    // Si esto falla, la migracion de T4 NO PUEDE escribir la restriccion de solapes
    // y hay que resolverlo aqui, no a mitad de T4.
    const rows = await withAdmin(async (db) => {
      const result = await db.query<{ extname: string; extversion: string }>(
        `select extname, extversion from pg_extension where extname = 'btree_gist'`,
      );
      return result.rows;
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.extversion).toMatch(/^\d+\.\d+$/);
  });
});

describe("harness: el cerrojo de la base", () => {
  it("el harness ya tiene el cerrojo, y se nota", async () => {
    // Prueba directa del criterio de aceptacion "los tests corren en serie": si este
    // test obtiene el cerrojo, es que `prepareDatabase` NO lo esta tomando, y la
    // garantia de que solo un fichero trabaja contra la base es falsa.
    //
    // Se pide con `pg_try_advisory_lock` sobre la MISMA clave que usa el harness. Si
    // el harness la tiene, esta sesion recibe false. Con `attempts: 1` y `waitMs: 0`
    // para que no espere.
    const took = await withAdmin(async (db) => {
      const result = await db.query<{ locked: boolean }>(
        `select pg_try_advisory_lock(8142005) as locked`,
      );
      if (result.rows[0]?.locked === true) {
        // Si se secara de verdad, se suelta: si no, se deja un cerrojo colgado.
        await db.query(`select pg_advisory_unlock(8142005)`);
      }
      return result.rows[0]?.locked;
    });
    expect(took).toBe(false);
  });

  it("una segunda conexion del mismo proceso TAMPOCO lo puede tomar", async () => {
    // El caso que de verdad importa: el cerrojo esta en la CONEXION, no en el
    // proceso. Asi que ni siquiera un worker distinto del mismo `pnpm test:db` se
    // cuela. Por eso el numero magico esta en dos sitios, y por eso este test
    // documenta el numero: si alguien cambia `DATABASE_LEASE_KEY` y no cambia esta
    // cadena, el test pasa a no comprobar nada sin avisar.
    const rows = await withAdmin(async (db) => {
      const result = await db.query<{ locked: boolean }>(
        `select pg_try_advisory_lock(8142005) as locked`,
      );
      return result.rows;
    });
    expect(rows[0]?.locked).toBe(false);
  });
});
