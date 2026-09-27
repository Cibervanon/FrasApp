import { tenantQuery } from "../../../lib/server/db";
import { resolveTenantId } from "../../../lib/server/tenant";

/**
 * `GET /api/courts` — el catalogo de pistas activas del club. Publica (spec 5.1).
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE HACE, EN UN PARRAFO
 *
 * Resuelve el tenant de la instancia, consulta `courts` como el rol `authenticated` de ese
 * tenant, y devuelve las que estan activas. Sin precios: eso es T7. Sin sesiones: el
 * visitante no necesita ninguna, y por eso el endpoint es publico y aun asi la RLS sigue
 * siendo la unica que decide que filas son suyas.
 * ---------------------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE NO USA `NextResponse` NI NADA DE `next/server`
 *
 * Porque con `Request` y `Response` de la Web API estandar, que Node 20+ trae de serie, este
 * handler es una FUNCION NORMAL. Se importa y se llama en un test sin levantar un servidor:
 * `GET(new Request("http://localhost:3000/api/courts"))`. Asi lo prueba
 * `route.db.test.ts`, contra la base de datos de verdad, en 800 ms.
 *
 * La alternativa era `NextResponse.json()`, y sus tests necesitarian o un servidor de test
 * o `@next/test-utils`. Para una funcion que devuelve un array, esa dependencia no compra
 * nada. Si algun dia hace falta algo de Next (cookies, streaming, middleware), se importa
 * entonces, en este fichero, y no en toda la capa.
 * ---------------------------------------------------------------------------------------
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE RECIBE LA PETICION Y NO LEE NADA DE ELLA
 *
 * Recibe el `Request` y no lo toca. Ni un parametro, ni una cabecera, ni el cuerpo. Es la
 * decision de T5a aplicada aqui: el tenant sale de `TENANT_SLUG`, y un `tenant_id` en la
 * query se ignora porque no se lee. No hay un filtro que lo descarte, no hay un `if` que lo
 * rechace, no hay nada que mantener: la variable de la query no llega a existir para este
 * handler. Por eso el criterio 7.1 ("un `tenant_id` enviado en la query se ignora") no
 * necesita un filtro para cumplirse, y no puede romperse por un handler nuevo que se olvide
 * de el.
 *
 * La combinacion (pista de otro club, tenant de esta instancia) no es un estado que este
 * codigo pueda expresar, porque la fila no sale de la base.
 *
 * Y ahora la parte incomoda, que es la que justifica el `_` del parametro: la firma PODRIA
 * ser `GET()` sin argumentos, y entonces el compilador garantizaria que este handler jamas
 * puede mirar la peticion. Esa garantia es real, y es tentador pedirla. Pero entonces los
 * tests del criterio 7.1 se vuelven vacuos: sin `Request` que pasarle, "devuelve lo mismo
 * con `?tenant_id=` que sin el" comprueba que una funcion sin entradas da dos veces lo mismo,
 * que es verdad de cualquier funcion y no dice nada de este endpoint.
 *
 * El criterio 7.1 esta escrito en la spec, asi que necesita un test que lo observe. Por eso
 * la firma acepta la peticion y la firma se niega a mirarla: la peticion llega, el test la
 * manda con `?tenant_id=` de otro club, y la respuesta es la MISMA. El `_` deja claro en la
 * propia firma que el parametro existe por un motivo de test, no de uso. Si algum dia se
 * borra el parametro, el `Expected 0 arguments` del test avisa antes de que el criterio
 * quede sin comprobar.
 */

/**
 * Nunca se prerenderiza.
 *
 * Es explicito a proposito. Esta ruta no usa ninguna API dinamica de Next: lee el tenant de una
 * variable de entorno y consulta la base, y ninguna de las dos cosas le dice a Next que la
 * respuesta depende del request. Sin esto, `next build` podria intentar generarla en tiempo de
 * compilacion, donde no hay `TENANT_SLUG` ni base de datos, y el build fallaria con un error
 * que no tiene nada que ver con el codigo de la ruta.
 *
 * Y lo peor no es que falle: es que si el build la generara y guardara el resultado, el
 * catalogo del club de compilacion se serviria tal cual a todas las instancias que se
 * desplegaran despues, con las pistas de un club metidas en la web de otro. Un `force-dynamic`
 * de tres lineas evita tener que confiar en que nadie lo quito.
 */
export const dynamic = "force-dynamic";

/**
 * Sin cache, ni del navegador ni del CDN.
 *
 * El catalogo refleja lo que el gestor ha dado de alta, apagado y retirado. Sin cabeceras de
 * cache, un navegador puede guardar la respuesta y decidir con una heuristica cuanto tiempo la
 * sirve, que es un intervalo que nadie ha elegido. Un gestor que retira una pista y un socio
 * que sigue viendo la suya es la clase de fallo que la regla 1 (nada hardcodeado) y el
 * criterio 7.2 (dos pestanas que ven lo mismo) quieren evitar, pero por el camino corto: la
 * app no hardcodea nada, el navegador si.
 *
 * Cuando haya invalidacion de verdad —la reserva de T9, o una revalidacion por tag— esto se
 * cambia aqui, en un solo sitio, y los dos endpoints se benefician.
 */
const SIN_CACHE = "no-store";

/** Una fila de la respuesta. Los nombres en camelCase, como los tipos de `core`. */
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

/** Una pista como sale por la API. Sin `tenant_id` y sin `base_price_cents`, a proposito. */
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

/**
 * Snake_case -> camelCase, en el BORDE.
 *
 * Aqui, y no antes. La columna se llama `default_duration_min` porque Postgres y porque la
 * migracion esta en SQL; lo que sale por la red se llama `defaultDurationMin` porque
 * `packages/core` lo llama asi. Si el mapeo viviera en el cliente, cada pantalla tendria que
 * acordarse, y olvidarlo una vez en T6 significa que la duracion sale `undefined` y el
 * endpoint devuelve 200 con un numero que no existe.
 *
 * La lista de campos es EXPLICITA, no un `select *` renombrado. Es lo que hace que
 * `base_price_cents` y `tenant_id` no aparezcan por descuido: no estan en la lista, y un
 * campo nuevo en la migracion no aparece en la API hasta que alguien lo escriba aqui.
 */
function aPista(fila: CourtFila): CourtJson {
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
 * consulta. El aislamiento no: ese lo pone la RLS, y por eso la consulta no lleva
 * `where tenant_id = ...`. Anadirlo seria redundante y peligroso, porque un dia alguien lo
 * borraria "porque la RLS ya lo hace" y ese dia la seguridad dependeria de que nadie se
 * acuerde de la linea que se borro.
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

export async function GET(_request: Request): Promise<Response> {
  try {
    const tenantId = await resolveTenantId();
    const filas = await tenantQuery<CourtFila>(tenantId, SQL_CATALOGO);

    const pistas = filas.map(aPista);
    return Response.json(pistas, { headers: { "cache-control": SIN_CACHE } });
  } catch (error: unknown) {
    // El error COMPLETO va al log, con su mensaje, su causa y su `tenant_id` de contexto.
    // A la respuesta no va nada de eso. Un visitante que ve "No existe un tenant con el slug
    // 'club-padel-demo'" aprende de golpe que hay una tabla `tenants`, que el club se elige
    // por slug y cual es el suyo. Ese mensaje es para el log del despliegue, no para el movil
    // de un socio.
    //
    // `console.error` y no un logger: Next lo captura en stdout y lo manda a la plataforma
    // donde se mire. Cuando haya dos o tres endpoints y haga falta correlación, se mete un
    // logger con request-id, y se cambia en un solo sitio. Anadirlo ahora seria admitir una
    // dependencia que no tiene consumidor, que es el error que T5b corrigio en `core`.
    console.error(
      "[api/courts] no se pudo leer el catalogo",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );

    return Response.json(
      { error: "No se pudo leer el catalogo de pistas." },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}
