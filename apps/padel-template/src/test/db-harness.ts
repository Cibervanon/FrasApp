import { Client, type ClientConfig } from "pg";

/**
 * Harness de tests de integracion contra Postgres REAL. Nunca mocks.
 *
 * POR QUE UN MOCK NO SIRVE PARA ESTO
 * El mock no aplica la politica de seguridad, asi que un RLS roto pasaria el test.
 * Todo lo que toque `tenant_id`, RLS, `EXCLUDE` o solapes pasa por aqui y abre
 * conexiones de verdad, para que sea Postgres quien decida que filas ve cada quien.
 *
 * TRES DECISIONES, Y POR QUE
 *
 * 1. AISLAR POR ROLLBACK, NO POR RECREAR LA BASE
 *    Cada `withTenant` abre una transaccion y la revierte SIEMPRE, incluso si el test
 *    falla. Por eso los tests no se colan entre si por construccion, y no por
 *    configuracion: `fileParallelism: false` en `vitest.db.config.ts` evita que se
 *    solapen ficheros, pero no protege del estado que un test deja dentro del suyo.
 *    Borrar las tablas entre tests seria lo contrario de esto y ademas obliga a que el
 *    orden de los tests importara.
 *
 * 2. DOS IDENTIDADES, Y LA DIFERENCIA ES EL MOTIVO DEL TEST
 *    `withTenant` corre como `authenticated`, que es donde las politas aplican.
 *    `withAdmin` corre como superusuario, que SE SALTA la RLS por definicion. Un
 *    resultado de `withAdmin` no dice NADA sobre aislamiento entre tenants; se usa
 *    para sembrar fixtures y para mirar el catalogo (`pg_policies`, `pg_class`).
 *    Confundir las dos es como un RLS roto pasaria el test.
 *
 * 3. FALLAR RUIDOSAMENTE ANTES DE EMPEZAR
 *    Si falta la contrasena, si la migracion no esta aplicada o si `btree_gist` no
 *    esta, este modulo lanza un error que dice que hacer. Un test que falla por
 *    "`password authentication failed for user`" durante 30 segundos de timeout no
 *    dice que le pasa a la persona que lo esta leyendo.
 */

/** Lo que un test necesita para hacer queries. El `Client` de `pg` cumple esto. */
export interface Queryable {
  query: Client["query"];
}

/** Las dos identidades de club que usan los tests de RLS. */
export type TenantKey = "a" | "b";

/**
 * UUIDs FIJOS, no generados.
 *
 * Se escriben a mano para que el fallo de un test se pueda reproducir con un `psql` a
 * pelo. Un tenant generado al azar aparece en el error, hay que buscarlo, y para
 * cuando lo encuentras la sesion ya ha terminado. Ademas permite que un test escriba
 * a mano `tenant_id = '...000a'` y el assertion signifique algo.
 */
export const TENANT_IDS: Readonly<Record<TenantKey, string>> = {
  a: "00000000-0000-4000-8000-00000000000a",
  b: "00000000-0000-4000-8000-00000000000b",
};

const TENANT_NAMES: Readonly<Record<TenantKey, string>> = {
  a: "Club A",
  b: "Club B",
};

/**
 * La contrasena NO tiene valor por defecto, a proposito.
 *
 * Con un default tipo "postgres", si la variable falta el test se conectaria a otra
 * base y pasaria dando una falsa confianza, o fallaria con un error de autenticacion
 * que no dice nada del problema real. Fallar al arrancar es el comportamiento correcto.
 */
function connection(): ClientConfig {
  const password = process.env["PGPASSWORD"];
  if (!password) {
    throw new Error(
      "Falta PGPASSWORD. Copia .env.example a .env.local y rellena la contrasena " +
        "que pusiste al instalar PostgreSQL. Se ejecuta con `pnpm db:reset` antes " +
        "de este test.",
    );
  }
  return {
    host: process.env["PGHOST"] ?? "localhost",
    port: Number(process.env["PGPORT"] ?? 5432),
    user: process.env["PGUSER"] ?? "postgres",
    password,
    database: process.env["PGDATABASE"] ?? "padel_template",
  };
}

/**
 * Abre sesion como superusuario. Se SALTA la RLS.
 *
 * Para sembrar fixtures y para consultar el catalogo. NO para afirmar nada sobre
 * aislamiento entre tenants.
 */
export async function withAdmin<T>(fn: (db: Queryable) => Promise<T>): Promise<T> {
  const client = new Client(connection());
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Abre sesion con la identidad de un tenant, dentro de una transaccion que se
 * revierte al terminar, pase lo que pase.
 *
 * Cambia a `authenticated` porque las politas son `TO authenticated`: con el rol
 * `postgres` las RLS no aplican y el test pasaria SIEMPRE. Es el detalle que hace que
 * este helper signifique algo.
 *
 * `claims` extra se mezclan sobre el JWT, para probar el caso del JWT sin `tenant_id`
 * o con el rol equivocado sin escribir el `set_config` a mano.
 */
export async function withTenant<T>(
  key: TenantKey,
  fn: (db: Queryable) => Promise<T>,
  claims: Record<string, unknown> = {},
): Promise<T> {
  const client = new Client(connection());
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({
        sub: "00000000-0000-4000-8000-0000000000aa",
        tenant_id: TENANT_IDS[key],
        role: "authenticated",
        ...claims,
      }),
    ]);
    return await fn(client);
  } finally {
    // Se revierte en `finally` a proposito: si el test falla a mitad, las filas que
    // escribio se van igual. Sin esto, un test rojo contaminaria los siguientes y el
    // fallo se pareceria a un fallo de RLS.
    await client.query("rollback");
    await client.end();
  }
}

/**
 * Sesion con un JWT libre, sin tenant por defecto. Para el caso "JWT sin `tenant_id`",
 * que debe ver cero filas y no dar error.
 */
export async function withClaims<T>(
  claims: Record<string, unknown>,
  fn: (db: Queryable) => Promise<T>,
): Promise<T> {
  const client = new Client(connection());
  await client.connect();
  try {
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({ role: "authenticated", ...claims }),
    ]);
    return await fn(client);
  } finally {
    await client.query("rollback");
    await client.end();
  }
}

/** Las dos conexiones, abiertas y con su transaccion ya empezada. */
export interface Transacciones {
  /** La primera. En los tests de conflicto, la que entra primero. */
  readonly a: Queryable;
  /** La segunda, en su propia conexion: por eso puede quedarse ESPERANDO a la otra. */
  readonly b: Queryable;
}

/**
 * DOS transacciones a la vez, en dos conexiones de verdad.
 *
 * POR QUE ESTA Y POR QUE NO BASTA CON LLAMAR DOS VECES A `withTenant`
 * `withTenant` revierte SIEMPRE, incluso cuando el test pasa, y por eso dos llamadas
 * sueltas son dos reservas que NUNCA coexisten: la segunda llega cuando la primera ya no
 * esta. Un test de solape escrito asi pasa con el `EXCLUDE` BORRADO de la migracion, que
 * es justo el fallo que el criterio de T10 dice que hay que cazar. Aqui las dos filas
 * existen a la vez porque cada una va en su transaccion, y el `EXCLUDE` tiene algo real
 * que rechazar.
 *
 * QUE NO HACE Y POR QUE
 * No sincroniza nada ni espera a que la otra este lista. Cada `query` va por su cuenta, y
 * la que choca se QUEDA ESPERANDO en el servidor hasta que la otra resuelve, que es
 * justamente el comportamiento que hay que probar. Por eso el test tiene que arrancar el
 * segundo `INSERT` como promesa suelta, resolver la primera transaccion y despues
 * awaitar la segunda: si se espera al segundo `INSERT` antes de resolver la primera, el
 * deadlock lo escribe el test, no Postgres, y el test falla por su cuenta.
 *
 * LAS DOS SON `authenticated`, CON RLS APLICANDO
 * Una transaccion como superusuario no demuestra nada del comportamiento real, que es el
 * de un JWT. Las dos se abren como el tenant que se le pase.
 *
 * Y LAS DOS SE REVIERTEN AL TERMINAR, por el mismo motivo que `withTenant`. La excepcion
 * es un test que hace `commit` a proposito, el que gana la carrera, y ahi la fila se
 * queda en la base: ese residuo lo borra el propio test, porque borrarlo por fuera en
 * silencio esconderia justo el dato interesante, que es que el ganador se escribio de
 * verdad.
 */
export async function withTransaccionesConcurrentes<T>(
  fn: (tx: Transacciones) => Promise<T>,
  key: TenantKey = "a",
): Promise<T> {
  const clients = [new Client(connection()), new Client(connection())];
  for (const client of clients) {
    await client.connect();
    await client.query("begin");
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({
        sub: "00000000-0000-4000-8000-0000000000aa",
        tenant_id: TENANT_IDS[key],
        role: "authenticated",
      }),
    ]);
  }
  // Desempaquetado a mano, y no `const [a, b] = clients`: con `noUncheckedIndexedAccess`
  // el array da `Client | undefined`, y aqui los dos existen porque los dos se acaban de
  // crear y conectar. El array no se encoge, asi que los indices 0 y 1 estan.
  const primera = clients[0] as Client;
  const segunda = clients[1] as Client;
  try {
    return await fn({ a: primera, b: segunda });
  } finally {
    for (const client of clients) {
      try {
        await client.query("rollback");
      } finally {
        await client.end();
      }
    }
  }
}

/**
 * Comprueba que la extension `name` esta instalada, y falla si no lo esta.
 *
 * NO LA CREA. La crea la migracion `20260926000000_extensions.sql`, porque una
 * extension del esquema es de la migracion y no del arnes de test. Cuando esto hacia
 * `create extension if not exists`, el `requireExtension('btree_gist')` de la suite era
 * tautologico: no podia fallar nunca, porque la acababa de crear. Un test que no puede
 * fallar no prueba nada.
 *
 * Ademas, que el arnes creara la extension hacia que `pnpm test:db` bothersa a mas
 * estado del que la migracion declara, y el estado de la base dependia de si habias
 * corrido los tests antes.
 *
 * El mensaje incluye el de Postgres, no uno propio, porque el fallo real mas probable es
 * que el PostgreSQL de Windows venga sin los ficheros de contrib, y ahi el mensaje de
 * Postgres dice exactamente que falta.
 */
export async function requireExtension(name: string): Promise<void> {
  await withAdmin(async (db) => {
    const result = await db.query<{ installed_version: string | null }>(
      `select extversion as installed_version
         from pg_extension
        where extname = $1`,
      [name],
    );
    const version = result.rows[0]?.installed_version;
    if (!version) {
      throw new Error(
        `La extension '${name}' no esta instalada.\n` +
          `La instala la migracion 20260926000000_extensions.sql, asi que casi seguro ` +
          `falta aplicar las migraciones: ejecuta \`pnpm db:reset\` y vuelve a lanzar ` +
          `los tests.\n` +
          `Si la migracion esta aplicada y el error sigue, el PostgreSQL de Windows vino ` +
          `sin los ficheros de contrib. Van aparte en ` +
          `"C:\\Program Files\\PostgreSQL\\17\\lib\\", y hay que reinstalar marcando ` +
          `"command line tools" y "contrib".`,
      );
    }
  });
}

/**
 * Comprueba que la migracion de tenancy esta aplicada, y falla con el comando si no.
 *
 * Sin esto, un test de RLS contra una base vacia falla con `relation
 * "public.tenant_branding" does not exist`, que es un sintoma de que te has olvidado
 * de `pnpm db:reset`, no de que falte una migracion.
 */
export async function requireMigration(table: string): Promise<void> {
  await withAdmin(async (db) => {
    const result = await db.query<{ present: boolean }>(
      `select to_regclass($1) is not null as present`,
      [`public.${table}`],
    );
    if (result.rows[0]?.present !== true) {
      throw new Error(
        `Falta la tabla public.${table}. La migracion no esta aplicada.\n` +
          `Ejecuta \`pnpm db:reset\` y vuelve a lanzar los tests.`,
      );
    }
  });
}

/**
 * Siembra los dos tenants y una fila de base en cada tabla de negocio.
 *
 * IDEMPOTENTE a proposito, con `on conflict do update` y no con un `delete` previo.
 * Borrar y reinsertar hace que el estado dependa del orden de ejecucion: si un test
 * falla a mitad y no limpia, el siguiente se encuentra la base vacia y falla por un
 * motivo que no es el suyo. Con `on conflict`, sembrar dos veces es lo mismo que
 * sembrar una.
 */
export async function seedTenants(): Promise<void> {
  await withAdmin(async (db) => {
    for (const key of ["a", "b"] as const) {
      const id = TENANT_IDS[key];
      await db.query(
        `insert into public.tenants (id, name, slug)
         values ($1, $2, $3)
         on conflict (id) do update set name = excluded.name, slug = excluded.slug`,
        [id, TENANT_NAMES[key], `club-${key}`],
      );
    }

    for (const key of ["a", "b"] as const) {
      const id = TENANT_IDS[key];

      await db.query(
        `insert into public.tenant_branding
           (tenant_id, primary_color, secondary_color, font_family, email_from_name, email_reply_to)
         values ($1, $2, $2, 'Inter', $3, 'padel@example.test')
         on conflict (tenant_id) do update set primary_color = excluded.primary_color`,
        [id, key === "a" ? "#111111" : "#222222", TENANT_NAMES[key]],
      );

      await db.query(
        `insert into public.tenant_features (tenant_id, feature_key, enabled)
         values ($1, 'booking', true)
         on conflict (tenant_id, feature_key) do update set enabled = excluded.enabled`,
        [id],
      );

      await db.query(
        `insert into public.tenant_content (tenant_id, content_key, value)
         values ($1, 'about_club', '"club"'::jsonb)
         on conflict (tenant_id, content_key) do update set value = excluded.value`,
        [id],
      );
    }
  });
}

/**
 * Clave del cerrojo de nivel base. Un entero cualquiera, fijo para siempre.
 *
 * Es un `advisory lock`, o sea un cerrojo que vive en la CONEXION, no en la base: si
 * el proceso muere a mitad, Postgres lo libera solo. Por eso no hay cerrojos
 * huérfanos que dejen la base bloqueada hasta que alguien lo note.
 */
const DATABASE_LEASE_KEY = 8_142_005;

/**
 * Toma el cerrojo de la base y devuelve como soltarlo.
 *
 * POR QUE UN CERROJO Y NO SOLO `fileParallelism: false`
 * `fileParallelism: false` en `vitest.db.config.ts` es CONFIGURACION. Se puede
 * reescribir, un `describe.concurrent` la rodea, y nadie se entera de que los tests
 * han pasado a correr en paralelo hasta que dos ficheros se pisan el `terms_notice`
 * del otro y el fallo aparece como un fallo de RLS.
 *
 * Aqui el cerrojo lo pone la propia base, asi que el aislamiento de "uno a la vez"
 * se cumple aunque el corredor de tests cambie. `fileParallelism: false` sigue
 * puesto, y este es el que se encarga de que se cumpla aunque alguien lo cambie.
 * motivos distintos.
 *
 * Se toma con `try` y NO con `pg_advisory_lock` a pelo: la version bloqueante se
 * queda esperando en silencio, y si el otro worker ha muerto sin soltar (cosa que no
 * deberia pasar) el test se cuelga hasta que salta el timeout, sin decir nada. Con
 * `try` se reintenta un numero acotado de veces y luego se dice que hay otro worker
 * vivo, que es la informacion que hace falta para arreglarlo.
 */
export async function acquireDatabaseLease(
  attempts = 20,
  waitMs = 250,
): Promise<() => Promise<void>> {
  const client = new Client(connection());
  await client.connect();

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_lock($1) as locked`,
      [DATABASE_LEASE_KEY],
    );
    if (result.rows[0]?.locked === true) {
      return async () => {
        try {
          await client.query(`select pg_advisory_unlock($1)`, [DATABASE_LEASE_KEY]);
        } finally {
          await client.end();
        }
      };
    }
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }

  await client.end();
  throw new Error(
    "Otro proceso tiene el cerrojo de la base de test. Los tests de integracion " +
      "tienen que correr EN SERIE contra una base compartida.\n" +
      "Suele pasar por una de estas dos:\n" +
      "  1. `fileParallelism: false` ha quitado de vitest.db.config.ts.\n" +
      "  2. Alguien ha puesto `describe.concurrent` o `it.concurrent` en un test.\n" +
      "Ninguna de las dos puede arreglarse desde el test: es configuracion del " +
      "corredor. Tambien puede ser otro `pnpm test:db` abiertas en otra terminal.",
  );
}

let lease: Promise<() => Promise<void>> | null = null;

function databaseLease(): Promise<() => Promise<void>> {
  lease ??= acquireDatabaseLease();
  return lease;
}

/**
 * Prepara la base: cerrojo tomado, migracion aplicada, extensiones y tenants
 * sembrados.
 *
 * Idempotente y memorizado, asi que se puede llamar desde el `beforeAll` de cada
 * fichero sin que se siembre veinte veces. La promesa se cachea INCLUSO si falla el
 * tenteo, para que un fallo de preparacion no se reintente en cada test y esconda el
 * error original bajo veinte copias del mismo.
 */
let prepared: Promise<void> | null = null;

export function prepareDatabase(): Promise<void> {
  prepared ??= (async () => {
    await databaseLease();
    await requireMigration("tenants");
    await requireExtension("btree_gist");
    await seedTenants();
  })().catch((error: unknown) => {
    prepared = null;
    throw error;
  });
  return prepared;
}

/**
 * Suelta el cerrojo y cierra la conexion. Para tests que terminan antes de tiempo.
 *
 * La mayoria de las veces no hace falta: si el proceso muere, Postgres libera el
 * cerrojo solo. Se ofrece para el caso de un test que deja la base en un estado y
 * necesita que otro lo coja ya, sin esperar a que termine el runner.
 */
export async function releaseDatabaseLease(): Promise<void> {
  if (lease === null) return;
  const release = await lease;
  lease = null;
  await release();
}
