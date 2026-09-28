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
 * T12: `pricing_rules` contra Postgres REAL.
 *
 * Misma separacion que en `courts.db.test.ts`:
 *
 * - El aislamiento se prueba con `withTenant`, que corre como `authenticated`, que es
 *   donde las politas aplican. Con `withAdmin` la RLS no existe y el test pasaria
 *   siempre.
 * - Los `check` de columna se prueban con `withAdmin`, para que lo que se mide sea el
 *   `check` y no la politica.
 *
 * Los asserts miran el NOMBRE de la restriccion, no "que de error": aceptar cualquier
 * error como rechazo valido dejaría pasar un check roto y una politica rota por el
 * mismo camino.
 */

const TABLES = ["pricing_rules"] as const;

const RLS_ERROR = /violates row-level security policy|viola la pol[ií]tica de seguridad/i;

/** Regla global de fixture de A. */
const RULE_A = "00000000-0000-4000-8000-0000000000f1";
/** Regla global de fixture de B. */
const RULE_B = "00000000-0000-4000-8000-0000000000f2";
/** Pista de fixture de A, para la FK compuesta que acepta. */
const COURT_A = "00000000-0000-4000-8000-0000000000f3";
/** Pista de fixture de B, para la FK compuesta que rechaza. */
const COURT_B = "00000000-0000-4000-8000-0000000000f4";

/**
 * Fixtures que SI tienen que sobrevivir al test.
 *
 * Van con `withAdmin`, que no lleva rollback, porque para que `withTenant` vea algo por
 * RLS la fila tiene que existir de verdad en la base. De ahi el `on conflict do nothing`
 * con id fijo: sembrar dos veces es lo mismo que sembrar una.
 */
async function seedFixtures(): Promise<void> {
  await withAdmin(async (db) => {
    // Este fichero es el dueño de las reglas de los tenants del harness. Se limpian
    // primero para que una ejecucion anterior no deje filas sueltas y el recuento del
    // aislamiento no dependa de cuantas veces se haya corrido el fichero.
    await db.query(
      `delete from public.pricing_rules where tenant_id = any($1::uuid[])`,
      [[TENANT_IDS.a, TENANT_IDS.b]],
    );
    await db.query(
      `delete from public.courts where id in ($1::uuid, $2::uuid)`,
      [COURT_A, COURT_B],
    );

    for (const key of ["a", "b"] as const) {
      await db.query(
        `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
         values ($1, $2, $3, 'cristal', 2000)
         on conflict (id) do nothing`,
        [key === "a" ? COURT_A : COURT_B, TENANT_IDS[key], `Pista Precio ${key.toUpperCase()}`],
      );
      await db.query(
        `insert into public.pricing_rules
           (id, tenant_id, name, scope, day_of_week, start_time, end_time,
            duration_min, price_cents)
         values ($1, $2, $3, 'global', '{}', '08:00', '22:00', 90, 2000)
         on conflict (id) do nothing`,
        [key === "a" ? RULE_A : RULE_B, TENANT_IDS[key], `Tarifa ${key.toUpperCase()}`],
      );
    }
  });
}

/**
 * `withTenant` no vale para medir un `check`: se quiere el rechazo del propio check, no
 * el de la politica. Y el assert busca solo el NOMBRE de la restriccion, que es unico en
 * la base y no depende del idioma de Postgres.
 */
async function expectConstraintViolation(
  sql: string,
  params: unknown[],
  constraint: string,
) {
  await expect(withAdmin(async (db) => db.query(sql, params))).rejects.toThrow(
    new RegExp(constraint),
  );
}

beforeAll(async () => {
  await prepareDatabase();
  await seedFixtures();
});

afterAll(async () => {
  // `seedFixtures` COMMITEA las pistas y las reglas de fixture (con `withAdmin` no hay
  // rollback), y la suite comparte un solo Postgres con ficheros que van uno a uno:
  // si estas dos filas no se borraran aqui, `courts.db.test.ts` veria 4 pistas en A en
  // vez de las 3 que su aislamiento cuenta. El `beforeAll` ya borra por tenant; este
  // `afterAll` borra por id para que el estado del harness quede como estaba.
  await withAdmin(async (db) => {
    await db.query(
      `delete from public.pricing_rules where id in ($1::uuid, $2::uuid)`,
      [RULE_A, RULE_B],
    );
    await db.query(
      `delete from public.courts where id in ($1::uuid, $2::uuid)`,
      [COURT_A, COURT_B],
    );
  });
  await releaseDatabaseLease();
});

describe("T12: aislamiento de pricing_rules", () => {
  for (const key of ["a", "b"] as const) {
    it(`el tenant ${key.toUpperCase()} solo ve sus propias reglas`, async () => {
      const rows = await withTenant(key, async (db) => {
        const result = await db.query<{ tenant_id: string }>(
          `select tenant_id from public.pricing_rules`,
        );
        return result.rows;
      });

      // Las dos mitades del assert: el numero, que es donde se ve un `USING` roto, y
      // que TODAS las filas sean suyas, que es donde se ve una fila ajena colada.
      expect(rows).toHaveLength(1);
      expect(rows.every((row) => row.tenant_id === TENANT_IDS[key])).toBe(true);
    });
  }

  it("INSERT con un tenant_id ajeno es rechazado", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.pricing_rules
             (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
           values ($1, 'Tarifa Intrusa', 'global', '{}', '08:00', '22:00', 1000)`,
          [TENANT_IDS.b],
        ),
      ),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("UPDATE no puede mover una regla al otro tenant", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `update public.pricing_rules set tenant_id = $2 where tenant_id = $1 returning tenant_id`,
          [TENANT_IDS.a, TENANT_IDS.b],
        ),
      ),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("DELETE no toca las reglas del otro tenant", async () => {
    const result = await withTenant("a", async (db) =>
      db.query(`delete from public.pricing_rules where tenant_id = $1`, [TENANT_IDS.b]),
    );
    expect(result.rowCount).toBe(0);
  });

  it("un JWT sin tenant_id no ve ninguna regla", async () => {
    const rows = await withClaims({ sub: "user-1" }, async (db) => {
      const result = await db.query<{ tenant_id: string }>(
        `select tenant_id from public.pricing_rules`,
      );
      return result.rows;
    });
    expect(rows).toHaveLength(0);
  });

  it("pricing_rules tiene RLS activada y forzada", async () => {
    const rows = await withAdmin(async (db) => {
      const result = await db.query<{
        relname: string;
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relname, relrowsecurity, relforcerowsecurity
           from pg_class
          where relname = any($1)`,
        [[...TABLES]],
      );
      return result.rows;
    });

    expect(rows).toHaveLength(1);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} sin RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} sin FORCE RLS`).toBe(true);
    }
  });

  it("tiene politica para las 4 operaciones", async () => {
    const rows = await withAdmin(async (db) => {
      const result = await db.query<{ tablename: string; cmd: string }>(
        `select tablename, cmd
           from pg_policies
          where schemaname = 'public'
            and tablename = any($1)`,
        [[...TABLES]],
      );
      return result.rows;
    });

    for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      const found = rows.some((r) => r.tablename === "pricing_rules" && r.cmd === cmd);
      expect(found, `sin politica ${cmd} en pricing_rules`).toBe(true);
    }
  });
});

describe("T12: pricing_rules sin coherencia de scope", () => {
  it("cada scope exige exactamente su columna", async () => {
    // `court_type` sin tipo: la regla no aplicaria a nada y no habria error visible.
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
       values ($1, 'Tarifa Sorda', 'court_type', '{1}', '08:00', '22:00', 1000)`,
      [TENANT_IDS.a],
      "pricing_rules_scope_coherent",
    );
  });

  it("un scope fuera de la enumeracion es rechazado", async () => {
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
       values ($1, 'Tarifa Rara', 'gloal', '{1}', '08:00', '22:00', 1000)`,
      [TENANT_IDS.a],
      "pricing_rules_scope_allowed",
    );
  });

  it("un court_type fuera de la enumeracion es rechazado", async () => {
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, court_type, day_of_week, start_time, end_time, price_cents)
       values ($1, 'Tarifa Vidrio', 'court_type', 'vidrio', '{1}', '08:00', '22:00', 1000)`,
      [TENANT_IDS.a],
      "pricing_rules_court_type_allowed",
    );
  });

  it("una regla de pista NO puede apuntar a una pista de otro tenant", async () => {
    // Mismo agujero que cerro `court_blocks`: sin la FK compuesta, el tenant A fijaria
    // una tarifa sobre una pista del tenant B que se aplicaria en la disponibilidad de A.
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, court_id, day_of_week, start_time, end_time, price_cents)
       values ($1, 'Tarifa Ajena', 'court', $2, '{1}', '08:00', '22:00', 1000)`,
      [TENANT_IDS.a, COURT_B],
      "pricing_rules_tenant_court_fkey",
    );
  });
});

describe("T12: pricing_rules acepta lo que el motor puede resolver", () => {
  it("una regla de pista del MISMO tenant se acepta", async () => {
    // `withTenant` y no `withAdmin`: esto es un INSERT VALIDO que no debe persistir.
    // Con `withTenant` el harness hace rollback y el recuento del aislamiento sigue
    // dependiendo solo de los fixtures.
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.pricing_rules
             (tenant_id, name, scope, court_id, day_of_week, start_time, end_time, price_cents)
           values ($1, 'Tarifa Pista A', 'court', $2, '{1}', '08:00', '22:00', 1000)
           on conflict do nothing`,
          [TENANT_IDS.a, COURT_A],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("dia de la semana vacio = todos los dias", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.pricing_rules
             (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
           values ($1, 'Tarifa Todos', 'global', '{}', '08:00', '22:00', 1000)`,
          [TENANT_IDS.a],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("una franja que termina a las 24:00 se acepta", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.pricing_rules
             (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
           values ($1, 'Tarifa Noche', 'global', '{0}', '00:00', '24:00', 1000)`,
          [TENANT_IDS.a],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("rechaza un dia de la semana que no existe", async () => {
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
       values ($1, 'Tarifa Lunero', 'global', '{8}', '08:00', '22:00', 1000)`,
      [TENANT_IDS.a],
      "pricing_rules_day_of_week_range",
    );
  });
});

describe("T12: pricing_rules rechaza precios y duraciones imposibles", () => {
  it("una franja invertida (22:00 a 02:00) se rechaza", async () => {
    // Decision del spec de T7: cruzar medianoche NO se interpreta, se prohibe.
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
       values ($1, 'Tarifa Imposible', 'global', '{1}', '22:00', '02:00', 1000)`,
      [TENANT_IDS.a],
      "pricing_rules_hours_ordered",
    );
  });

  it("una duracion de 0 minutos se rechaza", async () => {
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, day_of_week, start_time, end_time, duration_min, price_cents)
       values ($1, 'Tarifa Cero', 'global', '{1}', '08:00', '22:00', 0, 1000)`,
      [TENANT_IDS.a],
      "pricing_rules_duration_positive",
    );
  });

  it("un precio negativo se rechaza", async () => {
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
       values ($1, 'Tarifa Negativa', 'global', '{1}', '08:00', '22:00', -100)`,
      [TENANT_IDS.a],
      "pricing_rules_price_non_negative",
    );
  });

  it("un nombre en blanco se rechaza", async () => {
    await expectConstraintViolation(
      `insert into public.pricing_rules
         (tenant_id, name, scope, day_of_week, start_time, end_time, price_cents)
       values ($1, '   ', 'global', '{1}', '08:00', '22:00', 1000)`,
      [TENANT_IDS.a],
      "pricing_rules_name_not_blank",
    );
  });
});