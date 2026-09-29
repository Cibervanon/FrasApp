import { computeRefund, TRAMOS_POR_DEFECTO } from "@frasapp/core";
import type { BookingStatus, CancellationPolicy, RefundQuote } from "@frasapp/core";
import { cancellationPolicySchema } from "@frasapp/config-schema";
import type { CancellationPolicyConfig } from "@frasapp/config-schema";

import { tenantQuery, tenantSession, type SesionQueryable } from "./db";
import { esGestor, type StripeConnectClient } from "./stripe-connect";

/**
 * T14b: cancelar una reserva confirmada y reembolsarla (spec
 * t14b-cancel-refund.md).
 *
 * EL ORDEN DE LOS DOS PASOS ES EL DE LA SPEC (T14b-D): primero se CANCELA la
 * reserva, y SOLO DESPUES se pide el reembolso a Stripe. El paso 1 va dentro de
 * `tenantSession` (una transaccion real): la cancelacion, el snapshot y la politica
 * son ATOMICOS. El paso 2 va FUERA de la transaccion a proposito: si Stripe falla,
 * la cancelacion tiene que sobrevivir. Si el reembolso estuviera dentro del
 * callback, un fallo de Stripe revertiria `status='cancelled'` y la reserva
 * seguiria `confirmed` con la pista ocupada, que es justo lo que la spec dice que
 * no puede pasar.
 *
 * POR QUE EL REINTENTO USA EL SNAPSHOT Y NO LA POLITICA ACTUAL
 * `cancelarReserva` guarda en el booking `refund_tier_hours_before` y
 * `refund_percent_applied` en el MISMO update que cancela. `reembolsarCancelada`
 * (el `POST /refund` del gestor) NO relee `tenant_content`: recalcular contra la
 * politica actual contestaria una pregunta distinta si el club la cambio entre
 * medias (la decide T14b-G: el snapshot manda). El importe del reintento es
 * `round(price_cents * percent_applied / 100)`, identico al que calculo el motor
 * en la cancelacion.
 *
 * LA POLITICA: `tenant_content['cancellation_policy']`, en el snake_case de la
 * base, validada con `cancellationPolicySchema` (el mismo esquema que edita el
 * panel, como `brandingSchema` en `branding.ts`). Un club SIN fila usa
 * `TRAMOS_POR_DEFECTO` (un club nuevo no puede caerse por no haber configurado
 * aun). Una fila PRESENTE pero invalida lanza (500): aplicar la politica por
 * defecto a un club que definio otra seria contestarle con dinero que no pidio.
 */

/** Lo que se sabe del reembolso de una cancelacion: 0, hecho o pendiente. */
export interface EstadoReembolso {
  /** El snapshot del motor: importe, tramo y porcentaje que se aplicaron. */
  readonly quote: RefundQuote;
  /** El id del refund de Stripe, o null si no habia importe o Stripe fallo. */
  readonly refundId: string | null;
  /** True SOLO si habia importe y Stripe fallo: el gestor puede reintentar. */
  readonly pendiente: boolean;
}

/** Lo que puede salir de `cancelarReserva`. La ruta traduce cada caso a un status. */
export type CancelarResultado =
  | { readonly tipo: "cancelado"; readonly reembolso: EstadoReembolso }
  | { readonly tipo: "sin_reserva" }
  | { readonly tipo: "transicion_invalida" }
  | { readonly tipo: "ya_pasada" };

/** Lo que puede salir de `reembolsarCancelada`. La ruta traduce cada caso a un status. */
export type ReembolsarResultado =
  | { readonly tipo: "reembolsado"; readonly reembolso: { quote: RefundQuote; refundId: string } }
  | { readonly tipo: "sin_reserva" }
  | { readonly tipo: "transicion_invalida" }
  | { readonly tipo: "sin_importe" };

/** El fragmento de `bookings` que la cancelacion necesita de la fila. */
interface FilaCancelar {
  readonly user_id: string;
  readonly status: BookingStatus;
  readonly price_cents: number;
  readonly starts_at: Date;
  readonly stripe_payment_intent_id: string | null;
}

/** El fragmento que el reintento del gestor necesita de la fila cancelada. */
interface FilaReembolso {
  readonly user_id: string;
  readonly status: BookingStatus;
  readonly payment_status: string | null;
  readonly amount_refunded_cents: number;
  readonly price_cents: number;
  readonly stripe_payment_intent_id: string | null;
  readonly refund_tier_hours_before: number | null;
  readonly refund_percent_applied: number | null;
}

/** Lo que la fase 1 (transaccion) devuelve para que la fase 2 decida. */
type CirugiaCancelacion =
  | { readonly estado: "cancelada"; readonly fila: FilaCancelar; readonly quote: RefundQuote }
  | { readonly estado: "sin_reserva" }
  | { readonly estado: "transicion_invalida" }
  | { readonly estado: "ya_pasada" };

/** Lo mismo para el reintento del gestor: el porcentaje sale ya estrechado. */
type ReembolsoLeido =
  | { readonly estado: "reembolsable"; readonly fila: FilaReembolso; readonly percent: number }
  | { readonly estado: "sin_reserva" }
  | { readonly estado: "transicion_invalida" }
  | { readonly estado: "sin_importe" };

const SQL_BUSCAR_CANCELAR = `
select user_id, status, price_cents, starts_at, stripe_payment_intent_id
  from public.bookings
 where id = $1
`;

const SQL_BUSCAR_REEMBOLSO = `
select user_id, status, payment_status, amount_refunded_cents, price_cents,
       stripe_payment_intent_id, refund_tier_hours_before, refund_percent_applied
  from public.bookings
 where id = $1
`;

const SQL_MARCAR_CANCELADA = `
update public.bookings
   set status = 'cancelled',
       cancelled_at = now(),
       refund_tier_hours_before = $2,
       refund_percent_applied = $3
 where id = $1
   and status = 'confirmed'
returning 1 as uno
`;

const SQL_MARCAR_REEMBOLSADO = `
update public.bookings
   set payment_status = 'refunded',
       amount_refunded_cents = $2
 where id = $1
   and status = 'cancelled'
   and payment_status = 'paid'
   and amount_refunded_cents = 0
returning 1 as uno
`;

/** Traduce el jsonb snake_case de la base al `CancellationPolicy` camelCase de core. */
function aPoliticaCore(config: CancellationPolicyConfig): CancellationPolicy {
  return {
    tiers: config.tiers.map((t) => ({
      hoursBefore: t.hours_before,
      refundPercent: t.refund_percent,
      label: t.label,
    })),
    policyText: config.policy_text,
    noticeText: config.notice_text,
  };
}

/** La politica del club, o el default si no tiene fila todavia. Lanza si la hay invalida. */
async function leerPolitica(
  db: SesionQueryable,
  tenantId: string,
): Promise<CancellationPolicy> {
  const filas = await db.query<{ value: unknown }>(
    `select value from public.tenant_content
      where tenant_id = $1 and content_key = 'cancellation_policy'`,
    [tenantId],
  );
  const cruda = filas.rows[0]?.value;
  if (cruda === undefined) {
    return { tiers: TRAMOS_POR_DEFECTO, policyText: "", noticeText: "" };
  }

  const parseado = cancellationPolicySchema.safeParse(cruda);
  if (!parseado.success) {
    const problemas = parseado.error.issues
      .map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
      .join("; ");
    throw new Error(
      `La politica de cancelacion del tenant ${tenantId} no es valida contra ` +
        `\`cancellationPolicySchema\`, y no se cancela con una politica rota ni con el ` +
        `default (un club que la definio merece saber que la tiene mal, no que se le ` +
        `aplique la de un club que no la ha tocado): ${problemas}\n` +
        `La fila esta en public.tenant_content ('cancellation_policy'). El esquema es el ` +
        `contrato: si el valor es legitimo, el arreglo es en packages/config-schema.`,
    );
  }

  return aPoliticaCore(parseado.data);
}

/**
 * Fase 1 de la cancelacion: transaccion atomica (leer + calcular + cancelar).
 *
 * Fuera de la transaccion queda lo que no puede revertirse por un fallo de Stripe
 * (ver el comentario de cabecera). Devuelve el estado de negocio; si la reserva se
 * cancelo devuelve tambien la fila y el snapshot para que `cancelarReserva` decida
 * el reembolso.
 */
function cancelarEnTransaccion(
  tenantId: string,
  sub: string,
  bookingId: string,
): Promise<CirugiaCancelacion> {
  return tenantSession(tenantId, sub, async (db) => {
    const filas = await db.query<FilaCancelar>(SQL_BUSCAR_CANCELAR, [bookingId]);
    const fila = filas.rows[0];
    if (fila === undefined) {
      return { estado: "sin_reserva" };
    }
    if (fila.user_id !== sub && !(await esGestor(tenantId, sub))) {
      // El 404 (inexistente, de otro club, de otro socio) se decide igual que en
      // `cobrarHold`: la RLS ya dejo fuera a los otros clubs, y aqui se compara el
      // `sub` con el `user_id` para que la reserva de otro socio sea como si no
      // existiera. El gestor (T14b-B) SI la puede cancelar.
      return { estado: "sin_reserva" };
    }
    if (fila.status !== "confirmed") {
      // Solo `confirmed` se cancela (T14b-A). Una `pending_payment` esta cobrandose;
      // una `cancelled` ya lo esta. CERO llamadas a Stripe fuera de `confirmed`.
      return { estado: "transicion_invalida" };
    }

    const hoursBefore = (fila.starts_at.getTime() - Date.now()) / 3_600_000;
    if (hoursBefore < 0) {
      // La reserva ya empezo: no se puede devolver nada a tiempo (T14b-F -> 422).
      return { estado: "ya_pasada" };
    }

    const politica = await leerPolitica(db, tenantId);
    const quote = computeRefund({ priceCents: fila.price_cents, hoursBefore, policy: politica });

    const canceladas = await db.query<{ uno: number }>(SQL_MARCAR_CANCELADA, [
      bookingId,
      quote.tierHoursBefore,
      quote.percentApplied,
    ]);
    if (canceladas.rows.length === 0) {
      // La carrera perdida: alguien movio la reserva entre el select y este update.
      return { estado: "transicion_invalida" };
    }

    return { estado: "cancelada", fila, quote };
  });
}

/**
 * Cancela una reserva `confirmed` del socio y la reembolsa segun la politica.
 *
 * TODO lo que puede fallar de verdad (Stripe caido, politica invalida) se propaga o
 * se convierte en `pendiente`, pero la CANCELACION ya esta hecha: el socio recupera
 * su pista y su reserva a tiempo, y el reembolso es un efecto que puede reintentarse
 * desde `reembolsarCancelada` sin perder ni un centimo (paso 8 de la spec).
 *
 * @throws Si la base falla o la politica presente es invalida (la ruta -> 500).
 */
export async function cancelarReserva(
  client: StripeConnectClient,
  tenantId: string,
  sub: string,
  bookingId: string,
): Promise<CancelarResultado> {
  const cirugia = await cancelarEnTransaccion(tenantId, sub, bookingId);
  if (cirugia.estado !== "cancelada") {
    return { tipo: cirugia.estado };
  }
  const { fila, quote } = cirugia;

  if (quote.refundCents <= 0) {
    // T14b-H: un tramo del 0% (o ninguno) NO llama a Stripe. El pago sigue 'paid' y
    // el snapshot queda escrito (0/0 o null/null): la pantalla del socio explica por
    // que no se le devolvio nada, aunque el club cambie la politica despues.
    return { tipo: "cancelado", reembolso: { quote, refundId: null, pendiente: false } };
  }

  if (fila.stripe_payment_intent_id === null) {
    // Confirmada sin intent: la via de pago de T14 siempre lo deja, un insert directo
    // (T15) no paga por Stripe y no hay nada que devolver al proveedor. Mismo
    // resultado que "Stripe fallo": cancelada + pendiente, sin reembolso en curso.
    return { tipo: "cancelado", reembolso: { quote, refundId: null, pendiente: true } };
  }

  try {
    const reembolso = await client.crearReembolso({
      paymentIntentId: fila.stripe_payment_intent_id,
      amountCents: quote.refundCents,
      // La Idempotency-Key por booking hace que la cancelacion y el reintento del
      // gestor compartan el MISMO refund de Stripe: si ambos corren, Stripe devuelve
      // el del primero (T14b-C) y no hay doble dinero.
      idempotencyKey: `reembolso_${bookingId}`,
    });
    await tenantQuery(
      tenantId,
      SQL_MARCAR_REEMBOLSADO,
      [bookingId, quote.refundCents],
      sub,
    );
    return { tipo: "cancelado", reembolso: { quote, refundId: reembolso.refundId, pendiente: false } };
  } catch (error: unknown) {
    // La cancelacion YA esta commitada. Se responde "cancelado con reembolso
    // pendiente": el gestor ve el boton de reintentar. El error se queda aqui, sin
    // devolver un 500 que diria que la cancelacion no ocurrio.
    return { tipo: "cancelado", reembolso: { quote, refundId: null, pendiente: true } };
  }
}

/**
 * Reintenta el reembolso de una reserva cancelada (gestor).
 *
 * El resultado del `POST /refund`: SOLO una reserva `cancelled` + `paid` sin
 * reembolsar tiene algo que hacer (T14b-E). Usa el snapshot guardado, nunca la
 * politica actual, y la misma Idempotency-Key que la cancelacion: si la cancelacion
 * ya consiguio el reembolso de Stripe pero el update perdio una carrera, este
 * intento recupera el mismo refund sin duplicar dinero.
 *
 * @throws Si la base o Stripe fallan (la ruta -> 500).
 */
export async function reembolsarCancelada(
  client: StripeConnectClient,
  tenantId: string,
  sub: string,
  bookingId: string,
): Promise<ReembolsarResultado> {
  // El tipo es explicito, y no se deja que lo infiera el cierre: sin el, el `estado`
  // del ultimo return se widen a `string` y el mapeo de abajo deja de compilar.
  const leida = await tenantSession(
    tenantId,
    sub,
    async (db): Promise<ReembolsoLeido> => {
      const filas = await db.query<FilaReembolso>(SQL_BUSCAR_REEMBOLSO, [bookingId]);
      const fila = filas.rows[0];
      if (fila === undefined) {
        return { estado: "sin_reserva" };
      }
      if (fila.user_id !== sub && !(await esGestor(tenantId, sub))) {
        return { estado: "sin_reserva" };
      }
      if (
        fila.status !== "cancelled" ||
        fila.payment_status !== "paid" ||
        fila.amount_refunded_cents !== 0
      ) {
        // No se reembolsa sin cancelar (T14b-E): ni confirmada, ni cancelada sin pago,
        // ni ya reembolsada.
        return { estado: "transicion_invalida" };
      }
      if (fila.refund_percent_applied === null || fila.refund_percent_applied === 0) {
        return { estado: "sin_importe" };
      }
      // El porcentaje sale YA estrechado (`number`, no `number | null`) de este
      // cierre, para que el calculo del importe de mas abajo no tenga que volver a
      // comprobar lo que aqui se ha comprobado.
      return { estado: "reembolsable", fila, percent: fila.refund_percent_applied };
    },
  );

  if (leida.estado !== "reembolsable") {
    return { tipo: leida.estado };
  }
  const { fila, percent } = leida;
  if (fila.stripe_payment_intent_id === null) {
    return { tipo: "transicion_invalida" };
  }

  const refundCents = Math.round((fila.price_cents * percent) / 100);
  const reembolso = await client.crearReembolso({
    paymentIntentId: fila.stripe_payment_intent_id,
    amountCents: refundCents,
    idempotencyKey: `reembolso_${bookingId}`,
  });
  await tenantQuery(tenantId, SQL_MARCAR_REEMBOLSADO, [bookingId, refundCents], sub);

  return {
    tipo: "reembolsado",
    reembolso: {
      quote: {
        refundCents,
        tierHoursBefore: fila.refund_tier_hours_before,
        percentApplied: percent,
        label: null,
      },
      refundId: reembolso.refundId,
    },
  };
}