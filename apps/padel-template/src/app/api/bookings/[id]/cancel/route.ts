import { cancelarReserva } from "../../../../../lib/server/cancelaciones";
import { subDeSesion } from "../../../../../lib/server/session";
import { crearClienteStripe, type StripeConnectClient } from "../../../../../lib/server/stripe-connect";
import { resolveTenantId } from "../../../../../lib/server/tenant";
import { FORMATO_UUID } from "../../../../../lib/server/validacion";

/**
 * `POST /api/bookings/:id/cancel` - cancelar una reserva confirmada y reembolsar lo que
 * diga la politica del club (spec t14b-cancel-refund.md, casos 1-14).
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE RESPONDE ESTA RUTA Y POR QUE NO ES UN 200 SIEMPRE
 *
 * Cancelar es una operacion que puede ser razonable (el socio cancela con 25h de margen y
 * se le devuelve el 100%), razonable pero sin dinero (5h antes, tramo del 0%), o imposible
 * (la reserva ya empezo, el cobro esta en curso, la reserva es de otro). Cada caso tiene un
 * status distinto, y el status es lo que la pantalla necesita para explicarse:
 *
 *   401 sin sesion | 400 id no uuid | 404 no es suya (o no existe) | 409 el estado no
 *   deja cancelar | 422 la reserva ya empezo | 200 cancelada, con el detalle del reembolso.
 *
 * ---------------------------------------------------------------------------------------
 * NADA DEL CUERPO SE LEE, Y ESO ES EL PUNTO
 *
 * El importe del reembolso no se pide: sale de `bookings.price_cents` (el snapshot que
 * resolvio el servidor al crearla) y del tramo que devuelve `computeRefund`. Un
 * `amount_cents` o un `refund_percent` en el body no se lee, asi que no hay forma de que
 * un navegador decida cuanto se devuelve (T14b-F). El `POST` sin cuerpo es la forma
 * normal; mandar cuerpo no es un error, simplemente no cambia nada.
 *
 * ---------------------------------------------------------------------------------------
 * EL 200 CON `pendiente: true` NO ES UN ERROR
 *
 * Si Stripe falla, la cancelacion YA esta hecha y confirmada en la base (es el orden de la
 * spec, T14b-D: primero se cancela, despues se devuelve el dinero). Un 500 aqui diria al
 * socio que no se cancelo, y su reserva volveria a estar `confirmed` occupying la pista.
 * El 200 con `reembolso.pendiente` es la verdad: cancelada, y el dinero estara en el
 * siguiente reintento (`POST /refund`, del gestor).
 */

export const dynamic = "force-dynamic";

/** Sin cache: cancelar es un cambio de estado inmediato. */
const SIN_CACHE = "no-store";

function sinSesion(): Response {
  return Response.json(
    { error: "No hay sesion para cancelar la reserva." },
    { status: 401, headers: { "cache-control": SIN_CACHE } },
  );
}

function peticionInvalida(motivo: string): Response {
  return Response.json(
    { error: `Peticion invalida: ${motivo}` },
    { status: 400, headers: { "cache-control": SIN_CACHE } },
  );
}

function noExisteReserva(): Response {
  return Response.json(
    { error: "No se ha encontrado esa reserva." },
    { status: 404, headers: { "cache-control": SIN_CACHE } },
  );
}

function transicionInvalida(): Response {
  return Response.json(
    { error: "Esa reserva ya no se puede cancelar.", code: "transicion_invalida" },
    { status: 409, headers: { "cache-control": SIN_CACHE } },
  );
}

function yaEmpezo(): Response {
  return Response.json(
    { error: "Esa reserva ya ha empezado: ya no se puede cancelar.", code: "reserva_pasada" },
    { status: 422, headers: { "cache-control": SIN_CACHE } },
  );
}

export async function manejarCancelar(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
  client?: StripeConnectClient,
): Promise<Response> {
  try {
    const tenantId = await resolveTenantId();
    const sub = subDeSesion(request);
    if (sub === null) {
      return sinSesion();
    }

    const { id } = await params;
    if (!FORMATO_UUID.test(id)) {
      return peticionInvalida("el id de la reserva tiene que ser un uuid.");
    }

    const resultado = await cancelarReserva(
      client ?? crearClienteStripe(),
      tenantId,
      sub,
      id,
    );
    switch (resultado.tipo) {
      case "cancelado":
        return Response.json(
          {
            estado: "cancelado",
            reembolso: {
              refund_id: resultado.reembolso.refundId,
              refund_cents: resultado.reembolso.quote.refundCents,
              tier_hours_before: resultado.reembolso.quote.tierHoursBefore,
              percent_applied: resultado.reembolso.quote.percentApplied,
              label: resultado.reembolso.quote.label,
              pendiente: resultado.reembolso.pendiente,
            },
          },
          { status: 200, headers: { "cache-control": SIN_CACHE } },
        );
      case "sin_reserva":
        return noExisteReserva();
      case "transicion_invalida":
        return transicionInvalida();
      case "ya_pasada":
        return yaEmpezo();
    }
  } catch (error: unknown) {
    // El error COMPLETO al log, la respuesta nada. Mismo criterio que las demas rutas.
    console.error(
      "[api/bookings/cancel] no se pudo cancelar la reserva",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return Response.json(
      { error: "No se pudo cancelar la reserva." },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return manejarCancelar(request, context);
}
