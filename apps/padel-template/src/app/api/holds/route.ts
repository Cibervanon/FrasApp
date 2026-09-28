import { crearHold } from "../../../lib/server/holds";
import { subDeSesion } from "../../../lib/server/session";
import { resolveTenant } from "../../../lib/server/tenant";
import {
  esInstanteLocal,
  FORMATO_UUID,
} from "../../../lib/server/validacion";

/**
 * `POST /api/holds` - retener una pista 3 minutos (spec 5.1 y 4.4.1).
 *
 * ---------------------------------------------------------------------------------------
 * QUE HACE, Y EN QUE ORDEN
 *
 *  1. Resuelve el tenant del despliegue y la identidad de la cookie. Sin identidad,
 *     401: un hold SIN dueno no es un hold, es una pista bloqueada para siempre.
 *  2. Valida el cuerpo. El servidor es quien decide el precio y quien comprueba el hueco;
 *     el cliente solo trae la pista, la hora (hora de pared del club, sin offset) y los
 *     jugadores. Un `tenant_id` o un `priceCents` que lleguen de paso se ignoran: el
 *     precio lo calcula `holds.ts` y el tenant ya esta resuelto.
 *  3. La logica (y sus respuestas) vive en `holds.ts`: 404 si la pista no esta, 409 con
 *     los huecos que quedan si la hora no esta libre, 401 si el `sub` no es una persona,
 *     201 con el hold si todo cuadra.
 *
 * COMPARTE DISPONIBILIDAD CON `GET /api/availability`: el 409 ofrece exactamente los
 * huecos que esa pantalla pintaria. (Ver `disponibilidad.ts`.)
 */

/** Nunca se prerenderiza. Mismo motivo que en `/api/availability`. */
export const dynamic = "force-dynamic";

/** Sin cache: un hold es un estado que cambia a cada peticion. */
const SIN_CACHE = "no-store";

function sinSesion(): Response {
  return Response.json(
    { error: "No hay sesion para crear el hold." },
    { status: 401, headers: { "cache-control": SIN_CACHE } },
  );
}

/** Un 400 con el motivo, como en `/api/availability`: quien lo lee ha escrito el cuerpo. */
function peticionInvalida(motivo: string): Response {
  return Response.json(
    { error: `Peticion invalida: ${motivo}` },
    { status: 400, headers: { "cache-control": SIN_CACHE } },
  );
}

/** Un 404 que no dice cual de los dos fallos fue. Mismo criterio que availability. */
function noExistePista(): Response {
  return Response.json(
    { error: "No se ha encontrado esa pista." },
    { status: 404, headers: { "cache-control": SIN_CACHE } },
  );
}

/** Alguien se llevo la hora: el 409 trae los huecos que quedan, ya actualizados. */
function horarioOcupado(alternativas: unknown): Response {
  return Response.json(
    { error: "Ese horario ya no esta libre.", alternatives: alternativas },
    { status: 409, headers: { "cache-control": SIN_CACHE } },
  );
}

interface CuerpoHold {
  readonly courtId: string;
  readonly startsAt: string;
  readonly numPlayers: number;
  readonly playerName: string;
}

/**
 * Valida el cuerpo, campo a campo.
 *
 * Devuelve `null` si es valido, o el mensaje del 400 si no. Separada del handler para
 * que los casos malformados tengan un solo sitio donde vivir y cada campo diga lo suyo
 * en vez de un "cuerpo invalido" generico.
 */
function validarCuerpo(cuerpo: unknown): { error: string } | CuerpoHold {
  if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) {
    return {
      error: "el cuerpo tiene que ser un objeto JSON con courtId, startsAt, numPlayers y playerName.",
    };
  }
  const crudo = cuerpo as Record<string, unknown>;

  const courtId = crudo["courtId"];
  if (typeof courtId !== "string" || !FORMATO_UUID.test(courtId)) {
    return { error: "`courtId` tiene que ser un uuid." };
  }

  const startsAt = crudo["startsAt"];
  if (typeof startsAt !== "string" || !esInstanteLocal(startsAt)) {
    return {
      error:
        "`startsAt` tiene que ser la hora de pared del club en formato YYYY-MM-DDTHH:MM, sin segundos ni zona horaria.",
    };
  }

  const numPlayers = crudo["numPlayers"];
  if (numPlayers !== 2 && numPlayers !== 4) {
    return { error: "`numPlayers` tiene que ser 2 o 4." };
  }

  const playerName = crudo["playerName"];
  if (typeof playerName !== "string" || playerName.trim().length === 0) {
    return { error: "`playerName` no puede estar vacio." };
  }

  return { courtId, startsAt, numPlayers, playerName };
}

export async function POST(request: Request): Promise<Response> {
  try {
    const { id: tenantId, timezone } = await resolveTenant();
    const sub = subDeSesion(request);
    if (sub === null) {
      return sinSesion();
    }

    let cuerpo: unknown;
    try {
      cuerpo = await request.json();
    } catch {
      return peticionInvalida("el cuerpo no es JSON.");
    }
    const validado = validarCuerpo(cuerpo);
    if ("error" in validado) {
      return peticionInvalida(validado.error);
    }

    const resultado = await crearHold(tenantId, timezone, sub, validado);
    switch (resultado.tipo) {
      case "creado":
        return Response.json(resultado.hold, {
          status: 201,
          headers: { "cache-control": SIN_CACHE },
        });
      case "sin_pista":
        return noExistePista();
      case "sin_usuario":
        return sinSesion();
      case "conflicto":
        return horarioOcupado(resultado.alternativas);
    }
  } catch (error: unknown) {
    // El error COMPLETO al log, a la respuesta nada. Mismo criterio que availability:
    // el mensaje de `resolveTenant` o el de una consulta no es para un visitante.
    console.error(
      "[api/holds] no se pudo crear el hold",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return Response.json(
      { error: "No se pudo crear el hold." },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}