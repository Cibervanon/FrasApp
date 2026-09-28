import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TENANT_IDS,
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
  withTenant,
} from "../test/db-harness.js";

/**
 * T13: `tenant_members` contra Postgres REAL.
 *
 * Quien es el gestor de un tenant (spec t13-stripe-connect.md, modelo de datos). Misma
 * separacion que el resto de ficheros DB:
 *
 * - El aislamiento se prueba con `withTenant`, que corre como `authenticated`, que es
 *   donde las politas aplican. Con `withAdmin` la RLS no existe y el test pasaria
 *   siempre.
 * - Los `check` y las FK se prueban con `withAdmin`, para que lo que se mida sea la
 *   restriccion y no la politica.
 * - La cascada se prueba con un tenant TEMPORAL (id fijo), jamas borrando los tenants
 *   del harness: `tenants.a`/`tenants.b` sostienen las cuentas de aislamiento de todos
 *   los ficheros (courts, bookings, pricing_rules), y borrarlos romperia las otras
 *   suites de una forma que no seria culpa de T13.
 */

const RLS_ERROR = /violates row-level security policy|viola la pol[ií]tica de seguridad/i;

/** Gestor de A (caso 6: dos gestores del mismo club). */
const USER_A = "00000000-0000-4000-8000-0000000000f1";
/** Segundo gestor de A. */
const USER_A2 = "00000000-0000-4000-8000-0000000000f2";
/** Gestor de B. */
const USER_B = "00000000-0000-4000-8000-0000000000f3";
/** Gestor de A Y de B a la vez (caso 5). */
const USER_AB = "00000000-0000-4000-8000-0000000000f4";
/** Persona de fixture que no es gestor de ningun tenant del harness. */
const USER_ALTA = "00000000-0000-4000-8000-0000000000f6";

/** Tenant temporal para la cascada. No es el harness: tiene su propio par. */
const TEMP_TENANT = "00000000-0000-4000-8000-0000000000f5";

/** Personas que SI tienen que sobrevivir al test (withAdmin, sin rollback). */
async function seedFixtures(): Promise<void> {
  await withAdmin(async (db) => {
    // La FK a auth.users es por id: hay que sembrar personas de verdad, o el insert
    // de un "gestor de A a mano" fallaria por FK y no estaria probando la politica.
    for (const id of [USER_A, USER_A2, USER_B, USER_AB, USER_ALTA]) {
      await db.query(
        `insert into auth.users (id, email)
         values ($1, $2)
         on conflict (id) do nothing`,
        [id, `t13-${id}@example.test`],
      );
    }

    // Limpieza previa por tenant: este fichero es el dueño de los miembros del harness.
    await db.query(
      `delete from public.tenant_members where tenant_id = any($1::uuid[])`,
      [[TENANT_IDS.a, TENANT_IDS.b]],
    );

    const gestores = [
      [TENANT_IDS.a, USER_A],
      [TENANT_IDS.a, USER_A2],
      [TENANT_IDS.a, USER_AB],
      [TENANT_IDS.b, USER_B],
      [TENANT_IDS.b, USER_AB],
    ] as const;
    for (const [tenantId, userId] of gestores) {
      await db.query(
        `insert into public.tenant_members (tenant_id, user_id, role)
         values ($1, $2, 'gestor')
         on conflict (tenant_id, user_id) do nothing`,
        [tenantId, userId],
      );
    }

    // Tenant y miembro TEMPORALES para la cascada.
    await db.query(
      `insert into public.tenants (id, name, slug) values ($1, 'Club Temp', 'club-temp-t13')
       on conflict (id) do nothing`,
      [TEMP_TENANT],
    );
    await db.query(
      `insert into public.tenant_members (tenant_id, user_id, role)
       values ($1, $2, 'gestor')
       on conflict (tenant_id, user_id) do nothing`,
      [TEMP_TENANT, USER_ALTA],
    );
  });
}

afterAll(async () => {
  await withAdmin(async (db) => {
    // El miembro de A que pudo dejar "gestor de alta" se va con el barrido por tenant.
    await db.query(
      `delete from public.tenant_members where tenant_id = any($1::uuid[])`,
      [[TENANT_IDS.a, TENANT_IDS.b]],
    );
    // El temporal se borra entero (la cascada deja el miembro en los dos casos).
    await db.query(`delete from public.tenants where id = $1`, [TEMP_TENANT]);
  });
  await releaseDatabaseLease();
});

beforeAll(async () => {
  await prepareDatabase();
  await seedFixtures();
});

describe("T13: aislamiento de tenant_members", () => {
  it("el JWT de A ve 3 gestores y el de B ve 2, sin cruzarse", async () => {
    const deA = await withTenant(
      "a",
      async (db) =>
        db.query<{ user_id: string }>(
          `select user_id from public.tenant_members order by user_id`,
        ),
    );
    expect(deA.rows.map((r) => r.user_id)).toEqual([USER_A, USER_A2, USER_AB]);

    const deB = await withTenant(
      "b",
      async (db) =>
        db.query<{ user_id: string }>(
          `select user_id from public.tenant_members order by user_id`,
        ),
    );
    expect(deB.rows.map((r) => r.user_id)).toEqual([USER_B, USER_AB]);
  });

  it("el sub de B conectado a A no ve la fila de B ni puede borrarla", async () => {
    const resultado = await withTenant("a", async (db) => {
      const visto = await db.query<{ tenant_id: string }>(
        `select tenant_id from public.tenant_members where user_id = $1`,
        [USER_B],
      );
      const borrado = await db.query(
        `delete from public.tenant_members where user_id = $1`,
        [USER_B],
      );
      return { visto: visto.rowCount ?? 0, borrado: borrado.rowCount ?? 0 };
    });
    // Con RLS la fila de B ni se ve ni se toca: 0 filas en los dos.
    expect(resultado.visto).toBe(0);
    expect(resultado.borrado).toBe(0);
  });

  it("insertar un miembro de otro tenant desde la sesion de A lo rechaza la politica", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.tenant_members (tenant_id, user_id, role)
           values ($1, $2, 'gestor')`,
          [TENANT_IDS.b, USER_B],
        ),
      ),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("cambiar el tenant de una fila propia a otro tenant lo rechaza la politica", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `update public.tenant_members set tenant_id = $1 where user_id = $2`,
          [TENANT_IDS.b, USER_A],
        ),
      ),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("con la RLS activa, insertar para el tenant propio SI es posible", async () => {
    // USER_ALTA es una persona de verdad y no es gestor de A. `withTenant` revierte
    // SIEMPRE, asi que insert y verficacion van en la MISMA transaccion: la fila
    // existe dentro de ella aunque nunca llegue a la base.
    const resultado = await withTenant("a", async (db) => {
      const insert = await db.query(
        `insert into public.tenant_members (tenant_id, user_id, role)
         values ($1, $2, 'gestor')`,
        [TENANT_IDS.a, USER_ALTA],
      );
      const visto = await db.query<{ n: string }>(
        `select count(*)::text as n from public.tenant_members where user_id = $1`,
        [USER_ALTA],
      );
      return { insert: insert.rowCount ?? 0, visto: visto.rows[0]?.n };
    });
    expect(resultado.insert).toBe(1);
    expect(resultado.visto).toBe("1");
  });
});

describe("T13: tenant_members solo admite el rol gestor", () => {
  it("admite 'gestor'", async () => {
    await expect(
      withAdmin(async (db) =>
        db.query(
          `insert into public.tenant_members (tenant_id, user_id, role)
           values ($1, $2, 'gestor')
           on conflict (tenant_id, user_id) do update set role = excluded.role`,
          [TEMP_TENANT, USER_A],
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("rechaza 'socio': el unico rol permitido es gestor (OQ-7)", async () => {
    await expect(
      withAdmin(async (db) =>
        db.query(
          `insert into public.tenant_members (tenant_id, user_id, role)
           values ($1, $2, 'socio')`,
          [TEMP_TENANT, USER_A],
        ),
      ),
    ).rejects.toThrow(/tenant_members_role_gestor/);
  });
});

describe("T13: FKs y cascada de tenant_members", () => {
  it("un miembro de un tenant inexistente viola la FK a tenants", async () => {
    await expect(
      withAdmin(async (db) =>
        db.query(
          `insert into public.tenant_members (tenant_id, user_id, role)
           values ('00000000-0000-4000-8000-0000000000ff', $1, 'gestor')`,
          [USER_A],
        ),
      ),
    ).rejects.toThrow(/tenant_members_tenant_id_fkey/);
  });

  it("un miembro de un usuario que no es persona viola la FK a auth.users", async () => {
    await expect(
      withAdmin(async (db) =>
        db.query(
          `insert into public.tenant_members (tenant_id, user_id, role)
           values ($1, '00000000-0000-4000-8000-0000000000ff', 'gestor')`,
          [TEMP_TENANT],
        ),
      ),
    ).rejects.toThrow(/tenant_members_user_id_fkey/);
  });

  it("borrar el tenant borra sus miembros (cascade)", async () => {
    await withAdmin(async (db) => {
      await db.query(`delete from public.tenants where id = $1`, [TEMP_TENANT]);
      const resto = await db.query<{ n: string }>(
        `select count(*)::text as n from public.tenant_members where tenant_id = $1`,
        [TEMP_TENANT],
      );
      expect(resto.rows[0]?.n).toBe("0");

      // Se repone el tenant temporal para que los tests que corren despues (o el
      // afterAll) no se encuentren con un TENANT_TEMP que ya no existe.
      await db.query(
        `insert into public.tenants (id, name, slug) values ($1, 'Club Temp', 'club-temp-t13')
         on conflict (id) do nothing`,
        [TEMP_TENANT],
      );
    });
  });

  it("borrar la persona de auth.users borra su fila (cascade)", async () => {
    // USER_ALTA esta solo en el TEMP_TENANT, asi que borrarla no toca las cuentas de
    // aislamiento del harness. Se repone al final para dejar la base como estaba.
    await withAdmin(async (db) => {
      await db.query(`delete from auth.users where id = $1`, [USER_ALTA]);
      const resto = await db.query<{ n: string }>(
        `select count(*)::text as n from public.tenant_members where user_id = $1`,
        [USER_ALTA],
      );
      expect(resto.rows[0]?.n).toBe("0");
    });

    await withAdmin(async (db) => {
      await db.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [USER_ALTA, "t13-alta@example.test"],
      );
      // El TEMP_TENANT puede no existir si el test de cascada de tenant ya lo borro.
      await db.query(
        `insert into public.tenants (id, name, slug) values ($1, 'Club Temp', 'club-temp-t13')
         on conflict (id) do nothing`,
        [TEMP_TENANT],
      );
      await db.query(
        `insert into public.tenant_members (tenant_id, user_id, role)
         values ($1, $2, 'gestor')
         on conflict (tenant_id, user_id) do nothing`,
        [TEMP_TENANT, USER_ALTA],
      );
    });
  });
});

describe("T13: politicas y FORCE de tenant_members en el catalogo", () => {
  it("tiene select, insert, update y delete, y todas para authenticated", async () => {
    await withAdmin(async (db) => {
      const politicas = await db.query<{ cmd: string; roles: string }>(
        `select cmd, array_to_string(roles, ',') as roles
           from pg_policies
          where schemaname = 'public' and tablename = 'tenant_members'
          order by cmd`,
      );
      const mapa = Object.fromEntries(politicas.rows.map((p) => [p.cmd, p.roles]));
      expect(mapa["SELECT"]).toBe("authenticated");
      expect(mapa["INSERT"]).toBe("authenticated");
      expect(mapa["UPDATE"]).toBe("authenticated");
      expect(mapa["DELETE"]).toBe("authenticated");
    });
  });

  it("FORCE ROW LEVEL SECURITY activo", async () => {
    await withAdmin(async (db) => {
      const fuerza = await db.query<{ active: boolean }>(
        `select relforcerowsecurity as active
           from pg_class
          where oid = 'public.tenant_members'::regclass`,
      );
      expect(fuerza.rows[0]?.active).toBe(true);
    });
  });
});