import { crearHold } from "../../../lib/server/holds";
import type { Tutor } from "../../../lib/server/holds";
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
 *  2. Valida el cuerpo. El servidor es quien decide el precio, quien comprueba el hueco y
 *     quien decide si el jugador es menor (T14c). El cliente solo trae la pista, la hora
 *     (hora de pared del club, sin offset), los jugadores, la fecha de nacimiento y, si
 *     hace falta, el tutor. Un `tenant_id`, un `priceCents` o un `isMinor` que lleguen de
 *     paso se ignoran: el precio lo calcula `holds.ts`, el tenant ya esta resuelto y la
 *     edad la deduce el servidor de la fecha y del umbral del club.
 *  3. La logica (y sus respuestas) vive en `holds.ts`: 404 si la pista no esta, 409 con
 *     los huecos que quedan si la hora no esta libre, 401 si el `sub` no es una persona,
 *     422 si es menor y no vienen los datos del tutor, 201 con el hold si todo cuadra.
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

/**
 * Un 422: el cuerpo esta BIEN formado y lo que falta es un dato que el socio tiene que dar.
 *
 * Y no un 400 porque un 400 en un formulario se lee como "has escrito algo mal" y aqui lo
 * que se ha escrito esta bien: lo que falta es el tutor de un menor (T14c). El unico 422
 * del sistema, y con codigo para que la UI (T18a) sepa que formulario mostrar.
 */
function faltanDatosDelTutor(): Response {
  return Response.json(
    {
      error:
        "Este jugador es menor y necesita los datos de su tutor o tutora legal: nombre, " +
        "email, telefono y el vinculo.",
      code: "faltan_datos_tutor",
    },
    { status: 422, headers: { "cache-control": SIN_CACHE } },
  );
}

/** El cuerpo dice una cosa y el servidor, que ha leido la fecha, dice otra. */
function tutorIncoherente(): Response {
  return Response.json(
    {
      error:
        "Los datos del tutor no se admiten: con la fecha de nacimiento enviada, este " +
        "jugador no es menor para este club.",
      code: "tutor_no_requerido",
    },
    { status: 400, headers: { "cache-control": SIN_CACHE } },
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
  readonly playerBirthDate: string;
  readonly tutor?: Tutor;
}

/** Los vinculos que acepta el enum de `bookings.guardian_relation`. */
const RELACIONES = ["madre", "padre", "tutor_legal", "otro"] as const;

/** `YYYY-MM-DD`. La forma, no el calendario: que el dia 30 exista lo mira el servidor. */
const FORMATO_FECHA = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Valida el cuerpo, campo a campo.
 *
 * Devuelve `null` si es valido, o el mensaje del 400 si no. Separada del handler para
 * que los casos malformados tengan un solo sitio donde vivir y cada campo diga lo suyo
 * en vez de un "cuerpo invalido" generico.
 *
 * ---------------------------------------------------------------------------------------
 * `playerBirthDate` ES OBLIGATORIA, Y AQUI SOLO SE COMPRUEBA LA FORMA
 *
 * Que el dia exista en el calendario, y que no sea de futuro, NO se comprueba aqui: eso lo
 * decide `holds.ts` con el "hoy" del club y devuelve `fecha_invalida`. Repartido asi porque
 * la forma la sabe esta funcion y el calendario, no.
 *
 * Y el `tutor` es opcional en la FORMA pero no en el fondo: si el jugador es menor, o no
 * estan los cuatro datos y sale 422, o estan y se guardan. Que el club no mande tutor para
 * un mayor sale 400, porque ahi los dos no se cuentan.
 */
function validarCuerpo(cuerpo: unknown): { error: string } | CuerpoHold {
  if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) {
    return {
      error:
        "el cuerpo tiene que ser un objeto JSON con courtId, startsAt, numPlayers, " +
        "playerName y playerBirthDate.",
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

  const playerBirthDate = crudo["playerBirthDate"];
  if (playerBirthDate === undefined) {
    // No es un 422: sin fecha no se puede NI SABER si es menor, y el 422 de T14c es para el
    // caso en que el servidor ya ha dicho que es menor y lo que falta es el tutor.
    return {
      error:
        "`playerBirthDate` es obligatoria, en formato YYYY-MM-DD. Sin ella el club no " +
        "puede saber si el jugador es menor y no puede pedir el consentimiento de su tutor.",
    };
  }
  if (typeof playerBirthDate !== "string" || !FORMATO_FECHA.test(playerBirthDate)) {
    return { error: "`playerBirthDate` tiene que ser una fecha en formato YYYY-MM-DD." };
  }

  const tutor = validarTutor(crudo["tutor"]);
  if ("error" in tutor) {
    return tutor;
  }

  // El spread y no `tutor: tutor.tutor` porque el repo va con `exactOptionalPropertyTypes`:
  // una clave opcional puede no estar, pero si esta no puede valer `undefined`. Un tutor
  // ausente se propaga como AUSENTE, que es lo que `crearHold` distingue de "viene vacio".
  return {
    courtId,
    startsAt,
    numPlayers,
    playerName,
    playerBirthDate,
    ...(tutor.tutor === undefined ? {} : { tutor: tutor.tutor }),
  };
}

/**
 * El bloque `tutor`: ausente, o los cuatro datos con su forma. Un bloque a medias es 400 y
 * no 422, porque un 422 aqui diria "venga, thats mejor" de algo que el socio ha escrito mal.
 */
function validarTutor(bruto: unknown): { error: string } | { tutor?: Tutor } {
  if (bruto === undefined || bruto === null) {
    return {};
  }
  if (typeof bruto !== "object" || Array.isArray(bruto)) {
    return { error: "`tutor` tiene que ser un objeto con los datos del tutor." };
  }
  const campos = bruto as Record<string, unknown>;

  const textos = {
    guardianName: campos["guardianName"],
    guardianEmail: campos["guardianEmail"],
    guardianPhone: campos["guardianPhone"],
  };
  for (const [nombre, valor] of Object.entries(textos)) {
    if (typeof valor !== "string" || valor.trim().length === 0) {
      return { error: `\`tutor.${nombre}\` tiene que ser un texto no vacio.` };
    }
  }

  const guardianRelation = campos["guardianRelation"];
  if (typeof guardianRelation !== "string" || !RELACIONES.includes(guardianRelation as never)) {
    return {
      error: "`tutor.guardianRelation` tiene que ser madre, padre, tutor_legal u otro.",
    };
  }

  return {
    tutor: {
      guardianName: textos.guardianName as string,
      guardianEmail: textos.guardianEmail as string,
      guardianPhone: textos.guardianPhone as string,
      guardianRelation: guardianRelation as Tutor["guardianRelation"],
    },
  };
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
        // El `hold` entero, que ya trae `isMinor`: lo que el servidor dedujo, no lo que pidio
        // el cuerpo. La UI (T18a) lo lee de aqui para mostrar el formulario del tutor.
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
      case "faltan_datos_tutor":
        return faltanDatosDelTutor();
      case "tutor_no_requerido":
        return tutorIncoherente();
      case "fecha_invalida":
        return peticionInvalida(
          "`playerBirthDate` no es una fecha valida: tiene que existir en el calendario y " +
            "no puede ser de futuro.",
        );
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