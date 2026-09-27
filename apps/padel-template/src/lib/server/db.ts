import { Pool, type PoolConfig, type QueryResultRow } from "pg";

/**
 * Acceso a la base desde el servidor, SIEMPRE con el rol del tenant.
 *
 * LA REGLA DE ESTE FICHERO, en una linea: ninguna query de un endpoint pasa por aqui sin
 * un `tenantId` explicito, y ese `tenantId` sale de `tenant.ts`, que lo lee de una variable
 * de entorno. Nunca de la peticion. Es lo que hace que valga el criterio de aceptacion de
 * la spec 7.1 ("un `tenant_id` enviado en el cuerpo o en la query se ignora") sin tener que
 * acordarse de filtrar en cada handler.
 *
 * POR QUE `authenticated` Y NO `service_role`
 * Un endpoint publico (`/api/courts`, `/api/availability`) lo puede llamar alguien sin
 * sesion, asi que no hay JWT y `current_tenant_id()` seria null: con las 8 politicas de T4,
 * todas `to authenticated`, el catalogo del club salia vacio.
 *
 * Las dos salidas posibles eran malas:
 *   - `service_role` se salta la RLS. Entonces el aislamiento depende de que cada query
 *     recuerde escribir `where tenant_id = ...`, y uno olvidado filtra otro club. Es la
 *     clase de fallo que la FK compuesta de T4 cerro en la base, y aqui volveria a
 *     abrirse en el codigo.
 *   - Politicas `to anon` con una cabecera de tenant obligan a strippear la copia que
 *     envie el cliente, y una limpieza de cabeceras mal hecha es una via de fuga.
 *
 * Aqui el rol es `authenticated` y el `tenant_id` lo pone el servidor en los claims. La RLS
 * sigue siendo el unico punto de aislamiento, y el visitante sin sesion y el socio con
 * sesion pasan por las mismas 8 politicas. "Publico" describe quien puede llamar, no que se
 * salten las reglas.
 *
 * POR QUE UNA TRANSACCION POR CONSULTA
 * `set local role` y `set_config(..., true)` son de alcance TRANSACCIONAL. Sin una
 * transaccion que los enclose, un `role authenticated` de una consulta se leeria en la
 * siguiente por la misma conexion del pool, y la consulta que correria sin querer como
 * superusuario seria la siguiente, no la que se acaba de escribir. El pool hace que las
 * conexiones se reutilicen justo cuando nadie lo esta mirando.
 */

let pool: Pool | null = null;

/**
 * Configuracion de conexion.
 *
 * Sin valor por defecto para la contrasena, a proposito: si `PGPASSWORD` falta y la
 * aplicacion se conecta con una contrasena inventada, el fallo aparece como
 * `password authentication failed` en cada request, que no dice nada del problema real.
 * Fallar al arrancar es el comportamiento correcto.
 *
 * `DATABASE_URL` tiene prioridad sobre las piezas `PG*` porque es lo que da Supabase al
 * desplegar. En local, donde solo hay PostgreSQL, se usan las piezas.
 */
function connectionConfig(): PoolConfig {
  const url = process.env["DATABASE_URL"];
  if (url) return { connectionString: url };

  const password = process.env["PGPASSWORD"];
  if (!password) {
    throw new Error(
      "Falta PGPASSWORD y no hay DATABASE_URL. Copia .env.example a .env.local y " +
        "rellena la contrasena que pusiste al instalar PostgreSQL.",
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
 * El pool, memorizado.
 *
 * Un pool por peticion seria crear y cerrar conexiones TCP sin parar, y en el serverless
 * de Vercel eso es una conexion por invocacion. Ademas el pool es lo que hace que la
 * conexion se REUTILICE, que es justo el riesgo del que habla el comentario de arriba.
 */
export function getPool(): Pool {
  pool ??= new Pool({ ...connectionConfig(), max: 10 });
  return pool;
}

/**
 * Cierra el pool. Para tests y para el apagado ordenado.
 *
 * Existe sobre todo porque un pool abierto mantiene el proceso de Node vivo: en un script
 * que consulta y termina, sin esto no termina nunca y parece un cuelgue.
 */
export async function closePool(): Promise<void> {
  if (pool === null) return;
  const open = pool;
  pool = null;
  await open.end();
}

/**
 * Consulta una tabla SIN RLS de tenant, como `tenants`.
 *
 * Para la resolucion del tenant, que es el gallo: todavia no hay tenant, asi que no puede
 * pasar por `tenantQuery`. Se limita a lo que de verdad no tiene RLS, y el nombre lo dice.
 *
 * `tenants` expone `stripe_account_id` y es legible por `anon` porque no tiene RLS. No es un
 * secreto (un account id de Stripe Connect no es una credencial) y es el estado que dejo la
 * migracion de T1, asi que no se toca aqui. Anotado en `findings.md` para que no se pierda.
 */
export async function baseQuery<T extends QueryResultRow>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}

/**
 * Consulta CON el rol y el tenant del que se le pide.
 *
 * Este es el unico punto por el que un endpoint debe leer datos de negocio. La firma obliga
 * a pasar el `tenantId`, y como no hay forma de omitirlo, un handler nuevo no puede
 * acordarse de la RLS: si no lo pasa, no compila.
 */
export async function tenantQuery<T extends QueryResultRow>(
  tenantId: string,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = await getPool().connect();
  try {
    await client.query("begin");
    // El orden importa: primero el rol, despues los claims. Al reves, el
    // `set_config` lo ejecutaria el superusuario y quedaria con los permisos de este, que
    // es justo lo contrario de lo que se quiere.
    await client.query("set local role authenticated");
    await client.query(`select set_config('request.jwt.claims', $1, true)`, [
      JSON.stringify({
        tenant_id: tenantId,
        role: "authenticated",
        // SIN `sub`. Un visitante sin sesion no es una persona, y poner un `sub`
        // inventado seria fabricar una identidad que un dia alguien podria usar para
        // atribuir acciones. Cuando haga falta una sesion real, se mistura el `sub` de
        // ahi, con el JWT que Supabase ya ha verificado.
      }),
    ]);

    const result = await client.query<T>(sql, params);
    await client.query("commit");
    return result.rows;
  } catch (error: unknown) {
    // Sin esto, una transaccion abortada se queda colgada en el pool: la siguiente que
    // coja esa conexion empieza en un estado de error y dice `transaccion abortada`, sin
    // relacion con nada de lo que este test hizo.
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
