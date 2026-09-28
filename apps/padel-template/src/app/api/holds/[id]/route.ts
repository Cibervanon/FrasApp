import { liberarHold } from "../../../../lib/server/holds";
import { subDeSesion } from "../../../../lib/server/session";
import { resolveTenant } from "../../../../lib/server/tenant";
import { FORMATO_UUID } from "../../../../lib/server/validacion";

/**
 * `DELETE /api/holds/:id` - liberar el hold que yo cree (spec 5.1 y 4.4.1).
 *
 * ---------------------------------------------------------------------------------------
 * LOS TRES 404, Y POR QUE SON EL MISMO
 *
 * "No existe", "es de otro club" y "es de otro socio" responden el MISMO cuerpo con 404.
 * Distinguir el segundo y el tercero confirmaria a quien recorre uuids que existen filas
 * de otros tenants o de otras personas, que es informacion de terceros. `liberarHold`
 * devuelve un solo `sin_hold` para los tres, y esta ruta no puede decir cual fue.
 *
 * La titularidad se decide en la transaccion (ver `holds.ts`): el `sub` de la cookie se
 * compara con el `user_id` del hold, y el hold del vecino es como si no existiera.
 */

/** Nunca se prerenderiza. Mismo motivo que en el resto de las rutas. */
export const dynamic = "force-dynamic";

/** Sin cache: liberar es un cambio de estado inmediato. */
const SIN_CACHE = "no-store";

function sinSesion(): Response {
  return Response.json(
    { error: "No hay sesion para liberar el hold." },
    { status: 401, headers: { "cache-control": SIN_CACHE } },
  );
}

function peticionInvalida(motivo: string): Response {
  return Response.json(
    { error: `Peticion invalida: ${motivo}` },
    { status: 400, headers: { "cache-control": SIN_CACHE } },
  );
}

function noExisteHold(): Response {
  return Response.json(
    { error: "No se ha encontrado ese hold." },
    { status: 404, headers: { "cache-control": SIN_CACHE } },
  );
}

function noLiberable(): Response {
  return Response.json(
    { error: "Ese hold ya no se puede cancelar." },
    { status: 409, headers: { "cache-control": SIN_CACHE } },
  );
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  try {
    const { id: tenantId, timezone } = await resolveTenant();
    const sub = subDeSesion(request);
    if (sub === null) {
      return sinSesion();
    }

    const { id } = await params;
    if (!FORMATO_UUID.test(id)) {
      return peticionInvalida("el id del hold tiene que ser un uuid.");
    }

    const resultado = await liberarHold(tenantId, timezone, sub, id);
    switch (resultado.tipo) {
      case "liberado":
        return Response.json(resultado.hold, {
          status: 200,
          headers: { "cache-control": SIN_CACHE },
        });
      case "sin_hold":
        return noExisteHold();
      case "transicion_invalida":
        return noLiberable();
    }
  } catch (error: unknown) {
    console.error(
      "[api/holds] no se pudo liberar el hold",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return Response.json(
      { error: "No se pudo liberar el hold." },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}