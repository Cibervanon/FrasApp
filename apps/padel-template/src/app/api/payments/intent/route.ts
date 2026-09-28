import { crearClienteStripe, cobrarHold, type StripeConnectClient } from "../../../../lib/server/stripe-connect";
import { subDeSesion } from "../../../../lib/server/session";
import { resolveTenantId } from "../../../../lib/server/tenant";
import { FORMATO_UUID } from "../../../../lib/server/validacion";

/**
 * `POST /api/payments/intent` - cobrar un hold que cree (spec t14-payment-intent.md).
 *
 * ---------------------------------------------------------------------------------------
 * UNA SOLA RUTA PARA EL DINERO (T14-A)
 *
 * T11 crea el hold (`POST /api/holds`) y este endpoint lo convierte en cobro:
 * `held -> pending_payment` + PaymentIntent con `transfer_data.destination` al club. No hay
 * un segundo `POST /api/bookings` compitiendo por la misma transicion (la tabla 5.1 de la
 * spec principal lo listaba; T14 lo absorbe aqui para que el dinero tenga una sola puerta).
 * Si la pantalla de confirmar (T18a) necesitara mas adelante un booking separado, se decide
 * ahi; para cobrar, una.
 *
 * ---------------------------------------------------------------------------------------
 * QUE NUNCA VIENE DEL CLIENTE
 *
 * Solo se acepta `hold_id`. El importe se lee del snapshot `bookings.price_cents` (T12), y
 * cualquier `amount_cents` de paso se descarta (T14-B): si el cliente pudiera mandar un
 * precio, el club estaria cobrando lo que dice un navegador, no lo que resolvio el servidor
 * al crear el hold.
 *
 * ---------------------------------------------------------------------------------------
 * EL 503 POR FUERA DEL FLUJO DE STRIPE
 *
 * Cobrar antes de saber que el club puede cobrar seria un error de diseno (T14-C): sin
 * cuenta Connect o con `charges_enabled = false`, el club esta "configurando los pagos" y
 * la respuesta es un 503 con `tenant_payments_not_ready`, no un error crudo de Stripe.
 */

export const dynamic = "force-dynamic";

/** Sin cache: crear un cobro es un cambio de estado inmediato. */
const SIN_CACHE = "no-store";

function sinSesion(): Response {
  return Response.json(
    { error: "No hay sesion para iniciar el pago." },
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

function holdExpirado(): Response {
  return Response.json(
    { error: "Ese hold ya ha caducado.", code: "hold_expired" },
    { status: 409, headers: { "cache-control": SIN_CACHE } },
  );
}

function transicionInvalida(): Response {
  return Response.json(
    { error: "Ese hold ya no se puede cobrar." },
    { status: 409, headers: { "cache-control": SIN_CACHE } },
  );
}

function pagosNoListos(): Response {
  return Response.json(
    {
      error: "Los pagos de este club todavia no estan listos.",
      code: "tenant_payments_not_ready",
    },
    { status: 503, headers: { "cache-control": SIN_CACHE } },
  );
}

interface CuerpoIntent {
  readonly holdId: string;
}

/**
 * Valida el cuerpo y DESCARTA todo lo que no sea `hold_id`.
 *
 * Un body con `amount_cents` es valido (se ignora): es un cliente que manda mas de lo
 * que debe, no uno que rompe el contrato. El 400 es para quien no manda un uuid, que
 * es el caso de no-puede-existir.
 */
function validarCuerpo(cuerpo: unknown): { error: string } | CuerpoIntent {
  if (typeof cuerpo !== "object" || cuerpo === null || Array.isArray(cuerpo)) {
    return { error: "el cuerpo tiene que ser un objeto JSON con hold_id." };
  }
  const crudo = cuerpo as Record<string, unknown>;
  const holdId = crudo["hold_id"];
  if (typeof holdId !== "string" || !FORMATO_UUID.test(holdId)) {
    return { error: "`hold_id` tiene que ser un uuid." };
  }
  return { holdId };
}

export async function manejarIntent(
  request: Request,
  client?: StripeConnectClient,
): Promise<Response> {
  try {
    const tenantId = await resolveTenantId();
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

    const resultado = await cobrarHold(client ?? crearClienteStripe(), tenantId, sub, validado.holdId);
    switch (resultado.tipo) {
      case "cobro_iniciado":
      case "cobro_recuperado":
        return Response.json(
          {
            payment_intent_id: resultado.intent.paymentIntentId,
            client_secret: resultado.intent.clientSecret,
          },
          { status: 200, headers: { "cache-control": SIN_CACHE } },
        );
      case "ya_pagado":
        return Response.json(
          { payment_intent_id: resultado.paymentIntentId ?? null, estado: "paid" },
          { status: 200, headers: { "cache-control": SIN_CACHE } },
        );
      case "sin_hold":
        return noExisteHold();
      case "hold_expirado":
        return holdExpirado();
      case "transicion_invalida":
        return transicionInvalida();
      case "pagos_no_listos":
        return pagosNoListos();
    }
  } catch (error: unknown) {
    // El error COMPLETO al log, a la respuesta nada. Mismo criterio que las demas rutas.
    console.error(
      "[api/payments/intent] no se pudo iniciar el pago",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return Response.json(
      { error: "No se pudo iniciar el pago." },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return manejarIntent(request);
}