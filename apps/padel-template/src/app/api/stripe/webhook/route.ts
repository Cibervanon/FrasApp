import Stripe from "stripe";

import { baseQuery } from "../../../../lib/server/db";
import {
  crearClienteStripe,
  sincronizarEstadoConnect,
  type StripeConnectClient,
} from "../../../../lib/server/stripe-connect";

/**
 * `POST /api/stripe/webhook` — la firma autoriza, no el gestor.
 *
 * Stripe envía salidas HTTP: a diferencia de una peticion de navegador, aqui no hay
 * cookie que atribuir. El unico cuerpo de confianza es la firma: `constructEvent`
 * verifica que el cuerpo llego de Stripe y no fue tocado.
 *
 * EL ORDEN IMPORTA: PRIMERO FIRMA, DESPUES EFECTO (spec t13, criterio 7.6).
 * `tenants` no tiene RLS y un `account.updated` con una firma rota seria una ventana
 * para re-escribir el estado Connect de un club. Sin firma valida no hay NINGUNA
 * query, y eso es exactamente lo que protegen los tests "sin cabecera" y "firma
 * invalida" (401).
 *
 * LO QUE SE MANEJA EN T13 Y LO QUE NO
 * - `account.updated`: re-sincroniza flags del tenant dueño de esa cuenta. Idempotente:
 *   Stripe reintenta lo que no conteste, y reescribir los mismos booleanos no tiene
 *   efecto lateral.
 * - Cualquier otro evento se contesta 200 vacio (ack). Stripe deja de reintentar, y
 *   T14 engancha ahi sus `payment_intent.*`.
 */

export const dynamic = "force-dynamic";

interface FilaCuenta {
  readonly id: string;
}

export async function manejarWebhook(
  request: Request,
  client?: StripeConnectClient,
): Promise<Response> {
  const firma = request.headers.get("stripe-signature");
  const cuerpo = await request.text();

  if (!firma) {
    return new Response(null, { status: 401 });
  }

  const secreto = process.env["STRIPE_WEBHOOK_SECRET"];
  if (!secreto) {
    console.error(
      "[api/stripe/webhook] falta STRIPE_WEBHOOK_SECRET. El webhook falla cerrado: " +
        "sin secreto no se puede verificar ninguna firma.",
    );
    return new Response(null, { status: 401 });
  }

  let evento: Stripe.Event;
  try {
    evento = Stripe.webhooks.constructEvent(cuerpo, firma ?? "", secreto);
  } catch (error: unknown) {
    console.error(
      "[api/stripe/webhook] firma invalida o cabecera ausente",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return new Response(null, { status: 401 });
  }

  try {
    if (evento.type === "account.updated") {
      const objeto = evento.data.object as { id?: unknown };
      if (typeof objeto.id !== "string") {
        // Un account.updated sin id es un evento malformado: no hay cuenta que
        // sincronizar, y contestar 200 lo descarta sin romper el flujo de Stripe.
        return new Response(null, { status: 200 });
      }
      const dueños = await baseQuery<FilaCuenta>(
        `select id from public.tenants where stripe_account_id = $1 limit 2`,
        [objeto.id],
      );
      if (dueños.length === 0) {
        // Cuenta de otra instancia (o de otro club borrado): 200 sin efectos. Una
        // instancia limpia no contesta 404 a Stripe (reintentaria para siempre).
        return new Response(null, { status: 200 });
      }
      const efectivo = client ?? crearClienteStripe();
      await sincronizarEstadoConnect(efectivo, objeto.id);
    }
    return new Response(null, { status: 200 });
  } catch (error: unknown) {
    console.error(
      "[api/stripe/webhook] no se pudo procesar el evento",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    // 500 para que Stripe reintente: un error interno no es un ack de "recibido".
    return new Response(null, { status: 500 });
  }
}

export async function POST(request: Request): Promise<Response> {
  return manejarWebhook(request);
}