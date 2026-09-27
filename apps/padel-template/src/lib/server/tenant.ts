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
 *   - Una tabla `tenant_hosts` (host -> tenant). Seria la maquinaria correcta si varios
 *     clubes compartieran instancia, y hoy no lo hacen. Ademas pondria datos de routing en
 *     la base, que es el sitio mas caro de migrar cuando el routing cambie.
 *
 *   - Aceptar `TENANT_ID` como alternativa a `TENANT_SLUG`. Serian dos fuentes de verdad
 *     para lo mismo, y la que se configura por error es la que gana. El slug es legible y
 *     el UUID no, asi que un valor equivocado se ve.
 *
 *   - Resolver el tenant por peticion, ni siquiera "solo en desarrollo". Es la linea que
 *     separa esto de un `?tenant_id=` que filtra el catalogo de otro club, y no hace
 *     falta para nada: los tests de abajo comprueban que un `tenant_id` en la query no
 *     cambia nada.
 *
 * La cache es por una razon operativa, no por gusto: es una indexed lookup por `slug`, pero
 * se paga en CADA request de cada endpoint, y el valor no cambia mientras la instancia no
 * cambie de club. Se limpia con `clearTenantCache` cuando pasa eso, que es un alta de club
 * en caliente y no algo que hagamos por request.
 */

let cached: ResolvedTenant | null = null;

/**
 * Lo que hay que saber de la instancia para responder a cualquier endpoint.
 *
 * `id` es el uuid del club, y `timezone` la zona con la que el club razona. No es un
 * detalle: la ventana de disponibilidad (8:00 a 22:00) es HORA DE PARED del club, mientras
 * que las filas de `court_blocks` son `timestamptz` en UTC. Sin la zona no se puede saber si
 * un bloque cae dentro de la ventana, y con la zona mal puesta el cierre de un club de
 * Mallorca aparece a las 20:00 en invierno.
 *
 * Viaja aqui y no se consulta en cada endpoint porque es la misma para toda la instancia: es
 * una propiedad del despliegue, no de la peticion.
 */
export interface ResolvedTenant {
  readonly id: string;
  readonly timezone: string;
}

/**
 * Resuelve el `TENANT_SLUG` de la instancia al `uuid` del tenant y su zona horaria.
 *
 * Falla ruidosamente y con un mensaje accionable si la variable falta, si el slug no esta
 * en la base, o si hay mas de una fila (que no puede pasar: `slug` es `unique`, pero el
 * `limit 2` esta para que un `unique` que alguien quite un dia no se convierta en un
 * "devuelvo el primero" silencioso).
 *
 * La zona se lee de la MISMA fila y con `baseQuery`, no con la conexion del tenant, por un
 * motivo que es un huevo y una gallina: para entrar con la conexion del tenant hay que saber
 * cual es el tenant, y eso es justo lo que se esta preguntando. Y no es que se pueda titular
 * con el `slug` y ya, porque `public.tenants` no tiene RLS (ver `findings.md`): un
 * `tenantQuery` aqui devolveria las filas de todos los clubes de la instancia. El aislamiento
 * lo da el `where slug = $1` contra un `unique`, que es lo unico que se puede exigir antes de
 * saber quien pregunta.
 */
export async function resolveTenant(): Promise<ResolvedTenant> {
  if (cached !== null) return cached;

  const slug = process.env["TENANT_SLUG"];
  if (!slug) {
    throw new Error(
      "Falta TENANT_SLUG. Cada instancia desplegada es de un club, y su slug se fija " +
        "en el despliegue. Copia TENANT_SLUG a .env.local (por ejemplo `club-padel-demo`) " +
        "para desarrollo local.",
    );
  }

  const rows = await baseQuery<{ id: string; timezone: string }>(
    `select id, timezone from public.tenants where slug = $1 limit 2`,
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

  const fila = rows[0];
  if (fila === undefined) {
    // inalcanzable por el `length` de arriba, pero `rows[0]` es `T | undefined` y esta
    // funcion promete un tenant entero. Sin esto, un no-me-vaya-a-pasar se cuela en el
    // tipo de retorno y el endpoint acaba con un `undefined` donde esperaba un uuid.
    throw new Error(
      `La consulta del slug '${slug}' devolvio una fila sin 'id'. La tabla ` +
        `public.tenants esta danificada de una forma que no deberia existir.`,
    );
  }

  cached = { id: fila.id, timezone: fila.timezone };
  return cached;
}

/**
 * Solo el `uuid`, para los endpoints que no razonan en horas.
 *
 * Un atajo sobre `resolveTenant`, no una segunda consulta: comparte la cache, y con ella el
 * viaje a la base. `/api/courts` no tiene horas, asi que pedirle la zona seria tirarla
 * fuera; y la forma de tirarla es este `id`, que es lo que un endpoint sin reloj necesita.
 */
export async function resolveTenantId(): Promise<string> {
  return (await resolveTenant()).id;
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
