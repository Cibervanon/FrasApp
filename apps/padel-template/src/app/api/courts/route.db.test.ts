import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GET } from "./route";
import { closePool } from "../../../lib/server/db";
import { clearTenantCache } from "../../../lib/server/tenant";
import {
  prepareDatabase,
  releaseDatabaseLease,
  TENANT_IDS,
  withAdmin,
} from "../../../test/db-harness";

/**
 * T5c: `GET /api/courts`.
 *
 * El endpoint mas simple de T5, y el que demuestra que la capa de T5a funciona contra algo
 * real. Aqui no hay logica de disponibilidad ni de precios: hay una consulta y un `json`.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE ESTE FICHERO SE SIEMBRA SUS PROPIOS TENANTS
 *
 * `courts.db.test.ts` (T4) siembra sus fixtures con `withAdmin`, que no lleva rollback, y no
 * los borra nunca: tienen que sobrevivir a su fichero para que los tests que vienen despues
 * vean el mismo estado. Es la decision correcta alli, y es la que hace que este endpoint NO
 * pueda afirmar `toEqual([una pista])` sobre `club-a` o `club-b`: cuando los tests corren en
 * ese orden, el tenant A ya tiene "Pista Fixture A", "Pista Ocupada" y "Pista Retirada" de
 * T4, y el B tiene "Pista Fixture B".
 *
 * La primera version de estos tests hacia exactamente eso, y fallo con cuatro errores:
 *
 *   1. "devuelve las pistas activas y nada mas" devolvia las tres de T4 mas las mias.
 *   2. "un club sin pistas" apuntaba a `club-b` esperando `[]`, y `club-b` tenia la de T4 y
 *      la mia. Para pasar, habia que volver a inactivar filas de otro fichero, y un test que
 *      necesita mutar el estado de otro test para funcionar es un test que mide lo que le
 *      da la gana a quien lo escribio antes.
 *   3. "ordena por sort_order" comprobaba `sortOrder === 1` sobre la primera pista. Sin
 *      `order by` en la SQL, Postgres devuelve las filas en un orden que depende del
 *      heap, y aqui habia tres filas de T4 con `sort_order = 0` delante, asi que el assert
 *      fallaba por los fixtures ajenos y no por el ORDER BY. Un test de orden con una sola
 *      fila visible no prueba el orden: cualquier consulta lo devuelve "bien".
 *   4. El comparador `Object.keys(pista ?? {})` ya estaba bien, pero por suerte.
 *
 * La salida es NO usar los tenants del harness. Este fichero crea los suyos, con `withAdmin`
 * como hace T4, y los borra en `afterAll`. A cambio de un poco mas de codigo, los asserts
 * vuelven a ser exactos: `toEqual([...])` en vez de `toContain`, y el orden pasa a ser
 * comprobable de verdad.
 *
 * Y de paso, el tenant vacio no es una fiction: se crea aqui y no se le inserta nunca nada,
 * asi que `[]` es una propiedad de su construccion y no un arranque de lo que otro test hizo
 * antes.
 */

/** Tenant con pistas, propiedad de este fichero. */
const TENANT_PISTAS = "00000000-0000-4000-8000-0000000005c0";
const SLUG_PISTAS = "club-t5c-pistas";

/** Tenant sin ninguna pista, tambien de este fichero. Existe para el catalogo vacio. */
const TENANT_VACIO = "00000000-0000-4000-8000-0000000005d0";
const SLUG_VACIO = "club-t5c-vacio";

/**
 * Fixtures del tenant con pistas.
 *
 * El ORDEN DE INSERCION ESTA INVERTIDO A PROPOSITO. `PISTA_1` entra antes que `PISTA_2` y
 * tiene `sort_order` MAYOR (9 contra 1), asi que un `order by sort_order` da
 * `[PISTA_2, PISTA_1]`, que es justo lo que espera el test, mientras que una consulta sin
 * `order by` daria `[PISTA_1, PISTA_2]` en el orden en que quedaron en el heap. Esa es la
 * unica forma de que un assert de orden distinga "la SQL ordena" de "la tabla se ha
 * recorrido en orden".
 */
const PISTA_1 = "00000000-0000-4000-8000-0000000005c1"; // sort_order 9, insertada 1a
const PISTA_2 = "00000000-0000-4000-8000-0000000005c2"; // sort_order 1, insertada 2a
const PISTA_APAGADA = "00000000-0000-4000-8000-0000000005c3"; // is_active = false
const PISTA_RETIRADA = "00000000-0000-4000-8000-0000000005c4"; // deleted_at = now()

const MIS_FICTS = [PISTA_1, PISTA_2, PISTA_APAGADA, PISTA_RETIRADA];

/** Cuerpo de la respuesta, tipado. */
interface CourtJson {
  readonly id: string;
  readonly name: string;
  readonly courtType: string;
  readonly surface: string | null;
  readonly indoor: boolean;
  readonly numPlayers: number;
  readonly defaultDurationMin: number;
  readonly minDurationMin: number;
  readonly maxDurationMin: number;
  readonly sortOrder: number;
  readonly imagePath: string | null;
}

async function pedir(url: string): Promise<Response> {
  return GET(new Request(`http://localhost:3000${url}`));
}

async function cuerpo(url: string): Promise<CourtJson[]> {
  const response = await pedir(url);
  expect(response.status).toBe(200);
  return (await response.json()) as CourtJson[];
}

/** Apunta la instancia a `slug` y limpia la cache del tenant. */
function apuntarA(slug: string): void {
  process.env["TENANT_SLUG"] = slug;
  clearTenantCache();
}

/**
 * `where id in (...)` con la lista dada, sin la trampa del array de `pg`.
 *
 * `pg` convierte un array de JavaScript en VARIOS parametros bind, no en un array de
 * Postgres. Asi que `where id = any($1)` con `[a, b]` llega a la sentencia como dos valores
 * contra un solo hueco, y Postgres responde "entrega 2 parametros, pero la sentencia
 * requiere 1".
 *
 * El truco que usan `courts.db.test.ts` y `rls.db.test.ts` para evitarlo es `[[...TABLES]]`:
 * un array de un elemento que contiene el array, que `pg` no expande y serializa como
 * literal `{a,b}`. Funciona, y es ilegible: hay cuatro sitios en el repo que lo hacen bien y
 * uno que lo hace mal, y no se distinguen a ojo. Por eso aqui la lista se escribe en la
 * sentencia y el placeholder se genera con un indice, que es lo que el `pg` espera.
 */
function placeholders(ids: readonly string[]): string {
  return ids.map((_, index) => `$${index + 1}`).join(", ");
}

beforeAll(async () => {
  await prepareDatabase();

  // COMPROMETIDAS, por el mismo motivo que en `db.db.test.ts` y en `courts.db.test.ts`: la
  // ruta abre su propia conexion desde un pool, y una conexion no ve lo que otra tiene sin
  // confirmar. Por eso `afterAll` las borra en vez de confiar en un rollback.
  //
  // El `delete` de los tenants va PRIMERO y no en `on conflict`: si una ejecucion anterior
  // murio antes del `afterAll`, sus filas y sus pistas siguen ahi, y un `do nothing` las
  // reutilizaria con el estado que las dejó aquella corrida. Borrar y recrear hace que el
  // punto de partida sea el mismo da igual cuantas veces se haya ejecutado esto antes.
  await withAdmin(async (db) => {
    await db.query(
      `delete from public.courts where id in (${placeholders(MIS_FICTS)})`,
      [...MIS_FICTS],
    );
    await db.query(
      `delete from public.tenants where id in (${placeholders([TENANT_PISTAS, TENANT_VACIO])})`,
      [TENANT_PISTAS, TENANT_VACIO],
    );

    await db.query(
      `insert into public.tenants (id, name, slug) values ($1, 'Club T5c Con Pistas', $2)`,
      [TENANT_PISTAS, SLUG_PISTAS],
    );
    await db.query(
      `insert into public.tenants (id, name, slug) values ($1, 'Club T5c Vacio', $2)`,
      [TENANT_VACIO, SLUG_VACIO],
    );

    // `on conflict do update` de TODOS los campos, no solo del nombre. Con `do nothing`, un
    // fixture que una corrida anterior dejo con `is_active = false` volveria apagado, y el
    // catalogo vacio que se espera fallaria por un motivo que no tiene que ver con el
    // endpoint. Semejante al comentario de T4 sobre sembrar dos veces: el estado no debe
    // depender de cuantos ficheros hayan pasado antes.
    await db.query(
      `insert into public.courts
      (id, tenant_id, name, court_type, surface, indoor, num_players,
       default_duration_min, min_duration_min, max_duration_min, base_price_cents, sort_order)
      values
      ($1, $5, 'Pista T5c Norte',    'cristal', 'cesped', true,  4, 90, 60, 180, 1200, 9),
      ($2, $5, 'Pista T5c Sur',      'malla',   null,    false, 4, 60, 60, 120, 1400, 1),
      ($3, $5, 'Pista T5c Apagada',  'cristal', null,    true,  4, 90, 60, 180, 1000, 2),
      ($4, $5, 'Pista T5c Retirada', 'mixto',   null,    true,  4, 90, 60, 180, 1000, 3)
      on conflict (id) do update set
        name = excluded.name,
        court_type = excluded.court_type,
        surface = excluded.surface,
        indoor = excluded.indoor,
        num_players = excluded.num_players,
        default_duration_min = excluded.default_duration_min,
        min_duration_min = excluded.min_duration_min,
        max_duration_min = excluded.max_duration_min,
        base_price_cents = excluded.base_price_cents,
        sort_order = excluded.sort_order,
        is_active = true,
        deleted_at = null`,
      [PISTA_1, PISTA_2, PISTA_APAGADA, PISTA_RETIRADA, TENANT_PISTAS],
    );

    // La apagada se apaga y la retirada se retira DESPUES del insert, porque en el mismo
    // `values` no hay forma de poner un literal por fila sin duplicar la sentencia. El
    // `do update` de arriba deja ambas en activo para que el estado de partida sea el
    // mismo en cada corrida.
    await db.query(`update public.courts set is_active = false where id = $1`, [PISTA_APAGADA]);
    await db.query(`update public.courts set deleted_at = now() where id = $1`, [PISTA_RETIRADA]);
  });

  apuntarA(SLUG_PISTAS);
});

afterAll(async () => {
  delete process.env["TENANT_SLUG"];
  clearTenantCache();
  await withAdmin(async (db) => {
    await db.query(
      `delete from public.courts where id in (${placeholders(MIS_FICTS)})`,
      [...MIS_FICTS],
    );
    // Los tenants van detras de sus pistas: si alguna vez queda una pista huerfana, el
    // borrado del tenant lo impide, y el fallo sale en el `afterAll` y no en el siguiente
    // fichero de test, que es donde uno no sabe mirar.
    await db.query(
      `delete from public.tenants where id in (${placeholders([TENANT_PISTAS, TENANT_VACIO])})`,
      [TENANT_PISTAS, TENANT_VACIO],
    );
  });
  // Sin esto el proceso se queda vivo: un pool abierto mantiene Node en marcha.
  await closePool();
  await releaseDatabaseLease();
});

describe("T5c: GET /api/courts devuelve el catalogo del club", () => {
  it("devuelve las pistas activas, en el orden que manda el club", async () => {
    const pistas = await cuerpo("/api/courts");

    // `toEqual` y no `toContain`: aqui las unicas filas del tenant son las cuatro de este
    // fichero, asi que la lista exacta comprueba tres cosas a la vez — que entran las dos
    // activas, que no entran ni la apagada ni la retirada, y en que orden. Con `toContain`
    // el mismo test probaria una sola de las tres.
    expect(pistas.map((p) => p.id)).toEqual([PISTA_2, PISTA_1]);
  });

  it("el orden sale de la consulta, no de un .sort() del cliente", async () => {
    // Este test solo mira el `sort_order` que llega. La parte importante la hace el test
    // anterior, que con las filas insertadas en orden INVERTO al `sort_order` solo puede
    // pasar si la SQL trae el `order by`. Aqui lo que se fija es que el numero viaja
    // entero y con el nombre que el club le dio a la pista.
    const [primera] = await cuerpo("/api/courts");
    expect(primera?.id).toBe(PISTA_2);
    expect(primera?.sortOrder).toBe(1);
    expect(primera?.name).toBe("Pista T5c Sur");
  });

  it("no ve las pistas de otro club, ni aunque esten en la misma tabla", async () => {
    // Este tenant no tiene ninguna pista propia, y hay cuatro filas en `courts` de un
    // tenant que si. Que salga `[]` y no "casi []" es la prueba de que el aislamiento lo
    // pone la RLS: la fila ajena no sale de la base, asi que el handler no puede ni por
    // error imprimirla.
    apuntarA(SLUG_VACIO);
    try {
      expect(await cuerpo("/api/courts")).toEqual([]);
    } finally {
      apuntarA(SLUG_PISTAS);
    }
  });

  it("un club sin pistas devuelve una lista vacia, no un 404", async () => {
    // Un club recien dado de alta no tiene pistas todavia. Si esto fuera 404, la pantalla de
    // T6 tendria que distinguir "no hay pistas" de "el endpoint esta roto", y no puede. El
    // 404 se reserva para T5d, donde significaria algo: esa pista no es de este club.
    apuntarA(SLUG_VACIO);
    try {
      const response = await pedir("/api/courts");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual([]);
    } finally {
      apuntarA(SLUG_PISTAS);
    }
  });

  it("excluye las pistas apagadas por el gestor", async () => {
    const pistas = await cuerpo("/api/courts");
    expect(pistas.map((p) => p.id)).not.toContain(PISTA_APAGADA);
  });

  it("excluye las pistas retiradas con borrado logico", async () => {
    // `deleted_at` y `is_active` son dos cosas distintas: `is_active = false` es un cierre
    // temporal (mantenimiento, uso privado), y `deleted_at` es que la pista ya no existe. Las
    // dos se ocultan, y por motivos distintos: la segunda se podria recuperar con undelete.
    const pistas = await cuerpo("/api/courts");
    expect(pistas.map((p) => p.id)).not.toContain(PISTA_RETIRADA);
  });

  it("responde JSON", async () => {
    const response = await pedir("/api/courts");
    expect(response.headers.get("content-type")).toContain("application/json");
  });
});

describe("T5c: un tenant_id en la query se ignora (criterio 7.1)", () => {
  it("devuelve EXACTAMENTE lo mismo con y sin tenant_id", async () => {
    const sinParametro = await cuerpo("/api/courts");
    const conParametro = await cuerpo(`/api/courts?tenant_id=${TENANT_IDS.b}`);

    // La comparacion es de la respuesta COMPLETA, no de "no ha petado". Un endpoint que
    // ignorase el parametro pero devolviese 200 con el catalogo equivocado pasaria un
    // assert de "no da error" y fallaria este.
    expect(conParametro).toEqual(sinParametro);
    expect(conParametro.map((p) => p.id)).toEqual([PISTA_2, PISTA_1]);
  });

  it("tampoco con el tenant_id de un club que existe y tiene pistas de verdad", async () => {
    // `TENANT_IDS.b` no es un uuid inventado: es el tenant B de la seed, que existe y tiene
    // filas propias. Si el filtro fuera "los parametros que no existen se ignoran", este
    // pasaria y el ataque real no.
    const response = await pedir(`/api/courts?tenant_id=${TENANT_IDS.b}`);
    expect(response.status).toBe(200);
    const pistas = (await response.json()) as CourtJson[];
    expect(pistas.map((p) => p.id)).toEqual([PISTA_2, PISTA_1]);
  });

  it("ni con basura donde va el tenant_id", async () => {
    // Un `?tenant_id=lo-que-sea` tiene que ser inocuo, no un 500. Si el handler lo leyera y
    // lo casteara a uuid, este request reventaria con un error de Postgres.
    const response = await pedir("/api/courts?tenant_id=no-es-un-uuid");
    expect(response.status).toBe(200);
  });
});

describe("T5c: la forma de la respuesta", () => {
  it("los nombres van en camelCase, como los tipos de core", async () => {
    // `default_duration_min` en la base, `defaultDurationMin` en la respuesta. El mapeo es
    // aqui, en el borde, y no se propaga al cliente: la convencion la fija `packages/core`.
    const [pista] = await cuerpo("/api/courts");
    expect(pista).toBeDefined();
    expect(Object.keys(pista ?? {}).sort()).toEqual([
      "courtType",
      "defaultDurationMin",
      "id",
      "imagePath",
      "indoor",
      "maxDurationMin",
      "minDurationMin",
      "name",
      "numPlayers",
      "sortOrder",
      "surface",
    ]);
  });

  it("los valores de la fila llegan enteros y en el sitio", async () => {
    // Un mapeo que intercambia dos columnas numéricas pasa el test de las claves (los
    // nombres estan bien) y rompe la duracion. Este comprueba los valores, no el etiquetado.
    const pistas = await cuerpo("/api/courts");
    const sur = pistas.find((p) => p.id === PISTA_2);
    expect(sur).toMatchObject({
      name: "Pista T5c Sur",
      courtType: "malla",
      surface: null,
      indoor: false,
      numPlayers: 4,
      defaultDurationMin: 60,
      minDurationMin: 60,
      maxDurationMin: 120,
      sortOrder: 1,
      imagePath: null,
    });
  });

  it("NO devuelve base_price_cents: el precio es de T7", async () => {
    // Es una decision, y por eso hay un test que la fija. Si `/api/courts` empezara a
    // devolver el precio base, T6 construiria la pantalla de reservas sobre un numero que
    // T7 va a sustituir por el resuelto, y ese trabajo habria que rehacer. `base_price_cents`
    // es solo el respaldo de la ultima regla (7.3), no el precio que se ve.
    const [pista] = await cuerpo("/api/courts");
    expect(pista).not.toHaveProperty("basePriceCents");
  });

  it("NO devuelve tenant_id", async () => {
    // Devolverlo invita a mandarlo de vuelta. El criterio 7.1 dice que se ignora, y esto es
    // la primera mitad de no crearlo: el cliente no llega a tener el valor.
    const [pista] = await cuerpo("/api/courts");
    expect(pista).not.toHaveProperty("tenantId");
  });
});

/**
 * Pone `TENANT_SLUG`, pide el catalogo, y devuelve `[status, cuerpo]`.
 *
 * El `finally` es la parte importante: sin el, un test que falla a mitad deja el
 * `TENANT_SLUG` del siguiente apuntando a otra cosa y el rojo se propaga a ficheros que
 * no tienen nada que ver con este.
 */
async function pedirCon(
  slug: string | undefined,
  url = "/api/courts",
): Promise<{ status: number; cuerpo: string }> {
  const anterior = process.env["TENANT_SLUG"];
  if (slug === undefined) delete process.env["TENANT_SLUG"];
  else process.env["TENANT_SLUG"] = slug;
  // SIEMPRE, en los dos casos. Al meter la cache dentro de `apuntarA` se perdio el
  // `clearTenantCache` de la rama que borra la variable, y `resolveTenantId` devolvio el
  // tenant memoizado con el entorno vacio: el endpoint respondio 200 con el catalogo
  // entero. El test que se suponia que tenia que dar 500 dio 200, y el de "los dos fallos
  // dan el mismo cuerpo" paso por casualidad, porque el test anterior habia dejado la
  // cache a null. Dos tests verdes y un bug: por eso el `clearTenantCache` no va dentro de
  // la otra funcion, sino aqui, justo despues de tocar el entorno y en las dos ramas.
  clearTenantCache();
  try {
    const response = await pedir(url);
    return { status: response.status, cuerpo: await response.text() };
  } finally {
    if (anterior === undefined) delete process.env["TENANT_SLUG"];
    else process.env["TENANT_SLUG"] = anterior;
    clearTenantCache();
  }
}

describe("T5c: cuando el despliegue esta roto", () => {
  it("sin TENANT_SLUG responde 500 y no dice cual era el problema", async () => {
    const { status, cuerpo } = await pedirCon(undefined);
    expect(status).toBe(500);
    // El mensaje de `resolveTenantId` dice el slug, el nombre de la tabla y que copies el
    // `.env.example`. Eso es para quien despliega, y va al log del servidor. Un visitante que
    // lo recibe aprende como esta montado el despliegue del club: que hay una tabla
    // `tenants`, que el club se elige por slug, y de donde sale.
    expect(cuerpo).not.toContain("TENANT_SLUG");
    expect(cuerpo).not.toContain("env.example");
    expect(cuerpo).not.toContain("public.tenants");
  });

  it("un slug que no existe tambien da 500, y no un catalogo vacio", async () => {
    // Un catalogo vacio en un despliegue mal configurado es el PEOR resultado posible: el
    // gestor ve que su club no tiene pistas, da de alta diez nuevas, y tampoco se ven. Es
    // un fallo que se presenta como si fuera verdad.
    const { status, cuerpo } = await pedirCon("club-que-no-existe");
    expect(status).toBe(500);
    expect(cuerpo).not.toContain("[]");
  });

  it("los dos fallos de despliegue dan EXACTAMENTE el mismo cuerpo", async () => {
    // Esta es la version que de verdad comprueba la fuga, y no necesita saber como redacta
    // cada mensaje. Si el handler devolviera el error tal cual, los dos cuerpos serian
    // distintos: uno diria "falta TENANT_SLUG" y el otro "no existe un tenant con el slug
    // 'club-que-no-existe'". Que sean el mismo string es la prueba de que ninguno filtra.
    const sinVariable = await pedirCon(undefined);
    const conSlugMalo = await pedirCon("club-que-no-existe");
    expect(sinVariable.cuerpo).toBe(conSlugMalo.cuerpo);

    // Y no es un cuerpo vacio: un 500 sin cuerpo parece un corte de red, y el gestor no
    // puede ni contarlo ni distinguirlo de un fallo suyo.
    expect(sinVariable.cuerpo.length).toBeGreaterThan(0);
  });
});
