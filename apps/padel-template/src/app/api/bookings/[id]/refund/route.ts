import { reembolsarCancelada } from "../../../../../lib/server/cancelaciones";
import { subDeSesion } from "../../../../../lib/server/session";
import { crearClienteStripe, type StripeConnectClient } from "../../../../../lib/server/stripe-connect";
import { resolveTenantId } from "../../../../../lib/server/tenant";
import { FORMATO_UUID } from "../../../../../lib/server/validacion";

/**
 * `POST /api/bookings/:id/refund` - reintentar el reembolso de una reserva cancelada
 * (spec t14b-cancel-refund.md, casos 15-19).
 *
 * ---------------------------------------------------------------------------------------
 * PARA QUE EXISTE UNA RUTA DE REEMBOLSO SI `POST /cancel` YA DEVUELVE EL DINERO
 *
 * Porque el unico fallo posible de la cancelacion es el que no se puede arreglar
 * desde dentro: el reembolso se pide a Stripe DESPUES de confirmar la cancelacion (asi
 * un Stripe caido no devuelve la reserva a `confirmed` con la pista ocupada), y por
 * tanto la reserva se puede quedar `cancelled` + `paid` + `amount_refunded_cents = 0`
 * esperando a que alguien lo reintente. Quien lo reintenta es el club, y por eso esta
 * ruta existe separada y no es "la cancelacion otra vez".
 *
 * ---------------------------------------------------------------------------------------
 * EL IMPORTE LO DICE EL SNAPSHOT, Y ESO ES LO QUE HACE SEGURA ESTA RUTA
 *
 * Al reintentar NO se relee la politica del club (spec, T14b-G). El porcentaje que
 * aplico el motor quedo escrito en la reserva (`refund_percent_applied`), asi que un
 * socio que cancela con 25h de margen, se le cae Stripe, y el club sube el tramo a
 * 100% antes de reintentar, recibe el 100% de SU cancelacion, no el 100% de una
 * reserva que ya no es la misma. Recalcular aqui daria la respuesta a una pregunta
 * distinta.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE AQUI UN 500 SI, Y EN `POST /cancel` NO
 *
 * En la cancelacion un fallo de Stripe se traducía a "cancelada, reembolso pendiente"
 * porque la cancelacion ya estaba commitada y un 500 mentiria. Aqui no hay nada
 * commitado todavia: el dinero no se ha devuelto, la fila se queda como estaba
 * (`cancelled` + `paid` + 0) y el siguiente intento sirve. El 500 dice la verdad, que es
 * que el reembolso no se ha hecho. La Idempotency-Key por booking hace que un
 * reintento no pueda devolver dos veces lo que un intento anterior ya habia devuelto
 * antes de caerse.
 */

export const dynamic = "force-dynamic";

const SIN_CACHE = "no-store";

function sinSesion(): Response {
  return Response.json(
    { error: "No hay sesion para reintentar el reembolso." },
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
    { error: "Esa reserva no tiene un reembolso pendiente.", code: "transicion_invalida" },
    { status: 409, headers: { "cache-control": SIN_CACHE } },
  );
}

function sinImporte(): Response {
  return Response.json(
    {
      error: "Esa reserva se cancelo sin importe a devolver: no hay nada que reembolsar.",
      code: "sin_importe",
    },
    { status: 409, headers: { "cache-control": SIN_CACHE } },
  );
}

export async function manejarReembolso(
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

    const resultado = await reembolsarCancelada(client ?? crearClienteStripe(), tenantId, sub, id);
    switch (resultado.tipo) {
      case "reembolsado":
        return Response.json(
          {
            estado: "reembolsado",
            reembolso: {
              refund_id: resultado.reembolso.refundId,
              refund_cents: resultado.reembolso.quote.refundCents,
              tier_hours_before: resultado.reembolso.quote.tierHoursBefore,
              percent_applied: resultado.reembolso.quote.percentApplied,
              // El reintento no relee la politica, asi que no hay etiqueta de tramo que
              // enseñar: el panel explica el importe con el porcentaje del snapshot.
              label: resultado.reembolso.quote.label,
            },
          },
          { status: 200, headers: { "cache-control": SIN_CACHE } },
        );
      case "sin_reserva":
        return noExisteReserva();
      case "transicion_invalida":
        return transicionInvalida();
      case "sin_importe":
        return sinImporte();
    }
  } catch (error: unknown) {
    console.error(
      "[api/bookings/refund] no se pudo reintentar el reembolso",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return Response.json(
      { error: "No se pudo completar el reembolso." },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  return manejarReembolso(request, context);
}
