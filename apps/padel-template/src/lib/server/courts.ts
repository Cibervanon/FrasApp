import { tenantQuery } from "./db";
import { resolveTenantId } from "./tenant";

/**
 * El catalogo de pistas del club, en un sitio.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE ESTO ESTA FUERA DE LA RUTA
 *
 * Porque `/api/courts` (T5c) y la pantalla `/pistas` (T6) necesitan exactamente la misma
 * lista, y hay tres formas de dársela, con una mala cada una:
 *
 *   - La pagina pide a `/api/courts` por HTTP. Es un salto a uno mismo en cada render, y
 *     necesita una URL absoluta, que en un servidor no siempre existe. Ademas hace que la
 *     pagina no se pueda pintar si la ruta falla, cuando puede leer ella misma.
 *
 *   - La pagina hace su propio `select`. Duplica el SQL y las dos copias divergen sin que
 *     nada lo note: un dia anades una columna a la consulta de la ruta y la pantalla se
 *     queda con la version vieja, y el unico sintoma es que el campo sale `undefined`.
 *
 *   - Las dos llaman a esta funcion. Una sola consulta, un solo mapeo, y la ruta se queda
 *     con lo que le corresponde: comprobar el request, poner cabeceras y decidir el status.
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE ESTA FUNCION NO SABE
 *
 * No sabe de peticion, ni de cabeceras, ni de `TENANT_SLUG` mas alla de pedir el tenant. No
 * decide como se serializa ni con que codigo de respuesta. Eso es de la ruta y de la
 * pagina, y por eso aqui no hay ni un `Response`.
 */

/** Una fila de `courts`, tal cual sale de Postgres. */
interface CourtFila {
  readonly id: string;
  readonly name: string;
  readonly court_type: string;
  readonly surface: string | null;
  readonly indoor: boolean;
  readonly num_players: number;
  readonly default_duration_min: number;
  readonly min_duration_min: number;
  readonly max_duration_min: number;
  readonly sort_order: number;
  readonly image_path: string | null;
}

/**
 * Una pista ya traducida, que es lo que ve el club. Sin `tenant_id` y sin
 * `base_price_cents`, a proposito.
 */
export interface Court {
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

/**
 * Snake_case -> camelCase, en el BORDE.
 *
 * Aqui, y no antes. La columna se llama `default_duration_min` porque Postgres y porque la
 * migracion esta en SQL; lo que sale hacia fuera se llama `defaultDurationMin` porque
 * `packages/core` lo llama asi. Si el mapeo viviera en cada consumidor, cada uno tendria
 * que acordarse, y olvidarlo una vez significa que la duracion sale `undefined`.
 *
 * La lista de campos es EXPLICITA, no un `select *` renombrado. Es lo que hace que
 * `base_price_cents` y `tenant_id` no aparezcan por descuido: no estan en la lista, y un
 * campo nuevo en la migracion no aparece hasta que alguien lo escriba aqui.
 */
function aPista(fila: CourtFila): Court {
  return {
    id: fila.id,
    name: fila.name,
    courtType: fila.court_type,
    surface: fila.surface,
    indoor: fila.indoor,
    numPlayers: fila.num_players,
    defaultDurationMin: fila.default_duration_min,
    minDurationMin: fila.min_duration_min,
    maxDurationMin: fila.max_duration_min,
    sortOrder: fila.sort_order,
    imagePath: fila.image_path,
  };
}

/**
 * Catalogo de pistas activas del club.
 *
 * `is_active` y `deleted_at` son filtros de NEGOCIO, no de seguridad, asi que van en la
 * consulta. El aislamiento no: ese lo pone la RLS, y por eso la consulta NO lleva
 * `where tenant_id = ...`.
 *
 * Y queda escrito por que se puede dejar fuera sin que se rompa nada si alguien lo anade:
 * `tenant_branding` y `courts` tienen las dos el `where tenant_id`, y ahi tambien es
 * redundante. La diferencia es que en la marca hace falta para poder escribir el test que
 * pide la fila de otro club por su id (ver `branding.db.test.ts`), que es el unico test que
 * demuestra que la RLS filtra y no el `where`. Aqui no hace falta para ningun test, asi que
 * se deja la consulta limpia y la RLS sola decide.
 *
 * El `order by sort_order, name` es la opinion del club sobre como se ven sus pistas, no una
 * preferencia del cliente. `name` va segundo como desempate para que dos pistas con el mismo
 * `sort_order` no cambien de sitio entre peticiones, que es lo que hace que una pestana que
 * recarga no vea las pistas saltando.
 */
const SQL_CATALOGO = `
  select id, name, court_type, surface, indoor, num_players,
         default_duration_min, min_duration_min, max_duration_min,
         sort_order, image_path
    from public.courts
   where is_active
     and deleted_at is null
   order by sort_order, name
`;

/**
 * Las pistas activas del club de la instancia, ya traducidas.
 *
 * El tenant sale de `resolveTenantId()`, o sea de `TENANT_SLUG`. Esta funcion no recibe
 * `tenantId` como parametro a proposito: es lo que hace que sea imposible que alguien la
 * llame con el tenant equivocado, en vez de posible y acordarse de no hacerlo. Quien
 * necesite leer las pistas de OTRO club (los tests, una migracion) escribe su propia
 * consulta, que es una accion visible en el diff.
 */
export async function listCourts(): Promise<readonly Court[]> {
  const tenantId = await resolveTenantId();
  const filas = await tenantQuery<CourtFila>(tenantId, SQL_CATALOGO);
  return filas.map(aPista);
}
