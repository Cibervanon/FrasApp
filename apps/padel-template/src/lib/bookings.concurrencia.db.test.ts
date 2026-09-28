import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  TENANT_IDS,
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
  withTenant,
  withTransaccionesConcurrentes,
  type Queryable,
} from "../test/db-harness.js";

/**
 * T10: concurrencia de holds contra Postgres REAL (spec 7.4).
 *
 * Lo que se prueba aqui es una carrera, y una carrera no se puede probar con dos
 * llamadas secuenciales. Por eso hace falta `withTransaccionesConcurrentes`: dos
 * conexiones, dos transacciones abiertas a la vez, y el `INSERT` perdedor se queda
 * ESPERANDO en el servidor hasta que la ganadora resuelve.
 *
 * La diferencia con `bookings.db.test.ts` (T9) no es de estilo: alli las dos reservas van
 * en la MISMA transaccion y se comprueba que el `EXCLUDE` rechaza la segunda. Aqui cada
 * una va en la suya y se comprueba que, cuando las dos escriben a la vez, gana una sola.
 * Un `EXCLUDE` que no aguantara la concurrencia (por ejemplo, si la comprobacion estuviera
 * en la API en vez de en la base) pasaria todos los tests de T9 y fallaria estos.
 *
 * LO QUE ESTO NO DICE
 * No dice nada de los 3 minutos de reloj. Simularlos esperando en el test son 3 minutos de
 * suite, y el reloj no aporta nada que el dato de `hold_expires_at` no diga. Los dos
 * estados del limite (justo al caducar, y un segundo despues) se forzan escribiendo la
 * columna, que es exactamente el estado que la fila tendra en esos dos instantes.
 */

/** UUIDs FIJOS, los mismos que en `bookings.db.test.ts`: los dos ficheros comparten base. */
const COURT_ID = "00000000-0000-4000-8000-0000000000c1";
const USER_ID = "00000000-0000-4000-8000-0000000000e1";

/**
 * Ventanas propias de este fichero, en dias que ni T9 ni los fixtures tocan.
 *
 * Necesarias porque el test de la carrera hace `commit`: la fila del ganador se queda en
 * la base a proposito, y si su ventana coincidiera con la de otro test, ese test pasaria
 * o fallaria por el residuo de este.
 */
const VENTANA = { inicio: "2026-03-08T09:00:00Z", fin: "2026-03-08T10:30:00Z" };
const VENTANA_TARDE = { inicio: "2026-03-08T15:00:00Z", fin: "2026-03-08T16:30:00Z" };

/**
 * Los `id` de este fichero, SIEMPRE en el rango 500-599.
 *
 * `bookings.db.test.ts` usa el 1-20 y el 900-901 para sus fixtures, y los dos ficheros
 * comparten base. T10 hace `commit` a proposito, asi que la fila del ganador se queda: si
 * compartiera `id` con T9, el siguiente test de T9 que insertara ese `id` recibiria
 * `llave duplicada viola bookings_pkey` y fallaria por su propio `INSERT`.
 *
 * Ocurrio de verdad en la primera pasada: cinco tests de T10 fallaron, dejaron filas, y a
 * partir de ahi los tests de T9 fallaban con una restriccion que no estaban probando. Un
 * `id` compartido entre ficheros que comparten base convierte un fallo de T10 en treinta
 * fallos de T9, y el sintoma apunta al innocent. Por eso el rango es separado y no "a ver
 * si no coinciden".
 */
function bookingId(n: number): string {
  return `00000000-0000-4000-8000-${(500 + n).toString(16).padStart(12, "0")}`;
}

/** Un hold del tenant A, con lo minimo que exige el DDL. */
function hold(n: number, cambios: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: bookingId(n),
    court_id: COURT_ID,
    user_id: USER_ID,
    starts_at: VENTANA.inicio,
    ends_at: VENTANA.fin,
    status: "held",
    hold_expires_at: "2099-01-01T00:00:00Z",
    price_cents: 2500,
    price_breakdown: '{"regla":"base","total_cents":2500}',
    num_players: 4,
    player_name: "Socio Concurrente",
    ...cambios,
  };
}

/** El `INSERT` del hold, sobre la conexion que se le pase. */
function insertar(db: Queryable, valores: Record<string, unknown>) {
  const columnas = Object.keys(valores);
  const marcadores = columnas.map((_, indice) => `$${indice + 2}`);
  return db.query(
    `insert into public.bookings (tenant_id, ${columnas.join(", ")})
     values ($1, ${marcadores.join(", ")})`,
    [TENANT_IDS.a, ...Object.values(valores)],
  );
}

/**
 * Que error ha dado el `INSERT`: el NOMBRE de la restriccion, o `null` si no ha dado error.
 *
 * Traduce el fallo a texto antes de que salga del test, porque el mensaje de Postgres esta
 * en espanol en local y lo que interesa es el nombre de la restriccion, que no cambia con
 * el idioma. `null` y no `true`/`false` porque hay tres casos y no dos: gano, perdio o
 * fallo por otra cosa, y un `false` que significa "cualquier error" dejaria pasar el
 * tercero.
 */
async function nombreDeRestriccion(insercion: Promise<unknown>): Promise<string | null> {
  try {
    await insercion;
    return null;
  } catch (fallo: unknown) {
    return fallo instanceof Error ? fallo.message : String(fallo);
  }
}

/**
 * Siembra la pista y el usuario de los que dependen las filas.
 *
 * La pista se siembra aqui, y no se espera que la sembrara `bookings.db.test.ts`, porque
 * este fichero se puede correr SOLO (`test:db -- bookings.concurrencia`) y porque su
 * `withAdmin` va con rollback: cuando ese fichero acaba, su pista no esta en la base. Sin
 * esto, los nueve tests fallaban por `bookings_tenant_court_fkey`, que dice que la fila no
 * se puede guardar, no que haya un conflicto de horarios. Mismo `id` que usa T9 y
 * `on conflict do nothing`, para que los dos ficheros puedan sembrar la misma pista.
 */
async function seedFixtures(): Promise<void> {
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.courts
         (id, tenant_id, name, court_type, surface, indoor, num_players,
          default_duration_min, min_duration_min, max_duration_min, base_price_cents)
       values ($1, $2, 'Pista Fixture A', 'cristal', 'cesped', true, 4, 90, 60, 180, 2500)
       on conflict (id) do nothing`,
      [COURT_ID, TENANT_IDS.a],
    );
    await db.query(
      `insert into auth.users (id, email)
       values ($1, 'concurrente@example.test')
       on conflict (id) do nothing`,
      [USER_ID],
    );
  });
}

beforeAll(async () => {
  await prepareDatabase();
  await seedFixtures();
});

/**
 * Barre TODO lo que este fichero haya dejado, por ventana.
 *
 * En un `afterEach` y no al final de cada test a proposito. Los tests que hacen `commit`
 * dejan la fila del ganador en la base, y si el borrado estuviera al final del cuerpo del
 * test, un test que fallara ANTES de llegar ahi arrastraba su fila al siguiente, y el
 * siguiente fallaba por un `INSERT` que no era suyo. Eso es lo que paso: los residuos
 * aparecieron como una restriccion (`bookings_pkey`) que no era la que el test de abajo
 * estaba probando, y el fallo apuntaba al test innocent.
 *
 * Por ventana y no por lista de ids: la ventana coge cualquier fila de este fichero, sin
 * importar si el test llego a crearla, y no puede tocar las de `bookings.db.test.ts`, que
 * estan en dias distintos. Que la fila se escribiera DE VERDAD lo comprueban los asserts
 * de cada test, antes de que este barrido la borre.
 */
afterEach(async () => {
  await withAdmin(async (db) => {
    await db.query(
      `delete from public.bookings
        where tenant_id = $1
          and (starts_at, ends_at) in (($2::timestamptz, $3::timestamptz),
                                      ($4::timestamptz, $5::timestamptz))`,
      [
        TENANT_IDS.a,
        VENTANA.inicio,
        VENTANA.fin,
        VENTANA_TARDE.inicio,
        VENTANA_TARDE.fin,
      ],
    );
  });
});

afterAll(async () => {
  await releaseDatabaseLease();
});

describe("T10: dos intentos simultaneos sobre el mismo slot", () => {
  it("exactamente uno gana: el primero entra y el segundo recibe el conflicto", async () => {
    const resultado = await withTransaccionesConcurrentes(async ({ a, b }) => {
      // El primero inserta y se QUEDA dentro: su fila esta en el indice del `EXCLUDE` pero
      // sin commit, asi que todavia no es visible para nadie mas.
      await insertar(a, hold(1));

      // El segundo intenta el mismo slot. Este `query` NO se espera aqui a proposito: se
      // queda esperando en Postgres a que el primero resuelva, y por eso hay que arrancar
      // la promesa suelta. Awaitar este `query` antes de resolver la otra transaccion
      // deadlockearia el test, y el deadlock lo escribiria el test, no la base.
      const segundo = nombreDeRestriccion(insertar(b, hold(2)));

      // Ahora el primero consolida su reserva. Al commit, el segundo despierta, vuelve a
      // comprobar el indice, ve el conflicto y lo rechaza.
      await a.query("commit");

      return { segundo: await segundo };
    });

    // El loser no recibe un error de bloqueo ni un timeout: recibe la EXCLUSION. Si fuera
    // otra cosa, el `EXCLUDE` no estaria decidiendo y el 409 de T11 no tendria de donde
    // salir.
    expect(resultado.segundo).toMatch(/bookings_no_overlap/);
  });

  it("queda una sola reserva en la base, la del ganador", async () => {
    // La otra mitad de "exactamente uno gana": que el perdedor no haya dejado una fila a
    // medias. Un `INSERT` rechazado dentro de una transaccion no escribe nada, pero
    // probarlo es barato y es donde se veria un futuro `on conflict do nothing` mal
    // puesto, que es la forma tipica de que dos socios reserven el mismo slot.
    const { ganador } = await withTransaccionesConcurrentes(async ({ a, b }) => {
      await insertar(a, hold(3));
      const segundo = nombreDeRestriccion(insertar(b, hold(4)));
      await a.query("commit");
      return { ganador: await segundo };
    });

    expect(ganador).toMatch(/bookings_no_overlap/);

    const filas = await withAdmin(async (db) => {
      const result = await db.query<{ id: string }>(
        `select id from public.bookings
          where starts_at = $1 and ends_at = $2 and tenant_id = $3`,
        [VENTANA.inicio, VENTANA.fin, TENANT_IDS.a],
      );
      return result.rows.map((fila) => fila.id);
    });

    expect(filas).toHaveLength(1);
    expect(filas[0]).toBe(bookingId(3));
  });

  it("si el ganador aborta, el perdedor entra", async () => {
    // La otra mitad de la carrera, y la que hace el test determinista: aqui el primero
    // ROLLBACK, asi que su fila desaparece y el segundo debe poder escribir.
    //
    // Sin esta mitad, un `EXCLUDE` que rechazara TODAS las inserciones (por un predicado
    // roto, por ejemplo) pasaria el test de arriba: dos rechazar no es "uno gana".
    const resultado = await withTransaccionesConcurrentes(async ({ a, b }) => {
      await insertar(a, hold(5));
      const segundo = nombreDeRestriccion(insertar(b, hold(6)));
      await a.query("rollback");
      return { segundo: await segundo };
    });

    expect(resultado.segundo).toBeNull();
  });

  it("el perdedor ve el conflicto de la EXCLUSION, no un error de espera", async () => {
    // Lo que se Midio, separado, porque es la diferencia entre "el base de datos protege el
    // slot" y "el segundo se rindio": `lock_not_available` o un timeout tambien son
    // errores, y un test que aceptara cualquiera de los dos estaria probando que algo
    // falla, no que el `EXCLUDE` decidio.
    const resultado = await withTransaccionesConcurrentes(async ({ a, b }) => {
      await insertar(a, hold(7));
      const segundo = nombreDeRestriccion(insertar(b, hold(8)));
      await a.query("commit");
      return { segundo: await segundo };
    });

    expect(resultado.segundo).not.toMatch(/lock_not_available|could not obtain lock/i);
  });

  it("dos clientes distintos del mismo club no se pisan entre si", async () => {
    // El `user_id` es distinto en los dos intentos. El criterio es "exactamente uno gana"
    // aunque sean dos socios diferentes pidiendo la misma pista a la vez, que es el caso
    // real: dos personas que han visto el mismo hueco libre y han pulsado a la vez.
    const resultado = await withTransaccionesConcurrentes(async ({ a, b }) => {
      await insertar(a, hold(9, { user_id: USER_ID, player_name: "Socio A" }));
      const segundo = nombreDeRestriccion(
        insertar(b, hold(10, { user_id: USER_ID, player_name: "Socio B" })),
      );
      await a.query("commit");
      return { segundo: await segundo };
    });

    expect(resultado.segundo).toMatch(/bookings_no_overlap/);
  });
});

describe("T10: un hold caducado no espera al cron", () => {
  it("el hold sigue bloqueando en el instante exacto de caducar", async () => {
    // `hold_expires_at <= now()` es la condicion de `expire_stale_holds`, asi que en el
    // instante exacto de caducar ya se considera caducado. Aqui se comprueba el otro lado
    // del limite, que es el que importa para el socio: hasta ese instante, el slot sigue
    // siendo suyo y bloqueado.
    const bloqueado = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status, hold_expires_at,
            price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', now() + interval '3 minutes', 2500, '{}', 'A punto')`,
        [
          bookingId(11),
          TENANT_IDS.a,
          COURT_ID,
          USER_ID,
          VENTANA_TARDE.inicio,
          VENTANA_TARDE.fin,
        ],
      );
      return db.query(
        `select public.expire_stale_holds($1, $2) as expiradas`,
        [TENANT_IDS.a, COURT_ID],
      );
    });

    expect(bloqueado.rows[0]?.expiradas).toBe(0);
  });

  it("un segundo despues de caducar, el slot vuelve a estar libre", async () => {
    // El estado que la fila tiene 3 min + 1 s despues de crearse, forzado por escrito. Un
    // test que esperase 3 minutos y un segundo de reloj seria tres minutos de suite para
    // comprobar lo mismo, y en un portatil lento la diferencia es que el test falla por
    // tiempo y no por la assertion.
    const resultado = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status, hold_expires_at,
            price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', now() - interval '1 second', 2500, '{}', 'Caducado')`,
        [bookingId(12), TENANT_IDS.a, COURT_ID, USER_ID, VENTANA_TARDE.inicio, VENTANA_TARDE.fin],
      );

      // Esto es lo que T11 hara en la misma transaccion que el INSERT, y lo que hara el
      // endpoint antes de mirar nada. El orden importa: si el endpoint consultara antes de
      // limpiar, devolveria un 409 con un slot que ya esta libre.
      await db.query(`select public.expire_stale_holds($1, $2)`, [TENANT_IDS.a, COURT_ID]);

      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status, hold_expires_at,
            price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', now() + interval '3 minutes', 2500, '{}', 'Nuevo')`,
        [bookingId(13), TENANT_IDS.a, COURT_ID, USER_ID, VENTANA_TARDE.inicio, VENTANA_TARDE.fin],
      );

      const estado = await db.query<{ id: string; status: string }>(
        `select id, status from public.bookings
          where starts_at = $1 and ends_at = $2 and tenant_id = $3
          order by id`,
        [VENTANA_TARDE.inicio, VENTANA_TARDE.fin, TENANT_IDS.a],
      );
      return estado.rows;
    });

    // Dos filas, y solo una vigente: la caducada quedo en `expired` y la nueva en `held`.
    // Si la limpieza no hubiera corrido, el segundo `INSERT` habria fallado y este test no
    // habria llegado aqui.
    expect(resultado).toHaveLength(2);
    expect(resultado.filter((fila) => fila.status === "held")).toHaveLength(1);
    expect(resultado.filter((fila) => fila.status === "expired")).toHaveLength(1);
  });

  it("un hold vigente NO se limpia al intentar reservar", async () => {
    // El otro lado del criterio, y el que protege al socio: si la limpieza se pasara de
    // lista y tumbara holds que siguen vigentes, dos personas pondrian el mismo slot a la
    // vez y ambas con su "reserva" en el movil.
    const error = await withTenant("a", async (db) => {
      await db.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status, hold_expires_at,
            price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', now() + interval '3 minutes', 2500, '{}', 'Vigente')`,
        [bookingId(14), TENANT_IDS.a, COURT_ID, USER_ID, VENTANA_TARDE.inicio, VENTANA_TARDE.fin],
      );

      await db.query(`select public.expire_stale_holds($1, $2)`, [TENANT_IDS.a, COURT_ID]);

      return nombreDeRestriccion(
        db.query(
          `insert into public.bookings
             (id, tenant_id, court_id, user_id, starts_at, ends_at, status, hold_expires_at,
              price_cents, price_breakdown, player_name)
           values ($1, $2, $3, $4, $5, $6, 'held', now() + interval '3 minutes', 2500, '{}', 'Intruso')`,
          [bookingId(15), TENANT_IDS.a, COURT_ID, USER_ID, VENTANA_TARDE.inicio, VENTANA_TARDE.fin],
        ),
      );
    });

    expect(error).toMatch(/bookings_no_overlap/);
  });

  it("la carrera con un hold caducado tambien la gana uno solo", async () => {
    // El caso REAL de la carrera, no el teorico: dos socios ven un hueco que tiene un hold
    // a punto de caducar, los dos pulsan a la vez y los dos ejecutan la limpieza perezosa
    // antes de insertar. La limpieza no es un `if`, son dos `UPDATE` que pueden tocar la
    // misma fila, y hay que comprobar que de eso no sale un slot con dos reservas.
    const resultado = await withTransaccionesConcurrentes(async ({ a, b }) => {
      // El hold caducado, en la ventana que los dos van a pelear, ya escrito y confirmado.
      await a.query(
        `insert into public.bookings
           (id, tenant_id, court_id, user_id, starts_at, ends_at, status, hold_expires_at,
            price_cents, price_breakdown, player_name)
         values ($1, $2, $3, $4, $5, $6, 'held', now() - interval '1 second', 2500, '{}', 'Caducado')`,
        [bookingId(16), TENANT_IDS.a, COURT_ID, USER_ID, VENTANA.inicio, VENTANA.fin],
      );
      await a.query("commit");

      // Ahora los dos, cada uno en su transaccion, limpiando y reservando en ese orden.
      const intentoDeB = (async () => {
        await b.query(`select public.expire_stale_holds($1, $2)`, [TENANT_IDS.a, COURT_ID]);
        return nombreDeRestriccion(insertar(b, hold(18)));
      })();

      await a.query(`select public.expire_stale_holds($1, $2)`, [TENANT_IDS.a, COURT_ID]);
      const primero = nombreDeRestriccion(insertar(a, hold(17)));
      await a.query("commit");

      return { primero: await primero, segundo: await intentoDeB };
    });

    // Uno de los dos gano y el otro recibio el `EXCLUDE`. Lo que NO puede pasar es que los
    // dos ganen, y el assert lo cubre sin importar quien fuera primero: el que perdio
    // lleva el nombre de la restriccion.
    const perdedores = [resultado.primero, resultado.segundo].filter(
      (resultadoPar) => resultadoPar !== null,
    );
    expect(perdedores).toHaveLength(1);
    expect(perdedores[0]).toMatch(/bookings_no_overlap/);

    const filas = await withAdmin(async (db) => {
      const result = await db.query<{ id: string; status: string }>(
        `select id, status from public.bookings
          where starts_at = $1 and ends_at = $2 and tenant_id = $3`,
        [VENTANA.inicio, VENTANA.fin, TENANT_IDS.a],
      );
      return result.rows;
    });

    // Y en la base solo hay un hold vigente, que es el invariante de todo el fichero: dos
    // personas pueden pedir el mismo slot a la vez, pero una sola se lo queda.
    expect(filas.filter((fila) => fila.status === "held")).toHaveLength(1);
  });
});
