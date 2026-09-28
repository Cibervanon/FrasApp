/**
 * De donde sale el `sub` de una peticion, y por que de la cookie.
 *
 * ---------------------------------------------------------------------------------------
 * EL PROBLEMA: PLANO SIN IDENTIDAD
 *
 * Todo lo anterior a T11 es publico: el catalogo y la disponibilidad no necesitan saber
 * quien pregunta. Con un hold/mi pista hay que atribuir: la fila de `bookings` que crea
 * `POST /api/holds` guarda `user_id`, y los 404 con un hold ajeno se deciden comparando ese
 * `user_id` con quien pide cancelar.
 *
 * Un endpoint publico no recibe JWT de Supabase: el navegador visita la pagina, no hace
 * `signInWithPassword`. La identidad, cuando exista, viajara en la cookie `frasapp_session`,
 * que Supabase Auth escribe y refresca (`@supabase/ssr` lo gestionara; T11 no lo instala).
 *
 * ---------------------------------------------------------------------------------------
 * QUE SE HACE AQUI, Y QUE NO
 *
 * Este fichero SOLO lee la cookie y saca el `sub`. Dos limites, en voz alta:
 *
 *   - No verifica la firma del JWT. Leer el payload de un JWT es decodificar base64url, no
 *     validar una identidad: cualquiera puede fabricar un token con el `sub` que quiera, y
 *     aqui TODAVIA no hay secreto para comprobarlo. Es la decision pendiente de T11 (spec
 *     6.2: la verificacion completa queda para cuando exista la sesion real de Supabase).
 *   - El `sub` solo vale para ATRIBUIR un hold a un uuid. Sirve para que la cancelacion
 *     reclame lo propio y el 409 diga "ese horario", sin decir quien lo tiene y sin servir
 *     para autorizar nada que no sea "eres quien iniciaste este hold".
 *
 * Mientras ese hueco exista, un visitante que sepa la forma de la cookie puede atribuirse
 * un uuid que no es el suyo. No hay forma de cerrarlo sin la verificacion pendiente. La
 * fecha de esa decision esta en `task_plan.md`; este fichero devuelve `null` ante cualquier
 * cosa que no sea exactamente un JWT de tres partes con `sub` uuid, que es la unica
 * reticencia que tiene sentido sin una firma que comprobar.
 */

import { FORMATO_UUID } from "./validacion";

/** El payload de un JWT, ya sin envoltorio de firma. */
interface SesionJwt {
  /** El claim `sub`. Puede no existir, y puede no ser un string. */
  readonly sub?: unknown;
}

/**
 * Lee el payload de un token de tres partes. Sin verificar nada: decodificar no es validar.
 *
 * Devuelve `null` ante cualquier forma que no sea `parte.parte.parte`: un JWT no se parece
 * a eso, y un `sub` que no venga de un token con forma de JWT no es de una sesion.
 */
function payloadDe(token: string): SesionJwt | null {
  const partes = token.split(".");
  if (partes.length !== 3) return null;
  const payload = partes[1];
  if (payload === undefined || payload.length === 0) return null;
  try {
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown;
    if (typeof json !== "object" || json === null) return null;
    return json as SesionJwt;
  } catch {
    return null;
  }
}

/** El valor de la cookie en bruto puede ser un URL-encoding de mas. Si lo es, se limpia. */
function valorCrudo(encoded: string): string {
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * El `sub` que viaje en el VALOR de la cookie, o `null` si no hay sesion.
 *
 * Es el valor crudo que devuelve `cookies()` de `next/headers` ya desnombrado: viene
 * sin el `frasapp_session=` delante, y una pantalla de servidor no tiene la cabecera
 * entera para pasarle a `subDeCabecera`.
 */
export function subDeValor(valor: string | null | undefined): string | null {
  if (valor === null || valor === undefined) return null;
  if (valor.length === 0) return null;

  const jwt = payloadDe(valorCrudo(valor));
  const sub = jwt?.sub;
  if (typeof sub !== "string" || !FORMATO_UUID.test(sub)) return null;
  return sub;
}

/**
 * El `sub` que viaje en una cabecera `cookie` cruda, o `null` si no hay sesion.
 *
 * Es la misma lectura que `subDeSesion`, separada para que una pantalla de servidor
 * (que no recibe un `Request`, sino la cookie de `next/headers`) pueda usar la
 * identidad sin fabricar una peticion falsa.
 */
export function subDeCabecera(cookie: string | null): string | null {
  if (cookie === null) return null;
  const coincidencia = /(?:^|;)\s*frasapp_session=([^;\s]+)/.exec(cookie);
  if (coincidencia === null) return null;
  return subDeValor(coincidencia[1]);
}

/**
 * El `sub` de la peticion, o `null` si no hay sesion.
 *
 * `null` significa una sola cosa: este handler no tiene identidad. El 401 que responda
 * la ruta es de "sesion inexistente", no de "credenciales invalidas": no hay ninguna
 * credencial que verificar todavia.
 */
export function subDeSesion(request: Request): string | null {
  return subDeCabecera(request.headers.get("cookie"));
}