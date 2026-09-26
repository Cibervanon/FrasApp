/**
 * Tipos del dominio. Sin logica, sin React, sin Supabase, sin red.
 *
 * Capa `core`. Si esto importa `next`, `@supabase/*` o `react`, es un fallo de
 * arquitectura: la regla la verifica el test de limites de capas.
 *
 * Todos los importes son `import type` a proposito (verbatimModuleSyntax): este
 * fichero no debe emitir nada en runtime.
 */

/** Tenant: instancia aislada. Una fila por club. */
export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  /** 14 a 21. Por defecto 18. Lo usa el calculo de menores en servidor. */
  readonly minPlayerAge: number;
  /** null mientras el club no haya conectado Stripe. Bloquea los cobros. */
  readonly stripeAccountId: string | null;
  readonly stripeChargesEnabled: boolean;
  readonly stripePayoutsEnabled: boolean;
}

/** Marca del tenant. Nunca hardcodeada en componentes (regla 1). */
export interface Branding {
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly logoUrl: string | null;
  readonly senderName: string;
  /** A donde contesta el club cuando llega un email. */
  readonly replyToEmail: string;
}

export type FeatureKey =
  | "open_matches"
  | "news"
  | "guest_bookings"
  | "online_payments"
  | "advanced_pricing";

/** Un tramo de la politica de cancelacion. Ordenados, sin solapes. */
export interface RefundTier {
  /** Horas de antelacion minimas que activation este tramo. */
  readonly minHoursBefore: number;
  /** Porcentaje a devolver, 0 a 100. Entero. */
  readonly percent: number;
}

/** Politica de cancelacion. Vive en tenant_content, con valores por defecto. */
export interface CancellationPolicy {
  readonly tiers: readonly RefundTier[];
}

export type BookingStatus =
  | "held"
  | "pending_payment"
  | "confirmed"
  | "cancelled"
  | "completed";

export type PaymentStatus =
  | "unpaid"
  | "paid"
  | "failed"
  | "refunded"
  | "partially_refunded";

/** Regla de precio dinamico. Se evalua en servidor, nunca en el cliente. */
export interface PricingRule {
  readonly id: string;
  /** Mayor numero gana cuando dos reglas se solapan. */
  readonly priority: number;
  /** Dias de la semana, 0 domingo a 6 sabado. */
  readonly weekdays: readonly number[];
  /** Hora local del club, formato HH:mm. */
  readonly startTime: string;
  readonly endTime: string;
  /** Importe final en centimos. Entero, sin coma flotante. */
  readonly priceCents: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
}

/** Resultado de resolver el precio de una pista en una franja concreta. */
export interface ResolvedPrice {
  readonly priceCents: number;
  readonly appliedRuleId: string | null;
}
