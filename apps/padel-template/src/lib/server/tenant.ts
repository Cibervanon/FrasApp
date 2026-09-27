import { baseQuery } from "./db";

/**
 * De donde sale el tenant, y por que NO de la peticion.
 *
 * El modelo ya decidido es "instancia aislada por cliente": una instancia desplegada es de
 * un solo club, asi que el tenant se fija AL DESPLEGAR, en `TENANT_SLUG`. La spec (5) lo
 * describe como "se resuelve en servidor desde el host", y con una instancia por club el
 * host no tiene que decidir nada: el host ya sabe a quien pertenece, porque cada instancia
 * tiene un solo club.
 *
 * Lo que NO se ha hecho, a proposito:
 *
 *   - Una tabla `tenant_hosts` (host -> tenant). Seria la machinery correcta si varios
 *     clubes compartieran instancia, y hoy no lo hacen. Ademas pondria datos de routing en
 *     la base, que es el sitio mas caro de migrar cuando el routing cambie.
 *
 *   - Aceptar `TENANT_ID` como alternativa a `TENANT_SLUG`. Serian dos fuentes de verdad
 *     para lo mismo, y la que se configura por error es la que gana. El slug es legible y
 *     el UUID no, asi que un valor equivocado se ve.
 *
 *   - Resolver el tenant por peticion, ni siquiera "solo en desarrollo". Es la linea que
 *     separa esto de un `?tenant_id=` que filtra el catalogo de otro club, y no hace
 *     falta para nada: el tests de abajo comprueban que un `tenant_id` en la query no
 *     cambia nada.
 *
 * La cache es por una razon operativa, no por gusto: es una indexed lookup por `slug`, pero
 * se paga en CADA request de cada endpoint, y el valor no cambia mientras la instancia no
 * cambie de club. Se limpia con `clearTenantCache` cuando pasa eso, que es un alta de club
 * en caliente y no algo que hagamos por request.
 */

let cached: string | null = null;

/**
 * Resuelve el `TENANT_SLUG` de la instancia al `uuid` del tenant.
 *
 * Falla ruidosamente y con un mensaje accionable si la variable falta, si el slug no esta
 * en la base, o si hay mas de una fila (que no puede pasar: `slug` es `unique`, pero el
 * `limit 2` esta para que un `unique` que alguienQuite un dia no se convierta en un
 * "devuelvo el primero" silencioso).
 */
export async function resolveTenantId(): Promise<string> {
  if (cached !== null) return cached;

  const slug = process.env["TENANT_SLUG"];
  if (!slug) {
    throw new Error(
      "Falta TENANT_SLUG. Cada instancia desplegada es de un club, y su slug se fija " +
        "en el despliegue. Copia TENANT_SLUG a .env.local (por ejemplo `club-padel-demo`) " +
        "para desarrollo local.",
    );
  }

  const rows = await baseQuery<{ id: string }>(
    `select id from public.tenants where slug = $1 limit 2`,
    [slug],
  );

  if (rows.length === 0) {
    throw new Error(
      `No existe un tenant con el slug '${slug}'.\n` +
        `Los tenants de esta base son los que siembran \`pnpm db:reset\` (la seed y el ` +
        `harness de test). O TENANT_SLUG esta mal escrito, o la instancia apunta a una ` +
        `base donde ese club no esta dado de alta.`,
    );
  }
  if (rows.length > 1) {
    throw new Error(
      `El slug '${slug}' devuelve ${rows.length} tenants. \`tenants.slug\` es unique, ` +
        `asi que o la migracion no esta aplicada o alguien la modifico.`,
    );
  }

  const id = rows[0]?.id;
  if (id === undefined) {
    // inalcanzable por el `length` de arriba, pero `rows[0]?.id` es `string | undefined`
    // y esta funcion promete `string`. Sin esto, un no-me-vaya-a-pasar se cuela en el
    // tipo de retorno y el endpoint acaba con un `undefined` donde esperaba un tenant.
    throw new Error(
      `La consulta del slug '${slug}' devolvio una fila sin 'id'. La tabla ` +
        `public.tenants esta danificada de una forma que no deberia existir.`,
    );
  }

  cached = id;
  return id;
}

/**
 * Olvida el tenant memorizado.
 *
 * Para tests, y para el caso real de que en esta instancia se de de alta un club
 * distinto. Deliberadamente no hay forma de invalidarlo desde una peticion: si un endpoint
 * pudiera hacerlo, un `tenant_id` en la query podria fabricar un cambio de tenant.
 */
export function clearTenantCache(): void {
  cached = null;
}
