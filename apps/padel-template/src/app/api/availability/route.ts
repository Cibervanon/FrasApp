import {
  esFechaReal,
  FORMATO_FECHA,
  FORMATO_UUID,
} from "../../../lib/server/validacion";
import { disponibilidadDePista } from "../../../lib/server/disponibilidad";
import { resolveTenant } from "../../../lib/server/tenant";

/**
 * `GET /api/availability?court_id=<uuid>&date=YYYY-MM-DD` - los huecos de una pista en un
 * dia, cada uno con su precio resuelto. Publica (spec 5.1). El precio lo pone T12
 * (`disponibilidad.ts`), nunca el cliente.
 *
 * ---------------------------------------------------------------------------------------
 * EL PROBLEMA DE LA ZONA HORARIA, QUE ES EL 90% DE ESTE FICHERO
 *
 * La ventana de apertura (8:00 a 22:00) es HORA DE PARED del club: el socio ve "mi pista
 * esta a las 9", y 9 son las 9 donde esta el club. Pero `court_blocks.starts_at` es
 * `timestamptz`, que en Postgres es un INSTANTE: se guarda en UTC y se muestra con el
 * desfase que corresponda a la fecha.
 *
 * Mezclar las dos sin convertirlas produce errores que no se ven leyendo el codigo:
 *
 *   - Un club de Mallorca con un cierre de 20:00 a 21:00. Guardado en UTC y sin mas, en
 *     invierno son las 21:00 y las 22:00 en el reloj del club, y aparece una hora
 *     reservable que el gestor tiene cerrada. En verano esta bien. El bug aparece seis
 *     meses al ano y se oculta los otros seis, que es la forma mas cara de tener un bug.
 *   - Al reves: filtrar por fecha en UTC y el club de Madrid ve el dia empezando a las
 *     02:00 en invierno.
 *
 * LA CONVERSION LA HACE POSTGRES, decidido con el usuario el 2026-09-27. No es estetica:
 *
 *   - Postgres y el navegador comparten la base de datos de zonas IANA, pero no
 *     necesariamente la version. Si la app calcula el desfase y Postgres filtra con el suyo,
 *     un cambio de norma en el hemisferio sur abre un desfase de una hora entre lo que uno
 *     filtra y lo que el otro muestra, y se descubre en el sitio mas barato de testear: un
 *     bloque que cae justo en el borde.
 *   - `at time zone` lo resuelve el servidor, con los datos de zona que ya tiene. Cero
 *     dependencias nuevas: este repositorio no tiene todavia una libreria de fechas, y T5d
 *     no es la tarea que deba decidir si la hay.
 *
 * La zona llega como PARAMETRO desde `resolveTenant()`. Nunca interpolada: un `$2` con
 * `'Europe/Madrid'; drop table` es un nombre de zona invalido y un error de Postgres, no
 * una sentencia.
 *
 * ---------------------------------------------------------------------------------------
 * DONDE VIVE LA CONSULTA
 *
 * Esta ruta VALIDA la peticion y responde; los "ocupados" los calcula
 * `disponibilidad.ts`, que es el unico sitio que conoce el SQL de bloques y reservas.
 * Compartirlo con las alternativas del 409 de `POST /api/holds` es el motivo: ver el
 * comentario de cabecera de `disponibilidad.ts`. Aqui queda la cabecera del problema de la zona
 * horaria de arriba, que es la decision de diseño de T5d y no se mueve.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE LOS BLOQUES SE RECORTAN ANTES DE SALTAR A `computeAvailability`
 *
 * El motor de T5b lanza si un instante no es del dia pedido, en vez de ignorarlo. Y un
 * `court_blocks` que empieza ayer a las 23:00 y acaba hoy a la 01:00 es un dato VALIDO: si
 * se le pasa tal cual, el endpoint responde 500 a un socio que solo ha pedido un horario.
 *
 * El recorte tiene dos bordes, y los dos importan:
 *
 *   - El inicio se baja al comienzo del dia local, porque un bloque que empezo ayer sigue
 *     ocupando hoy.
 *   - El final se sube al ULTIMO MINUTO del dia local, y no a las 00:00 del dia siguiente.
 *     Un bloque de "todo el dia" acaba a medianoche, y esas 00:00 son precisamente el caso
 *     que el motor rechaza. Restar un minuto es la menor de las dos cosas: no puede
 *     cambiar ningun slot, porque la rejilla termina a las 21:30 como muy tarde, y
 *     garantiza que la fecha local de lo que sale sea siempre la pedida.
 *
 * El recorte NO usa la ventana de apertura. Si el horario viviera aqui, el SQL y
 * `computeAvailability` tendrian cada uno su copia, y el dia que uno cambie y el otro no,
 * el endpoint no daria error: daria horas que el club no abre.
 *
 * ---------------------------------------------------------------------------------------
 * LOS DIAS DE CAMBIO DE HORA
 *
 * Decision del usuario el 2026-09-27: los slots son horas de pared y el dia termina a las
 * 22:00, aparezcan o falten horas. En la practica eso no cuesta nada, y por un motivo
 * concreto: en Europa el cambio de hora ocurre a las 02:00-03:00 locales, y el club abre a
 * las 08:00. La hora que se repite o desaparece nunca esta dentro de la ventana, asi que
 * `computeAvailability` no necesita saber nada de DST: cuenta minutos de reloj y ya.
 *
 * Esto no es gratis, es una coincidencia que hay que vigilar. El dia que un club abra antes
 * de las 04:00, o que abra de noche, esta pagina deja de ser correcta sin que nada avise.
 * Los dos dias de transicion estan fijados con tests (`2026-03-29` y `2026-10-25`) para
 * que, cuando la apertura se mueva, el rojo aparezca aqui.
 */

/** Nunca se prerenderiza. Mismo motivo que en `/api/courts`: sin esto, el build podria
 * generarla en compilacion, donde no hay `TENANT_SLUG` ni base de datos. */
export const dynamic = "force-dynamic";

/** Sin cache, por el mismo motivo que en `/api/courts`. */
const SIN_CACHE = "no-store";

/**
 * Un 404 que no dice cual de los dos fallos fue.
 *
 * El mismo cuerpo para "no existe esa pista" y "esa pista es de otro club". Distinguirlos
 * seria confirmar la existencia de filas de otros tenants: un atacante que recorre uuids
 * sabria cuales existen en otros clubes, que es informacion de un tercero.
 */
function noExistePista(): Response {
  return Response.json(
    { error: "No se ha encontrado esa pista." },
    { status: 404, headers: { "cache-control": SIN_CACHE } },
  );
}

/** Un 400 con el motivo, que aqui SI se dice: es quien ha escrito la URL, no un visitante. */
function peticionInvalida(motivo: string): Response {
  return Response.json(
    { error: `Peticion invalida: ${motivo}` },
    { status: 400, headers: { "cache-control": SIN_CACHE } },
  );
}

export async function GET(request: Request): Promise<Response> {
  try {
    // `id:` porque `resolveTenant` devuelve `id`, y renombrarlo aqui deja claro que lo que
    // viaja a `disponibilidadDePista` es el id resuelto del despliegue. Escribiendo
    // `{ tenantId }` a pelo, `tenantId` sale `undefined` y la RLS no filtra, no deja ver:
    // todas las peticiones darian 404, tambien las de las pistas propias, que es un fallo
    // que de entrada parece que el aislamiento funciona. El typecheck lo pilla antes que
    // un test.
    const { id: tenantId, timezone } = await resolveTenant();
    const url = new URL(request.url);

    // -----------------------------------------------------------------------------------
    // QUE PARAMETROS SE LEEN, Y CUALES NO
    //
    // Se leen `court_id` y `date`, y nada mas. Un `?tenant_id=` que venga de paso se
    // ignora, igual que en `/api/courts`, y por el mismo motivo: el tenant es una propiedad
    // del despliegue. Aqui el criterio 7.1 se puede comprobar de verdad, porque este handler
    // SI lee la query: si leyera el `tenant_id`, la pista de la otra se encontraria y este
    // endpoint devolveria el horario de un club entero. Por eso los dos parametros se
    // nombran uno a uno en vez de recorrer el `URLSearchParams` y filtrar: una lista
    // explicita hace que anadir un parametro nuevo sea una decision, no un accidente.
    const courtId = url.searchParams.get("court_id");
    if (courtId === null) {
      return peticionInvalida("falta el parametro `court_id`.");
    }
    if (!FORMATO_UUID.test(courtId)) {
      return peticionInvalida("`court_id` tiene que ser un uuid.");
    }

    const fecha = url.searchParams.get("date");
    if (fecha === null) {
      return peticionInvalida("falta el parametro `date`.");
    }
    if (!FORMATO_FECHA.test(fecha) || !esFechaReal(fecha)) {
      return peticionInvalida("`date` tiene que ser una fecha real en formato YYYY-MM-DD.");
    }

    // -----------------------------------------------------------------------------------
    // LA PISTA Y SUS OCUPADOS, O 404
    //
    // El 404 se decide ANTES de calcular los huecos a proposito. Si la consulta de ocupados
    // fuera la primera, un `court_id` equivocado daria un array vacio, y un array vacio es
    // una respuesta con la que T6 no puede hacer nada: no distingue "no hay pistas" de "no
    // hay huecos" de "has escrito mal el id". Que pista existe y que la ocupa lo decide
    // `disponibilidadDePista` en un solo sitio, y devuelve `null` cuando esa pista no
    // existe aqui.
    const resultado = await disponibilidadDePista(tenantId, timezone, courtId, fecha);
    if (resultado === null) {
      return noExistePista();
    }

    // Lo que sale es exactamente lo que devuelve el motor, sin re-mapear. Los slots ya
    // vienen en hora de pared del club, que es lo que la T6 pintara tal cual, y anadirle
    // aqui un offset obligaria a decidir quien lo aplica, que es la pregunta que T7 tendra
    // que responder igual.
    return Response.json(resultado.huecos, { headers: { "cache-control": SIN_CACHE } });
  } catch (error: unknown) {
    // El error COMPLETO al log, con su stack y su mensaje. A la respuesta, nada: el mensaje
    // de `resolveTenant` dice el slug y el nombre de la tabla, y quien lo lee puede ser un
    // visitante con la URL en la mano. Mismo criterio que en `/api/courts`.
    console.error(
      "[api/availability] no se pudo leer la disponibilidad",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return Response.json(
      { error: "No se pudo leer la disponibilidad." },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}
