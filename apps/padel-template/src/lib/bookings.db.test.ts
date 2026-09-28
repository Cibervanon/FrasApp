import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  TENANT_IDS,
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
  withTenant,
  type Queryable,
  type TenantKey,
} from "../test/db-harness.js";

/**
 * T9: `bookings` contra Postgres REAL.
 *
 * Esta tabla es la del dinero y la del solape, asi que los tests se centran en los dos
 * puntos donde un error se paga caro: que dos reservas no puedan ocupar la misma pista a
 * la vez, y que un tenant no pueda ni ver ni tocar las reservas de otro.
 *
 * SEPARACION DELIBERADA, igual que en T4:
 *
 * - El `EXCLUDE` y los `check` se prueban con `withAdmin`, para que lo que se mide sea la
 *   restriccion y no la politica. Un `check` roto y una politica rota darian el mismo
 *   error, y sin separarlos no se sabria cual de los dos falla.
 * - El aislamiento se prueba con `withTenant`, que corre como `authenticated`. Con
 *   `withAdmin` (superusuario) la RLS no existe y el test pasaria siempre.
 *
 * Los asserts miran el NOMBRE de la restriccion, no la frase de Postgres: el PostgreSQL
 * local tiene `lc_messages` en espanol y un `/violates check constraint/` en ingles no
 * casa nunca. El nombre no depende del idioma ni de la redaccion entre versiones.
 */

/** UUIDs FIJOS, para que un `psql` a pelo reproduce el fallo. */
const COURT_IDS: Readonly<Record<TenantKey, string>> = {
  a: "00000000-0000-4000-8000-0000000000c1",
  b: "00000000-0000-4000-8000-0000000000c2",
};

/** Los dos socios, uno por tenant. La FK `user_id` los necesita. */
const USER_IDS: Readonly<Record<TenantKey, string>> = {
  a: "00000000-0000-4000-8000-0000000000e1",
  b: "00000000-0000-4000-8000-0000000000e2",
};

const RLS_ERROR = /violates row-level security policy|viola la pol[ií]tica de seguridad/i;

/** Estados que el `EXCLUDE` tiene que bloquear. */
const ESTADOS_VIGENTES = ["held", "pending_payment", "confirmed"] as const;

/** Estados que el `EXCLUDE` tiene que dejar pasar. */
const ESTADOS_LIBRES = ["cancelled", "completed", "no_show", "expired"] as const;

/**
 * Ventanas fijas, una por grupo de tests.
 *
 * Todas en dias distintos, y la de los fixtures en un dia que ningun test toca. Asi
 * ningun test puede chocar con lo que dejo el anterior, sin depender del orden de
 * ejecucion: los inserts de cada test se revierten, pero los fixtures NO, y si un
 * fixture ocupase la misma hora que un test, ese test fallaria por culpa de un fixture
 * en lugar de por lo que comprueba.
 */
const VENTANAS = {
  fixtures: { inicio: "2026-03-05T09:00:00Z", fin: "2026-03-05T10:30:00Z" },
  solape: { inicio: "2026-03-02T09:00:00Z", fin: "2026-03-02T10:30:00Z" },
  /** Justo despues de `solape`, para probar que horas contiguas NO se solapan. */
  solapeTarde: { inicio: "2026-03-02T10:30:00Z", fin: "2026-03-02T12:00:00Z" },
  /** Empieza dentro de `solape` y se sale por detras. */
  solapeParcial: { inicio: "2026-03-02T10:00:00Z", fin: "2026-03-02T11:00:00Z" },
  /** Enteramente dentro de `solape`. */
  solapeDentro: { inicio: "2026-03-02T09:45:00Z", fin: "2026-03-02T10:15:00Z" },
  checks: { inicio: "2026-03-03T09:00:00Z", fin: "2026-03-03T10:30:00Z" },
  limpieza: { inicio: "2026-03-04T09:00:00Z", fin: "2026-03-04T10:30:00Z" },
  /** Segunda ventana del dia, para el segundo hold del test de limpieza. */
  limpiezaTarde: { inicio: "2026-03-04T15:00:00Z", fin: "2026-03-04T16:30:00Z" },
  ajena: { inicio: "2026-03-06T09:00:00Z", fin: "2026-03-06T10:30:00Z" },
} as const;

/** Fechas lejanas, para que estos tests valgan dentro de mil anos. */
const EXPIRA_FUTURO = "2099-01-01T00:00:00Z";
const EXPIRA_PASADO = "2020-01-01T00:00:00Z";

/**
 * UUID determinista a partir de un numero.
 *
 * Fijos y no aleatorios, como el resto del arnes: si un test falla, el `id` esta en el
 * mensaje y se puede reproducir a pelo. Y distintos entre si, porque dentro de una
 * misma transaccion dos reservas con la misma hora necesitan poder distinguirse.
 */
function bookingId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/**
 * Una reserva valida, con lo minimo que exige el DDL.
 *
 * Los `cambios` se aplanan encima, de modo que un test que solo quiere cambiar el estado
 * no tiene que volver a escribir las 19 columnas. Lo que se cambia son columnas
 * REALES: si un test pasara un nombre de columna que no existe, el INSERT fallaria con
 * un error de columna y el `rejects` se lo comeria como si fuera la restriccion que
 * queria probar. Por eso los cambios van por nombre de columna de verdad.
 */
function reserva(n: number, cambios: Record<string, unknown> = {}): Record<string, unknown> {
  const fila: Record<string, unknown> = {
    id: bookingId(n),
    tenant_id: TENANT_IDS.a,
    court_id: COURT_IDS.a,
    user_id: USER_IDS.a,
    starts_at: VENTANAS.checks.inicio,
    ends_at: VENTANAS.checks.fin,
    status: "held",
    hold_expires_at: EXPIRA_FUTURO,
    price_cents: 2500,
    price_breakdown: '{"regla":"base","player_multiplier":1,"total_cents":2500}',
    num_players: 4,
    player_name: "Socio de Prueba",
    ...cambios,
  };

  // Los checks de T14 (20260930000000_payments_intent.sql) imponen coherencia de
  // pagos: pending_payment exige intent + payment_status='unpaid', y confirmed exige
  // payment_status='paid'. Que el state machine YEZCA coherente hasta en los fixtures
  // es la prueba de que el modelo de datos cerrado por T14 no se puede violar. Un
  // cambio que pase un estado incoherente a proposito sobrescribe la columna, que es
  // como los tests de rechazo propio de E1 lo cazan.
  if (fila.status === "pending_payment") {
    if (fila.stripe_payment_intent_id === undefined) fila.stripe_payment_intent_id = bookingId(n);
    if (fila.payment_status === undefined) fila.payment_status = "unpaid";
  } else if (fila.status === "confirmed") {
    if (fila.payment_status === undefined) fila.payment_status = "paid";
  }
  return fila;
}

/**
 * Inserta una reserva del tenant `key`. Se revierte al terminar.
 *
 * El `tenant_id` lo pone SIEMPRE la identidad del helper y nunca quien llama, porque el
 * tenant es justo lo que estos tests manipulan: si se colara desde los valores, el
 * `INSERT` llevaria `tenant_id` dos veces. El unico test que necesita escribir en el
 * tenant ajeno construye su SQL a mano, que es donde se ve la intencion.
 *
 * Las demas columnas las da quien llama, numeradas a partir de `$2` porque el
 * `tenant_id` va el primero. La primera version de un helper asi se equivocaba al
 * numerar, el `INSERT` no insertaba nada, y el test pasaba probando que se podia
 * insertar de mas.
 */
function insertBooking(key: TenantKey, valores: Record<string, unknown>) {
  return withTenant(key, (db) => insertarEn(db, key, valores));
}

/** El mismo `INSERT`, pero sobre una conexion que ya tiene una transaccion abierta. */
function insertarEn(db: Queryable, key: TenantKey, valores: Record<string, unknown>) {
  const { tenant_id: _ajeno, ...propias } = valores;
  const columnas = Object.keys(propias);
  const marcadores = columnas.map((_, indice) => `$${indice + 2}`);
  return db.query(
    `insert into public.bookings (tenant_id, ${columnas.join(", ")})
     values ($1, ${marcadores.join(", ")})`,
    [TENANT_IDS[key], ...Object.values(propias)],
  );
}

/**
 * DOS reservas en la MISMA transaccion, que es lo que necesita el `EXCLUDE`.
 *
 * Cada `withTenant` revierte al terminar, asi que dos llamadas sueltas serian DOS
 * reservas que nunca coinciden en el tiempo y el test del solape pasaria con el
 * `EXCLUDE` borrado. La primera version de este fichero hacia justo eso: 3 tests en
 * verde con la restriccion eliminada de la migracion.
 *
 * Devuelve el resultado del SEGUNDO insert, para que un `resolves.toBeDefined()` no
 * este mirando el `void` que devuelve el `withTenant`.
 */
function dosReservas(
  key: TenantKey,
  primera: Record<string, unknown>,
  segunda: Record<string, unknown>,
) {
  return withTenant(key, async (db) => {
    await insertarEn(db, key, primera);
    return insertarEn(db, key, segunda);
  });
}

/** Una reserva de la ventana de solape, que es la que se usa para probar el `EXCLUDE`. */
function enVentanaDeSolape(n: number, cambios: Record<string, unknown> = {}) {
  return reserva(n, {
    starts_at: VENTANAS.solape.inicio,
    ends_at: VENTANAS.solape.fin,
    ...cambios,
  });
}

/**
 * Fixtures que SI tienen que sobrevivir al test.
 *
 * Pistas, socios y una reserva por tenant, con `on conflict do nothing` e id fijo:
 * sembrar dos veces es lo mismo que sembrar una. La reserva de cada tenant existe para
 * que los tests de RLS tengan algo REAL que mirar; un `select` sobre una tabla vacia
 * daria cero filas por el motivo equivocado y pasaria aunque la politica fuera un
 * agujero.
 */
async function seedFixtures(): Promise<void> {
  await withAdmin(async (db) => {
    for (const key of ["a", "b"] as const) {
      // Mismos ids y mismos valores que `courts.db.test.ts`, a proposito: los dos
      // ficheros comparten base, y sembrar la misma pista con valores distintos
      // haria que el resultado dependiera de cual de los dos corrio antes.
      await db.query(
        `insert into public.courts
           (id, tenant_id, name, court_type, surface, indoor, num_players,
            default_duration_min, min_duration_min, max_duration_min, base_price_cents)
         values ($1, $2, $3, 'cristal', 'cesped', true, 4, 90, 60, 180, 2500)
         on conflict (id) do nothing`,
        [COURT_IDS[key], TENANT_IDS[key], `Pista Fixture ${key.toUpperCase()}`],
      );
      await db.query(
        `insert into auth.users (id, email)
         values ($1, $2)
         on conflict (id) do nothing`,
        [USER_IDS[key], `socio-${key}@example.test`],
      );
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
            hold_expires_at, price_cents, price_breakdown, num_players, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500,
                 '{"regla":"base","total_cents":2500}', 4, 'Socio Fixture')
         on conflict (id) do nothing`,
        [
          // Un id POR TENANT, no el mismo para los dos: con el mismo id, el segundo
          // `insert` caia en el `on conflict do nothing` y el tenant B se quedaba sin
          // fixture. El test de RLS de B entonces veia cero filas y fallaba por un
          // fixture que no existia, no por la politica.
          bookingId(key === "a" ? 900 : 901),
          TENANT_IDS[key],
          COURT_IDS[key],
          USER_IDS[key],
          VENTANAS.fixtures.inicio,
          VENTANAS.fixtures.fin,
          EXPIRA_FUTURO,
        ],
      );
    }
  });
}

/**
 * El assert mira SOLO el nombre de la restriccion, no "que de error".
 *
 * Aceptar cualquier error como rechazo valido es como T2 dejo pasar un `safeParse` que
 * no comprobaba el `path`: el test pasa aunque la causa sea otra, y un typo en el nombre
 * de una columna se disguise de restriccion violada.
 */
async function expectConstraintViolation(
  sql: string,
  params: unknown[],
  constraint: string,
) {
  await expect(withAdmin((db) => db.query(sql, params))).rejects.toThrow(new RegExp(constraint));
}

/** Igual, pero con la reserva completa como valores sueltos. */
async function expectReservaRechazada(valores: Record<string, unknown>, constraint: string) {
  const columnas = Object.keys(valores);
  const marcadores = columnas.map((_, indice) => `$${indice + 1}`);
  await expectConstraintViolation(
    `insert into public.bookings (${columnas.join(", ")})
     values (${marcadores.join(", ")})`,
    Object.values(valores),
    constraint,
  );
}

/**
 * Superusuario DENTRO de una transaccion que se revierte.
 *
 * Hace falta para dos cosas que `withAdmin` no da: insertar filas de los dos tenants en
 * la MISMA transaccion (para contar filas en un solo `expire_stale_holds()`) y probar
 * un `alter table` que se supone que Postgres RECHAZA, sin dejar el estado a medias si
 * la sorpresa es que lo acepta.
 */
async function enTransaccionAdmin<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  return withAdmin(async (db) => {
    await db.query("begin");
    try {
      return await fn(db);
    } finally {
      await db.query("rollback");
    }
  });
}

beforeAll(async () => {
  await prepareDatabase();
  await seedFixtures();
});

afterAll(async () => {
  await releaseDatabaseLease();
});

/** Cuantas reservas ve cada tenant sobre los fixtures: exactamente la suya. */
const RESERVAS_POR_TENANT: Readonly<Record<TenantKey, number>> = { a: 1, b: 1 };

describe("T9: aislamiento de bookings", () => {
  for (const key of ["a", "b"] as const) {
    it(`el tenant ${key.toUpperCase()} solo ve sus propias reservas`, async () => {
      const filas = await withTenant(key, async (db) => {
        const result = await db.query<{ tenant_id: string }>(
          `select tenant_id from public.bookings`,
        );
        return result.rows;
      });

      // Las dos mitades del assert: el numero, que es donde se ve un `USING` roto que
      // se colase, y que TODAS las filas sean suyas, que es donde se ve una fila ajena
      // colada aunque el total cuadre por casualidad.
      expect(filas).toHaveLength(RESERVAS_POR_TENANT[key]);
      expect(filas.every((fila) => fila.tenant_id === TENANT_IDS[key])).toBe(true);
    });
  }

  it("INSERT con un tenant_id ajeno es rechazado", async () => {
    // El SQL a mano, y no `insertBooking`, porque este test necesita precisamente el
    // `tenant_id` del otro tenant: el helper lo pone bien siempre.
    const valores = reserva(1, { tenant_id: TENANT_IDS.b });
    const { tenant_id, ...propias } = valores;
    const columnas = Object.keys(propias);
    const marcadores = columnas.map((_, indice) => `$${indice + 2}`);

    await expect(
      withTenant("a", (db) =>
        db.query(
          `insert into public.bookings (tenant_id, ${columnas.join(", ")})
           values ($1, ${marcadores.join(", ")})`,
          [tenant_id, ...Object.values(propias)],
        ),
      ),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("UPDATE no puede mover una reserva al otro tenant", async () => {
    // El `USING` filtra el SELECT y el `WITH CHECK` filtra la escritura. Sin el
    // `WITH CHECK`, el tenant A le cambia el `tenant_id` a su fila y escribe en el
    // tenant ajeno sin haber insertado nunca.
    await expect(
      withTenant("a", (db) =>
        db.query(
          `update public.bookings set tenant_id = $2 where tenant_id = $1 returning tenant_id`,
          [TENANT_IDS.a, TENANT_IDS.b],
        ),
      ),
    ).rejects.toThrow(RLS_ERROR);
  });

  it("DELETE no toca las reservas del otro tenant", async () => {
    // Aqui lo correcto son 0 filas afectadas, no un error: el `USING` no deja pasar
    // ninguna fila, asi que el DELETE no encuentra nada que borrar. Es distinto del
    // UPDATE, donde la fila EXISTE y lo que se rechaza es el `tenant_id` de destino.
    const result = await withTenant("a", (db) =>
      db.query(`delete from public.bookings where tenant_id = $1`, [TENANT_IDS.b]),
    );
    expect(result.rowCount).toBe(0);
  });

  it("una reserva NO puede apuntar a una pista de otro tenant", async () => {
    // La spec escribe `court_id references courts(id)`, y eso deja que el tenant A
    // reserve una pista del tenant B: el cobro iria a la cuenta Express del club
    // equivocado, y el `court_id` que sale en el panel del gestor es de otro club. Se
    // cierra con la FK COMPUESTA (tenant_id, court_id), igual que en T4 pero aqui es
    // peor, porque el importe de la reserva depende de la pista.
    await expect(
      insertBooking("a", reserva(1, { court_id: COURT_IDS.b })),
    ).rejects.toThrow(/bookings_tenant_court_fkey/);
  });

  it("bookings tiene RLS activada y forzada", async () => {
    // FORCE es lo que hace que las politas apliquen tambien al dueno de la tabla. Sin
    // FORCE, el dueno se la salta y este test pasaria sin comprobar nada.
    const fila = await withAdmin(async (db) => {
      const result = await db.query<{
        relrowsecurity: boolean;
        relforcerowsecurity: boolean;
      }>(
        `select relrowsecurity, relforcerowsecurity
           from pg_class
          where relname = 'bookings'`,
      );
      return result.rows[0];
    });

    expect(fila?.relrowsecurity, "bookings sin RLS").toBe(true);
    expect(fila?.relforcerowsecurity, "bookings sin FORCE RLS").toBe(true);
  });

  it("bookings tiene politica para las 4 operaciones", async () => {
    const filas = await withAdmin(async (db) => {
      const result = await db.query<{ cmd: string }>(
        `select cmd from pg_policies where schemaname = 'public' and tablename = 'bookings'`,
      );
      return result.rows;
    });

    for (const cmd of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      expect(
        filas.some((fila) => fila.cmd === cmd),
        `sin politica ${cmd} en bookings`,
      ).toBe(true);
    }
  });

  it("bookings tiene el indice de lectura por pista y estado", async () => {
    // El `EXCLUDE` no sirve para esto: indexa por tenant, pista e INSTERVALO, asi que la
    // consulta de disponibilidad ("reservas vigentes de ESTA pista entre ESTAS horas") y
    // el `UPDATE` de la limpieza perezosa no lo pueden usar como filtro y se irian a un
    // seq scan de la tabla entera en cada intento de reserva.
    //
    // El assert mira que EXISTE el indice, no que sea el unico: el `EXCLUDE` arrastra su
    // propio indice GiST, y una primera version de este test afirmaba `toHaveLength(1)`
    // y fallaba por ese indice, que es correcto que este ahi.
    //
    // Solo se comprueba que existe, no que se use: probar que Postgres lo elige
    // necesitaria meter miles de filas y `explain analyze`, y eso lo tiene que medir el
    // panel de rendimiento, no un test de correctitud.
    const indices = await withAdmin(async (db) => {
      const result = await db.query<{ indexdef: string }>(
        `select indexdef from pg_indexes where schemaname = 'public' and tablename = 'bookings'`,
      );
      return result.rows.map((fila) => fila.indexdef);
    });

    const deLectura = indices.find((definicion) => definicion.includes("bookings_tenant_court_status_idx"));
    expect(deLectura, "sin el indice de lectura por pista y estado").toBeDefined();
    expect(deLectura).toMatch(/tenant_id, court_id, status, hold_expires_at/);

    const delExclude = indices.find((definicion) => definicion.includes("bookings_no_overlap"));
    expect(delExclude, "sin el indice GiST del EXCLUDE").toBeDefined();
    expect(delExclude).toMatch(/USING gist/);
  });
});

describe("T9: el EXCLUDE impide dos reservas en la misma pista y hora", () => {
  for (const estado of ESTADOS_VIGENTES) {
    it(`una reserva en ${estado} bloquea la ventana`, async () => {
      await expect(
        dosReservas("a", enVentanaDeSolape(1), enVentanaDeSolape(2, { status: estado })),
      ).rejects.toThrow(/bookings_no_overlap/);
    });
  }

  it("rechaza un solape parcial, que empieza dentro de la otra", async () => {
    await expect(
      dosReservas(
        "a",
        enVentanaDeSolape(1),
        reserva(2, { starts_at: VENTANAS.solapeParcial.inicio, ends_at: VENTANAS.solapeParcial.fin }),
      ),
    ).rejects.toThrow(/bookings_no_overlap/);
  });

  it("rechaza un solape total, que esta dentro de la otra", async () => {
    await expect(
      dosReservas(
        "a",
        enVentanaDeSolape(1),
        reserva(2, { starts_at: VENTANAS.solapeDentro.inicio, ends_at: VENTANAS.solapeDentro.fin }),
      ),
    ).rejects.toThrow(/bookings_no_overlap/);
  });

  it("acepta horas contiguas, porque una reserva que acaba no pisa a la siguiente", async () => {
    // `tstzrange` es [inicio, fin): las 10:30 son de la primera y de la segunda a la vez
    // como extremo, pero no como intervalo, asi que no hay solape. Sin esto, un club no
    // podria encadenar reservas de hora y media y cada socio perderia media hora.
    await expect(
      dosReservas(
        "a",
        enVentanaDeSolape(1),
        reserva(2, { starts_at: VENTANAS.solapeTarde.inicio, ends_at: VENTANAS.solapeTarde.fin }),
      ),
    ).resolves.toBeDefined();
  });

  for (const estado of ESTADOS_LIBRES) {
    it(`una reserva en ${estado} NO bloquea la ventana`, async () => {
      // El predicado del `EXCLUDE` es lo UNICO que decide esto. Un `EXCLUDE` sin
      // predicado bloquearia tambien las canceladas, y entonces un socio que cancela
      // seguia dejando su pista imposible de reservar para todo el dia.
      await expect(
        dosReservas("a", enVentanaDeSolape(1, { status: estado }), enVentanaDeSolape(2)),
      ).resolves.toBeDefined();
    });
  }

  it("dos tenants pueden reservar la misma hora en su propia pista", async () => {
    // `tenant_id with =` esta en el `EXCLUDE` precisamente para esto: el club A y el
    // club B son cerrados distintos, y sin el tenant dentro uno cerraria el horario del
    // otro en la misma base.
    await expect(
      insertBooking("a", reserva(1, { starts_at: VENTANAS.solape.inicio, ends_at: VENTANAS.solape.fin })),
    ).resolves.toBeDefined();
    await expect(
      insertBooking("b", reserva(2, { court_id: COURT_IDS.b, user_id: USER_IDS.b })),
    ).resolves.toBeDefined();
  });

  it("Postgres RECHAZA now() en el predicado del EXCLUDE (la trampa de la spec 4.4.1)", async () => {
    // La variante obvia del predicado seria "y ademas el hold no ha caducado", pero
    // `now()` es STABLE y no IMMUTABLE, asi que Postgres la rechaza y no hay forma de
    // escribirla. Por eso la caducidad se resuelve con `expire_stale_holds`, no aqui.
    //
    // El control positivo va PRIMERO y en la misma transaccion: si el `EXCLUDE` sin
    // `now()` tampoco aceptara, el `rejects` de abajo pasaria por un error de sintaxis y
    // el test probaria que hay una falta de ortografia, no la trampa de la spec.
    const resultado = await enTransaccionAdmin(async (db) => {
      await db.query(
        `alter table public.bookings add constraint bookings_prueba_sin_now
           exclude using gist (
             tenant_id with =,
             court_id with =,
             tstzrange(starts_at, ends_at) with &&
           )
           where (status in ('held', 'pending_payment', 'confirmed'))`,
      );

      let error = "";
      try {
        await db.query(
          `alter table public.bookings add constraint bookings_prueba_con_now
             exclude using gist (
               tenant_id with =,
               court_id with =,
               tstzrange(starts_at, ends_at) with &&
             )
             where (status in ('held', 'pending_payment', 'confirmed')
                    and (hold_expires_at is null or hold_expires_at > now()))`,
        );
      } catch (fallo) {
        error = fallo instanceof Error ? fallo.message : String(fallo);
      }
      return error;
    });

    expect(resultado).toMatch(/IMMUTABLE/i);
  });
});

describe("T9: bookings no acepta datos imposibles", () => {
  it("rechaza un hold sin hold_expires_at, que no caducaria nunca", async () => {
    await expectReservaRechazada(
      reserva(1, { hold_expires_at: null }),
      "bookings_hold_expires_required",
    );
  });

  it("acepta una reserva confirmada sin hold_expires_at, porque ya no es un hold", async () => {
    // El `check` es `status <> 'held' or hold_expires_at is not null`: para el resto de
    // estados el campo da igual, y exigirlo dejaria fuera una reserva ya cobrada.
    await expect(insertBooking("a", reserva(1, { status: "confirmed", hold_expires_at: null }))).resolves.toBeDefined();
  });

  it("rechaza una reserva de duracion cero", async () => {
    await expectReservaRechazada(
      reserva(1, { ends_at: VENTANAS.checks.inicio }),
      "bookings_ends_after_starts",
    );
  });

  it("rechaza una reserva que termina antes de empezar", async () => {
    await expectReservaRechazada(
      reserva(1, { ends_at: "2026-03-03T08:00:00Z" }),
      "bookings_ends_after_starts",
    );
  });

  it("rechaza un status que no existe", async () => {
    await expectReservaRechazada(reserva(1, { status: "pagada" }), "bookings_status_allowed");
  });

  it("rechaza un status con mayuscula", async () => {
    // La spec escribe los estados permitidos como COMENTARIO. Con un `status` libre,
    // 'Held' y 'held' no se parecerian nunca al cruzar con el predicado del `EXCLUDE`,
    // y la reserva no bloquearia la pista sin que saltase ningun error.
    await expectReservaRechazada(reserva(1, { status: "Held" }), "bookings_status_allowed");
  });

  it("rechaza un payment_status con mayuscula", async () => {
    // El trigger de invitaciones (T16) compara con `payment_status = 'paid'`, y un
    // 'Paid' con mayuscula no coincidiria NUNCA: se podria invitar con una reserva sin
    // pagar sin que saltase ningun error.
    await expectReservaRechazada(
      reserva(1, { payment_status: "Paid" }),
      "bookings_payment_status_allowed",
    );
  });

  it("acepta payment_status null, porque la spec lo deja nullable", async () => {
    await expect(insertBooking("a", reserva(1))).resolves.toBeDefined();
  });

  it("rechaza un menor sin los datos de su tutor", async () => {
    // `is_minor` se calcula en servidor (T14c), pero el `check` es la segunda capa: sin
    // el, un bug de calculo dejaria reservar a un menor sin tutor ni consentimiento.
    await expectReservaRechazada(
      reserva(1, { is_minor: true, player_birth_date: "2015-06-01" }),
      "bookings_minor_guardian_required",
    );
  });

  it("acepta un menor con los 4 datos de tutor y el consentimiento puesto", async () => {
    await expect(
      insertBooking(
        "a",
        reserva(1, {
          is_minor: true,
          player_birth_date: "2015-06-01",
          guardian_name: "Tutora Legal",
          guardian_email: "tutora@example.test",
          guardian_phone: "600000000",
          guardian_consent_at: "2026-03-01T10:00:00Z",
          guardian_relation: "madre",
        }),
      ),
    ).resolves.toBeDefined();
  });

  it("acepta un mayor sin tutor, porque los datos de tutor son solo de los menores", async () => {
    await expect(insertBooking("a", reserva(1))).resolves.toBeDefined();
  });

  it("rechaza un guardian_relation que no existe", async () => {
    await expectReservaRechazada(
      reserva(1, { guardian_relation: "abuela" }),
      "bookings_guardian_relation_allowed",
    );
  });

  it("rechaza un reembolso mayor que lo pagado", async () => {
    // El techo de la politica de cancelacion es 100%, pero el `check` lo garantiza en la
    // base: sin el, un bug de T14b devolveria mas de lo que el socio pago.
    await expectReservaRechazada(
      reserva(1, { amount_refunded_cents: 2501 }),
      "bookings_refund_amount_range",
    );
  });

  it("acepta un reembolso igual a lo pagado, que es la cancelacion con 100%", async () => {
    await expect(
      insertBooking("a", reserva(1, { status: "cancelled", amount_refunded_cents: 2500 })),
    ).resolves.toBeDefined();
  });

  it("rechaza un precio negativo", async () => {
    await expectReservaRechazada(reserva(1, { price_cents: -1 }), "bookings_price_non_negative");
  });

  it("rechaza un player_name en blanco", async () => {
    // Una reserva sin quien la hizo no se puede mostrar en "mis reservas" ni invitar.
    await expectReservaRechazada(reserva(1, { player_name: "   " }), "bookings_player_name_not_blank");
  });

  it("rechaza un price_breakdown ausente, que es lo que explica el precio", async () => {
    // El importe se congela en la reserva, asi que sin el desglose nadie puede saber
    // despues por que ese slot costaba 25 o 40 euros.
    //
    // El assert mira la COLUMNA y no un nombre de restriccion, porque los `not null` de
    // PostgreSQL 17 no aparecen en `pg_constraint` (no son una restriccion de dominio
    // con nombre) y el mensaje de error solo nombra la columna. Es el unico assert del
    // fichero que no puede mirar un nombre, y por eso se dice aqui.
    const { price_breakdown: _omitido, ...sinDesglose } = reserva(1);
    await expectReservaRechazada(sinDesglose, "price_breakdown");
  });

  it("rechaza un user_id que no existe en auth.users", async () => {
    await expectReservaRechazada(
      reserva(1, { user_id: "00000000-0000-4000-8000-0000000000ff" }),
      "bookings_user_id_fkey",
    );
  });
});

describe("T9: la limpieza perezosa libera los holds caducados", () => {
  it("expira los caducados, deja los vigentes y devuelve cuantos toco", async () => {
    const resultado = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
            hold_expires_at, price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500, '{}', 'Caducado'),
                ($8, $2, $3, $4, $9, $10, 'held', $11, 2500, '{}', 'Vigente')`,
        [
          bookingId(1),
          TENANT_IDS.a,
          COURT_IDS.a,
          USER_IDS.a,
          VENTANAS.limpieza.inicio,
          VENTANAS.limpieza.fin,
          EXPIRA_PASADO,
          bookingId(2),
          VENTANAS.limpiezaTarde.inicio,
          VENTANAS.limpiezaTarde.fin,
          EXPIRA_FUTURO,
        ],
      );

      const llamada = await db.query<{ expiradas: number }>(
        `select public.expire_stale_holds($1, $2) as expiradas`,
        [TENANT_IDS.a, COURT_IDS.a],
      );

      const estados = await db.query<{ player_name: string; status: string }>(
        `select player_name, status
           from public.bookings
          where id = any($1)`,
        [[bookingId(1), bookingId(2)]],
      );

      return { expiradas: llamada.rows[0]?.expiradas, estados: estados.rows };
    });

    expect(resultado.expiradas).toBe(1);
    expect(resultado.estados).toHaveLength(2);
    expect(resultado.estados.find((fila) => fila.player_name === "Caducado")?.status).toBe("expired");
    expect(resultado.estados.find((fila) => fila.player_name === "Vigente")?.status).toBe("held");
  });

  it("la ventana del hold caducado queda libre despues de la limpieza", async () => {
    // Este es el efecto que importa: T11 llama a la limpieza dentro de la misma
    // transaccion que el INSERT, y este test es el que demuestra que el hueco se abre.
    await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
            hold_expires_at, price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500, '{}', 'Caducado')`,
        [
          bookingId(1),
          TENANT_IDS.a,
          COURT_IDS.a,
          USER_IDS.a,
          VENTANAS.limpieza.inicio,
          VENTANAS.limpieza.fin,
          EXPIRA_PASADO,
        ],
      );
      await db.query(`select public.expire_stale_holds($1, $2)`, [TENANT_IDS.a, COURT_IDS.a]);

      // Con `status` a 'held' y caducidad en el futuro, esta reserva solo entra si la
      // anterior ha dejado de bloquear el `EXCLUDE`.
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
            hold_expires_at, price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500, '{}', 'Nueva')`,
        [
          bookingId(2),
          TENANT_IDS.a,
          COURT_IDS.a,
          USER_IDS.a,
          VENTANAS.limpieza.inicio,
          VENTANAS.limpieza.fin,
          EXPIRA_FUTURO,
        ],
      );
    });
  });

  it("la limpieza se mide por hold_expires_at, no por starts_at", async () => {
    // Un hold caduca minutos despues de crearse. Si la limpieza mirase `starts_at`, un
    // hold de una reserva de manana seguiria vivo toda la tarde bloqueando la pista
    // hasta el dia siguiente, y este test fallaria con 0 en vez de 1.
    const expiradas = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
            hold_expires_at, price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500, '{}', 'Manana')`,
        [
          bookingId(1),
          TENANT_IDS.a,
          COURT_IDS.a,
          USER_IDS.a,
          "2026-03-10T09:00:00Z",
          "2026-03-10T10:30:00Z",
          EXPIRA_PASADO,
        ],
      );
      const llamada = await db.query<{ expiradas: number }>(
        `select public.expire_stale_holds($1, $2) as expiradas`,
        [TENANT_IDS.a, COURT_IDS.a],
      );
      return llamada.rows[0]?.expiradas;
    });

    expect(expiradas).toBe(1);
  });

  it("con argumentos de otro tenant no toca nada", async () => {
    // La RLS ya lo impediria (el `UPDATE` del otro tenant no ve filas), pero el filtro
    // por argumentos es lo que hace que la funcion sea segura por contrato, sin
    // depender de la politica. Sin el, un bug en T11 pasaria el tenant equivocado y no
    // se veria en ningun test.
    const expiradas = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
            hold_expires_at, price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500, '{}', 'Propia')`,
        [
          bookingId(1),
          TENANT_IDS.a,
          COURT_IDS.a,
          USER_IDS.a,
          VENTANAS.limpieza.inicio,
          VENTANAS.limpieza.fin,
          EXPIRA_PASADO,
        ],
      );
      const llamada = await db.query<{ expiradas: number }>(
        `select public.expire_stale_holds($1, $2) as expiradas`,
        [TENANT_IDS.b, COURT_IDS.b],
      );
      const estado = await db.query<{ status: string }>(
        `select status from public.bookings where id = $1`,
        [bookingId(1)],
      );
      return { expiradas: llamada.rows[0]?.expiradas, estado: estado.rows[0]?.status };
    });

    expect(expiradas.expiradas).toBe(0);
    expect(expiradas.estado).toBe("held");
  });

  it("con otra pista del mismo tenant no toca nada", async () => {
    const expiradas = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
            hold_expires_at, price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500, '{}', 'Propia')`,
        [
          bookingId(1),
          TENANT_IDS.a,
          COURT_IDS.a,
          USER_IDS.a,
          VENTANAS.limpieza.inicio,
          VENTANAS.limpieza.fin,
          EXPIRA_PASADO,
        ],
      );
      const llamada = await db.query<{ expiradas: number }>(
        `select public.expire_stale_holds($1, $2) as expiradas`,
        [TENANT_IDS.a, COURT_IDS.b],
      );
      return llamada.rows[0]?.expiradas;
    });

    expect(expiradas).toBe(0);
  });

  it("sin argumentos expira los caducados de los dos tenants, que es lo que llama el cron", async () => {
    // El cron no sabe de tenants: llama `expire_stale_holds()` a secas, con
    // `service_role`. Esta es la unica forma de que esa via este probada: si el
    // recorrido con argumentos y el sin argumentos se separaran, la red de seguridad de
    // produccion no tendria ningun test.
    const resultado = await enTransaccionAdmin(async (db) => {
      for (const key of ["a", "b"] as const) {
        await db.query(
          `insert into public.bookings
             (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
              hold_expires_at, price_cents, price_breakdown, player_name)
           values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500, '{}', $8)`,
          [
            bookingId(key === "a" ? 1 : 2),
            TENANT_IDS[key],
            COURT_IDS[key],
            USER_IDS[key],
            VENTANAS.limpieza.inicio,
            VENTANAS.limpieza.fin,
            EXPIRA_PASADO,
            `Caducado ${key.toUpperCase()}`,
          ],
        );
      }

      const llamada = await db.query<{ expiradas: number }>(
        `select public.expire_stale_holds() as expiradas`,
      );
      const estados = await db.query<{ status: string }>(
        `select status from public.bookings where id = any($1)`,
        [[bookingId(1), bookingId(2)]],
      );
      return { expiradas: llamada.rows[0]?.expiradas, estados: estados.rows };
    });

    expect(resultado.expiradas).toBe(2);
    expect(resultado.estados.every((fila) => fila.status === "expired")).toBe(true);
  });
});

describe("T9: el precio de la reserva es un snapshot", () => {
  it("cambiar el estado no recalcula ni el importe ni el desglose", async () => {
    // Si el precio se calculara al leer, un cambio de tarifa del club alteraria reservas
    // ya cobradas. Aqui se confirma y se cancela, y lo que hay en la fila no se mueve.
    const resultado = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status, hold_expires_at,
            price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', $7, 2500, $8, 'Socio')`,
        [
          bookingId(1),
          TENANT_IDS.a,
          COURT_IDS.a,
          USER_IDS.a,
          VENTANAS.ajena.inicio,
          VENTANAS.ajena.fin,
          EXPIRA_FUTURO,
          '{"regla":"pista","total_cents":2500}',
        ],
      );
      await db.query(
        `update public.bookings set status = 'confirmed', payment_status = 'paid' where id = $1`,
        [bookingId(1)],
      );

      const fila = await db.query<{ price_cents: number; price_breakdown: { regla: string } }>(
        `select price_cents, price_breakdown from public.bookings where id = $1`,
        [bookingId(1)],
      );
      return fila.rows[0];
    });

    expect(resultado?.price_cents).toBe(2500);
    expect(resultado?.price_breakdown.regla).toBe("pista");
  });

  it("el snapshot del tramo de reembolso se puede guardar al cancelar", async () => {
    // Columnas de T8 aterrizadas en la reserva: sin ellas, "me devolvieron el 50%" habria
    // que responderlo recalculando contra una politica que el club pudo cambiar.
    const resultado = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status,
            price_cents, price_breakdown, player_name, refund_tier_hours_before,
            refund_percent_applied)
         values ($1, $2, $3, $4, $5, $6, 'cancelled', 2500, '{}', 'Socio', 12, 50)`,
        [
          bookingId(1),
          TENANT_IDS.a,
          COURT_IDS.a,
          USER_IDS.a,
          VENTANAS.ajena.inicio,
          VENTANAS.ajena.fin,
        ],
      );
      const fila = await db.query<{ refund_tier_hours_before: number; refund_percent_applied: number }>(
        `select refund_tier_hours_before, refund_percent_applied
           from public.bookings where id = $1`,
        [bookingId(1)],
      );
      return fila.rows[0];
    });

    expect(resultado?.refund_tier_hours_before).toBe(12);
    expect(resultado?.refund_percent_applied).toBe(50);
  });
});
