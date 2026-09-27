import { listCourts } from "../../../lib/server/courts";

/**
 * `GET /api/courts` — el catalogo de pistas activas del club. Publica (spec 5.1).
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE HACE, EN UN PARRAFO
 *
 * Devuelve el catalogo como JSON, sin precios: eso es T7. Sin sesiones: el visitante no
 * necesita ninguna, y por eso el endpoint es publico y aun asi la RLS sigue siendo la
 * unica que decide que filas son suyas.
 *
 * La consulta y el mapeo no estan aqui, estan en `lib/server/courts.ts`, porque la pantalla
 * `/pistas` (T6) necesita lo mismo. Este fichero es lo que no se puede compartir: leer el
 * `Request`, decidir el status, poner las cabeceras y no filtrar el error a la respuesta.
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
 * propia firma que el parametro existe por un motivo de test, no de uso. Si algun dia se
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

export async function GET(_request: Request): Promise<Response> {
  try {
    const pistas = await listCourts();
    return Response.json(pistas, { headers: { "cache-control": SIN_CACHE } });
  } catch (error: unknown) {
    // El error COMPLETO va al log, con su mensaje, su causa y su `tenant_id` de contexto.
    // A la respuesta no va nada de eso. Un visitante que ve "No existe un tenant con el slug
    // 'club-padel-demo'" aprende de golpe que hay una tabla `tenants`, que el club se elige
    // por slug y cual es el suyo. Ese mensaje es para el log del despliegue, no para el movil
    // de un socio.
    //
    // `console.error` y no un logger: Next lo captura en stdout y lo manda a la plataforma
    // donde se mire. Cuando haya dos o tres endpoints y haga falta correlacion, se mete un
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
