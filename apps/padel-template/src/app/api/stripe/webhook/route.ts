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
 * LO QUE SE MANEJA Y LO QUE NO
 * - `payment_intent.succeeded` / `payment_intent.payment_failed` (T14): cierran el
 *   ciclo de cobro. El bind al booking es por `bookings.stripe_payment_intent_id`, y
 *   el indice unico parcial de E1 garantiza a lo sumo una fila.
 * - `account.updated` (T13): re-sincroniza flags del tenant dueño de esa cuenta.
 * - Cualquier otro evento se contesta 200 vacio (ack). Stripe deja de reintentar.
 *
 * IDEMPOTENCIA POR ESTADO (T14-F): el efecto del evento lleva `where status =
 * 'pending_payment'`, asi que reprocesar el MISMO `event.id` (o un evento tardio de
 * un intent ya cerrado) es un no-op: un `confirmed` re-escrito no toca nada, y un
 * `cancelled` tratado dos veces no cancela dos veces. `audit_log` (T19) guardara el
 * historial; la guarda de estado es la idempotencia funcional.
 */

export const dynamic = "force-dynamic";

interface FilaCuenta {
  readonly id: string;
}

interface FilaIntent {
  readonly id: string;
}

/**
 * Confirma el pago recibido. El `where status = 'pending_payment'` es la idempotencia:
 * un replay sobre un booking ya confirmado no toca nada, y sobre uno cancelado o
 * expirado tampoco (no resucita reservas, T14-E).
 */
const SQL_CONFIRMAR_PAGO = `
update public.bookings
   set status = 'confirmed',
       payment_status = 'paid',
       confirmed_at = now(),
       hold_expires_at = null
 where id = $1
   and status = 'pending_payment'
`;

/**
 * Cancela el cobro fallido. `payment_status` sigue 'unpaid': el pago no llego, y el
 * slot se libera porque el predicado del EXCLUDE solo tapa held/pending_payment/
 * confirmed.
 */
const SQL_CANCELAR_PAGO = `
update public.bookings
   set status = 'cancelled',
       cancelled_at = now(),
       hold_expires_at = null
 where id = $1
   and status = 'pending_payment'
`;

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
    if (
      evento.type === "payment_intent.succeeded" ||
      evento.type === "payment_intent.payment_failed"
    ) {
      const objeto = evento.data.object as { id?: unknown };
      if (typeof objeto.id !== "string") {
        // Un evento de intent sin id esta malformado: no hay cobro que cerrar, y
        // contestar 200 lo descarta sin romper el flujo de Stripe.
        return new Response(null, { status: 200 });
      }
      // `baseQuery` lo autoriza la firma, igual que `account.updated`; el indice unico
      // de E1 garantiza a lo sumo una fila por intent.
      const filas = await baseQuery<FilaIntent>(
        `select id from public.bookings where stripe_payment_intent_id = $1 limit 2`,
        [objeto.id],
      );
      const booking = filas[0];
      if (booking === undefined) {
        // Intento de otra instancia (o de un club borrado): 200 sin efectos. Una
        // instancia limpia no contesta 404 a Stripe (reintentaria para siempre).
        return new Response(null, { status: 200 });
      }
      const sql =
        evento.type === "payment_intent.succeeded" ? SQL_CONFIRMAR_PAGO : SQL_CANCELAR_PAGO;
      await baseQuery(sql, [booking.id]);
      return new Response(null, { status: 200 });
    }

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