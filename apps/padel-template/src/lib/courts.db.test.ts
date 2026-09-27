import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TENANT_IDS,
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
  withTenant,
  type TenantKey,
} from "../test/db-harness.js";

/**
 * T4: `courts` y `court_blocks` contra Postgres REAL.
 *
 * Separacion deliberada en los dos bloques de abajo:
 *
 * - El aislamiento se prueba con `withTenant`, que corre como `authenticated`, que es
 *   donde las politas aplican. Con `withAdmin` (superusuario) la RLS no existe y el
 *   test pasaria siempre.
 * - Los `check` de columna se prueban con `withAdmin`, para que lo que se mide sea el
 *   `check` y no la politica. Si se probaran con `withTenant`, un `check` roto y una
 *   politica rota darian el mismo error y no se sabria cual de los dos falla.
 *
 * Los asserts miran el NOMBRE de la restriccion, no "que de error". Aceptar cualquier
 * error como rechazo valido es como T2 dejo pasar un `safeParse` que no comprobaba el
 * `path`: el test pasa aunque la causa del error sea otra.
 */

/** UUIDs FIJOS, para que un `psql` a pelo reproduce el fallo. */
const COURT_IDS: Readonly<Record<TenantKey, string>> = {
  a: "00000000-0000-4000-8000-0000000000c1",
  b: "00000000-0000-4000-8000-0000000000c2",
};

/** Pista ya borrada logicamente, para el `unique` parcial. */
const RETIRED_COURT_ID = "00000000-0000-4000-8000-0000000000c3";
/** Pista activa con nombre ya ocupado, para el mismo `unique` parcial. */
const NAMED_COURT_ID = "00000000-0000-4000-8000-0000000000c4";

const TABLES = ["courts", "court_blocks"] as const;

const RLS_ERROR = /violates row-level security policy|viola la pol[ií]tica de seguridad/i;

/** Bloque de fixture, en una ventana que no se solapa con nada. */
const BLOCK_START = "2026-03-01T09:00:00Z";
const BLOCK_END = "2026-03-01T11:00:00Z";

/**
 * Fixtures que SI tienen que sobrevivir al test.
 *
 * Van con `withAdmin`, que no lleva rollback, porque para que `withTenant` vea algo por
 * RLS la fila tiene que existir de verdad en la base. De ahi el `on conflict do nothing`
 * con id fijo: sembrar dos veces es lo mismo que sembrar una, y el estado no depende de
 * cuantos ficheros de test hayan pasado antes.
 */
async function seedFixtures(): Promise<void> {
  await withAdmin(async (db) => {
    for (const key of ["a", "b"] as const) {
      await db.query(
        `insert into public.courts
           (id, tenant_id, name, court_type, surface, indoor, num_players,
            default_duration_min, min_duration_min, max_duration_min, base_price_cents)
         values ($1, $2, $3, 'cristal', 'cesped', true, 4, 90, 60, 180, 2500)
         on conflict (id) do nothing`,
        [COURT_IDS[key], TENANT_IDS[key], `Pista Fixture ${key.toUpperCase()}`],
      );
      await db.query(
        `insert into public.court_blocks
           (id, tenant_id, court_id, starts_at, ends_at, reason)
         values ($1, $2, $3, $4, $5, 'mantenimiento')
         on conflict (id) do nothing`,
        [
          `00000000-0000-4000-8000-0000000000d${key === "a" ? "1" : "2"}`,
          TENANT_IDS[key],
          COURT_IDS[key],
          BLOCK_START,
          BLOCK_END,
        ],
      );
    }

    // supporting fixtures del `unique` parcial: una pista ya retirada y otra activa, las
    // dos con el nombre que luego se intenta reutilizar.
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents, deleted_at)
       values ($1, $2, 'Pista Retirada', 'malla', 2000, now())
       on conflict (id) do nothing`,
      [RETIRED_COURT_ID, TENANT_IDS.a],
    );
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
       values ($1, $2, 'Pista Ocupada', 'malla', 2000)
       on conflict (id) do nothing`,
      [NAMED_COURT_ID, TENANT_IDS.a],
    );
  });
}

/**
 * Inserta una pista del tenant `key` con los valores dados. Se revierte al terminar.
 *
 * El `name` lo pasa siempre quien llama, a proposito: se podria anadir por defecto, pero
 * entonces habia que numerar los `$n` teniendo en cuenta si venia o no, y en la primera
 * version de este fichero esa numeracion estaba mal y el `INSERT` no habria insertsado
 * nada. Que sea obligatorio el campo hace imposible equivocarse.
 */
function insertCourt(key: TenantKey, values: Record<string, string | number | null>) {
  const columns = Object.keys(values);
  const placeholders = columns.map((_, index) => `$${index + 2}`);
  return withTenant(key, async (db) =>
    db.query(
      `insert into public.courts (tenant_id, ${columns.join(", ")})
       values ($1, ${placeholders.join(", ")})`,
      [TENANT_IDS[key], ...Object.values(values)],
    ),
  );
}

/**
 * `withTenant` no vale aqui: se quiere medir el `check`, no la politica.
 *
 * Y el assert busca SOLO el nombre de la restriccion, no la frase de Postgres. El
 * PostgreSQL local tiene `lc_messages` en espanol, asi que responde
 * `el nuevo registro para la relacion courts viola la restriccion check courts_...`
 * y un `/violates check constraint/` en ingles no casa nunca. La primera version de
 * este fichero hacia eso y 10 tests fallaron por el idioma.
 *
 * Buscar el nombre a pelo es ademas MAS PRECISO que buscar la frase: el nombre es
 * unico en la base y no depende ni del idioma ni de la redaccion de Postgres entre
 * versiones.
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
  await releaseDatabaseLease();
});

/**
 * Cuantas filas ve cada tenant, contado sobre los fixtures de `seedFixtures`.
 *
 * El tenant A tiene TRES pistas y no una: su propia, la retirada y la que ocupa el
 * nombre. La primera version de este fichero reutilizo el `toHaveLength(1)` del test de
 * tenancy, donde cada tenant tiene exactamente una fila, y aqui fallo porque A tiene
 * tres. Un numero copiado de otro test sin contar los fixtures es un test que afirma
 * algo que nadie ha comprobado.
 */
const EXPECTED_ROWS: Readonly<Record<(typeof TABLES)[number], Readonly<Record<TenantKey, number>>>> =
  {
    courts: { a: 3, b: 1 },
    court_blocks: { a: 1, b: 1 },
  };

describe("T4: aislamiento de courts y court_blocks", () => {
  for (const table of TABLES) {
    for (const key of ["a", "b"] as const) {
      it(`${table}: el tenant ${key.toUpperCase()} solo ve sus propias filas`, async () => {
        const rows = await withTenant(key, async (db) => {
          const result = await db.query<{ tenant_id: string }>(
            `select tenant_id from public.${table}`,
          );
          return result.rows;
        });

        // Las dos mitades del assert. El numero, que es donde se ve un `USING` roto
        // que se colase; y que TODAS las filas sean suyas, que es donde se ve una fila
        // ajena colada aunque el total cuadre por casualidad.
        expect(rows).toHaveLength(EXPECTED_ROWS[table][key]);
        expect(rows.every((row) => row.tenant_id === TENANT_IDS[key])).toBe(true);
      });
    }
  }

  it("INSERT en courts con un tenant_id ajeno es rechazado", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.courts (tenant_id, name, court_type, base_price_cents)
           values ($1, 'Intrusa', 'malla', 1000)`,
          [TENANT_IDS.b],
        ),
      ),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("INSERT en court_blocks con un tenant_id ajeno es rechazado", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.court_blocks
             (tenant_id, court_id, starts_at, ends_at, reason)
           values ($1, $2, $3, $4, 'cierre')`,
          [TENANT_IDS.b, COURT_IDS.b, BLOCK_START, BLOCK_END],
        ),
      ),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("un court_block NO puede apuntar a una pista de otro tenant", async () => {
    // Este es el agujero que el DDL de la spec deja abierto: `court_id references
    // courts(id)` NO lleva el tenant dentro de la referencia, asi que el tenant A puede
    // crear un bloqueo sobre una pista del tenant B. El bloqueo no apareceria en la
    // disponibilidad de B, pero si en la de A, sobre una pista que no es suya, y el
    // `court_id` que sale en el panel del gestor es de otro club.
    //
    // Se cierra con una FK COMPUESTA (tenant_id, court_id), no con un trigger ni con una
    // comprobacion en la API: la base no depende de que nadie se acuerde de validarlo, y
    // un INSERT que venga de un script o de un curl tampoco se cuela.
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.court_blocks
             (tenant_id, court_id, starts_at, ends_at, reason)
           values ($1, $2, $3, $4, 'privado')`,
          [TENANT_IDS.a, COURT_IDS.b, BLOCK_START, BLOCK_END],
        ),
      ),
    ).rejects.toThrow(/court_blocks_tenant_court_fkey/);
  });

  for (const table of TABLES) {
    it(`UPDATE en ${table} no puede mover una fila al otro tenant`, async () => {
      // El `USING` filtra el SELECT y el `WITH CHECK` filtra el INSERT, pero un UPDATE
      // tiene las dos cosas. Sin el `WITH CHECK`, A lee su fila, le cambia el
      // `tenant_id` a B, y escribe en el tenant ajeno sin haber insertado nunca.
      await expect(
        withTenant("a", async (db) =>
          db.query(
            `update public.${table} set tenant_id = $2 where tenant_id = $1 returning tenant_id`,
            [TENANT_IDS.a, TENANT_IDS.b],
          ),
        ),
      ).rejects.toThrow(RLS_ERROR);
    });

    it(`DELETE en ${table} no toca las filas del otro tenant`, async () => {
      // Aqui lo correcto son 0 filas afectadas, no un error: el `USING` no deja pasar
      // ninguna fila, asi que el DELETE no encuentra nada que borrar. Es distinto del
      // UPDATE, donde la fila EXISTE y lo que se rechaza es el `tenant_id` de destino.
      // Confundir los dos casos haria que este test exigiera un error donde la respuesta
      // correcta es "cero filas".
      const result = await withTenant("a", async (db) =>
        db.query(`delete from public.${table} where tenant_id = $1`, [TENANT_IDS.b]),
      );
      expect(result.rowCount).toBe(0);
    });
  }

  it("las 2 tablas tienen RLS activada y forzada", async () => {
    // FORCE es lo que hace que las politas apliquen tambien al dueno de la tabla. Sin
    // FORCE, el dueno se la salta y un test de RLS pasaria sin comprobar nada.
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

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.relrowsecurity, `${row.relname} sin RLS`).toBe(true);
      expect(row.relforcerowsecurity, `${row.relname} sin FORCE RLS`).toBe(true);
    }
  });

  it("las 2 tablas tienen politica para las 4 operaciones", async () => {
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

    for (const table of TABLES) {
      for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        const found = rows.some((r) => r.tablename === table && r.cmd === cmd);
        expect(found, `sin politica ${cmd} en ${table}`).toBe(true);
      }
    }
  });
});

describe("T4: courts no acepta duraciones imposibles", () => {
  it("acepta min <= default <= max", async () => {
    await expect(
      insertCourt("a", {
        name: "Pista Valida",
        court_type: "cristal",
        base_price_cents: 2000,
        min_duration_min: 60,
        default_duration_min: 90,
        max_duration_min: 180,
      }),
    ).resolves.toBeDefined();
  });

  it("rechaza min > default", async () => {
    await expectConstraintViolation(
      `insert into public.courts
         (tenant_id, name, court_type, base_price_cents, min_duration_min, default_duration_min, max_duration_min)
       values ($1, $2, 'cristal', 2000, 120, 90, 180)`,
      [TENANT_IDS.a, "Pista Imposible 1"],
      "courts_duration_ordering",
    );
  });

  it("rechaza default > max", async () => {
    await expectConstraintViolation(
      `insert into public.courts
         (tenant_id, name, court_type, base_price_cents, min_duration_min, default_duration_min, max_duration_min)
       values ($1, $2, 'cristal', 2000, 60, 200, 180)`,
      [TENANT_IDS.a, "Pista Imposible 2"],
      "courts_duration_ordering",
    );
  });

  it("rechaza una duracion minima de 0", async () => {
    // El `check` de orden NO cubre el cero: con min 0 el orden 0 <= 90 <= 180 se
    // cumple. Sin este `check` aparte, el club podria crear una pista que accepts
    // reservas de 0 minutos.
    await expectConstraintViolation(
      `insert into public.courts
         (tenant_id, name, court_type, base_price_cents, min_duration_min, default_duration_min, max_duration_min)
       values ($1, $2, 'cristal', 2000, 0, 90, 180)`,
      [TENANT_IDS.a, "Pista Imposible 3"],
      "courts_duration_positive",
    );
  });

  it("rechaza num_players fuera de 2 a 4", async () => {
    await expectConstraintViolation(
      `insert into public.courts (tenant_id, name, court_type, base_price_cents, num_players)
       values ($1, $2, 'cristal', 2000, 11)`,
      [TENANT_IDS.a, "Pista Once Jugadores"],
      "courts_num_players_range",
    );
  });

  it("rechaza un precio negativo", async () => {
    // Dinero en centimos enteros. Un precio negativo no es "un descuento": es una
    // reserva que paga el club, y se colaria en la disponibilidad sin que nadie lo mire.
    await expectConstraintViolation(
      `insert into public.courts (tenant_id, name, court_type, base_price_cents)
       values ($1, $2, 'cristal', -1)`,
      [TENANT_IDS.a, "Pista Negativa"],
      "courts_base_price_non_negative",
    );
  });

  it("rechaza un court_type que no existe", async () => {
    // La spec escribe los valores permitidos como COMENTARIO, no como `check`. Con un
    // `court_type` libre, una pista con 'cristal' y otra con 'Cristal' no se parecerian
    // nunca al cruzar con `pricing_rules.scope = 'court_type'`, y la tarifa del club no
    // se aplicaria a ninguna de las dos sin que saltase ningun error.
    await expectConstraintViolation(
      `insert into public.courts (tenant_id, name, court_type, base_price_cents)
       values ($1, $2, 'hierba', 2000)`,
      [TENANT_IDS.a, "Pista Tipo Raro"],
      "courts_court_type_allowed",
    );
  });

  it("rechaza un surface que no existe", async () => {
    await expectConstraintViolation(
      `insert into public.courts (tenant_id, name, court_type, surface, base_price_cents)
       values ($1, $2, 'cristal', 'polvo', 2000)`,
      [TENANT_IDS.a, "Pista Surface Raro"],
      "courts_surface_allowed",
    );
  });

  it("acepta surface null, porque la spec lo deja nullable", async () => {
    // `surface` es la unica de las dos que la spec no marca `not null`, asi que el
    // `check` tiene que admitir el null en vez de exigir un valor. Un `check` aqui
    // dejaria fuera una configuracion valida.
    await expect(
      insertCourt("a", {
        name: "Pista Sin Surface",
        court_type: "malla",
        surface: null,
        base_price_cents: 2000,
      }),
    ).resolves.toBeDefined();
  });
});

describe("T4: el nombre de una pista es unico entre las activas del mismo tenant", () => {
  it("rechaza dos activas con el mismo nombre en el mismo tenant", async () => {
    // La fila con 'Pista Ocupada' la crea `seedFixtures` ANTES que este test, y por eso
    // el `unique` tiene algo contra lo que chocar. En la primera version de este fichero
    // no se creaba, el INSERT pasabatodo, y el `rejects` se comia un error cualquiera
    // como si fuera la restriccion: un test que probaba que se puede insertar de mas.
    await expectConstraintViolation(
      `insert into public.courts (tenant_id, name, court_type, base_price_cents)
       values ($1, $2, 'malla', 2000)`,
      [TENANT_IDS.a, "Pista Ocupada"],
      "courts_tenant_name_active_uniq",
    );
  });

  it("permite reutilizar el nombre si la pista anterior esta borrada logicamente", async () => {
    // El `unique` es PARCIAL (`where deleted_at is null`): sin `deleted_at` no habria
    // forma de dar de baja una pista sin cambiarle el nombre, que es justo lo que un
    // club no quiere hacer a la pista 2.
    await expect(
      insertCourt("a", {
        name: "Pista Retirada",
        court_type: "malla",
        base_price_cents: 2500,
      }),
    ).resolves.toBeDefined();
  });

  it("el mismo nombre en dos tenants distintos no choca", async () => {
    // El `unique` es `(tenant_id, name)`, no `name`. Sin el tenant dentro, dos clubes
    // con una "Pista 1" no podrian coexistir en la misma base.
    await expect(
      withTenant("b", async (db) =>
        db.query(
          `insert into public.courts (tenant_id, name, court_type, base_price_cents)
           values ($1, 'Pista Ocupada', 'malla', 2000)`,
          [TENANT_IDS.b],
        ),
      ),
    ).resolves.toBeDefined();
  });
});

describe("T4: un bloque de pista tiene que durar algo", () => {
  it("acepta ends_at > starts_at", async () => {
    await expect(
      withTenant("a", async (db) =>
        db.query(
          `insert into public.court_blocks (tenant_id, court_id, starts_at, ends_at, reason)
           values ($1, $2, $3, $4, 'evento')`,
          [TENANT_IDS.a, COURT_IDS.a, "2026-04-01T10:00:00Z", "2026-04-01T10:00:01Z"],
        ),
      ),
    ).resolves.toBeDefined();
  });

  it("rechaza un bloque de duracion cero", async () => {
    // `ends_at > starts_at` y no `>=`: un bloque de duracion 0 no cierra nada, y
    // aceptarlo solo genera filas que estorban en el overlay de disponibilidad.
    await expectConstraintViolation(
      `insert into public.court_blocks (tenant_id, court_id, starts_at, ends_at, reason)
       values ($1, $2, $3, $3, 'mantenimiento')`,
      [TENANT_IDS.a, COURT_IDS.a, "2026-04-02T10:00:00Z"],
      "court_blocks_ends_after_starts",
    );
  });

  it("rechaza un bloque que termina antes de empezar", async () => {
    await expectConstraintViolation(
      `insert into public.court_blocks (tenant_id, court_id, starts_at, ends_at, reason)
       values ($1, $2, $3, $4, 'mantenimiento')`,
      [TENANT_IDS.a, COURT_IDS.a, "2026-04-03T12:00:00Z", "2026-04-03T10:00:00Z"],
      "court_blocks_ends_after_starts",
    );
  });

  it("rechaza un reason que no existe", async () => {
    await expectConstraintViolation(
      `insert into public.court_blocks (tenant_id, court_id, starts_at, ends_at, reason)
       values ($1, $2, $3, $4, 'averia')`,
      [TENANT_IDS.a, COURT_IDS.a, "2026-04-04T10:00:00Z", "2026-04-04T11:00:00Z"],
      "court_blocks_reason_allowed",
    );
  });
});
