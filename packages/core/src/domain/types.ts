/**
 * Tipos del dominio. Sin logica, sin React, sin Supabase, sin red, sin `Date.now()`.
 *
 * Capa `core`. Si esto importa `next`, `@supabase/*` o `react`, es un fallo de
 * arquitectura: la regla la verifica `boundaries.test.ts`.
 *
 * Todos los importes son `import type` a proposito (verbatimModuleSyntax): este
 * fichero no debe emitir nada en runtime.
 *
 * FORMA DE LOS CAMPOS
 * Aqui los nombres van en camelCase aunque la columna sea snake_case: `core` es un
 * modelo de dominio, no una copia de la tabla. El mapeo a columna ocurre en la
 * frontera (`config-schema` y la capa de datos). Lo que SI tiene que coincidir con
 * la spec es QUE campo existe, no como se escribe.
 *
 * Este fichero se reescribio en T2 porque el que habia en T0 se invento los
 * nombres: `accentColor` por `secondaryColor`, `percent` por `refundPercent`, y
 * sobre todo 5 `FeatureKey` donde la spec define 7. `config-schema` ya tenia las
 * 7 desde T1, asi que los dos paquetes se contradecian sobre cuantos features
 * existen. Dos fuentes de verdad que no coinciden es peor que una sola mala.
 */

/**
 * Features del MVP. La lista exacta vive en `tenant_features.feature_key` y en el
 * `check` de la migracion 001, y el test de `config-schema` la fija. Si anades una
 * aqui, anadela ahi y a la seed, en el mismo commit.
 *
 * Deriva de la seccion 4.1 de la spec: `calendar`, `booking` y `payments` sostienen
 * el club de base, y las otras cuatro las puede activar el gestor.
 */
export type FeatureKey =
  | "calendar"
  | "booking"
  | "payments"
  | "open_matches"
  | "news"
  | "gdpr_export"
  | "push_notifications";

/** Tenant: instancia aislada. Una fila por club. */
export interface Tenant {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly currency: string;
  readonly timezone: string;
  readonly locale: string;
  /** 14 a 21, por defecto 18. Lo usa el calculo de menores en servidor. */
  readonly minPlayerAge: number;
  /** `acct_...` de la cuenta Express del club. null mientras no haya conectado. */
  readonly stripeAccountId: string | null;
  readonly stripeChargesEnabled: boolean;
  readonly stripePayoutsEnabled: boolean;
  readonly stripeOnboardingCompletedAt: string | null;
}

/**
 * Marca del tenant. Nunca hardcodeada en componentes (regla 1).
 *
 * Las ocho columnas de `tenant_branding`. `secondaryColor` es el nombre real: en T0
 * escribi `accentColor`, que no existe en ninguna parte de la spec.
 */
export interface Branding {
  readonly primaryColor: string;
  readonly secondaryColor: string;
  readonly logoPath: string | null;
  readonly faviconPath: string | null;
  readonly heroImagePath: string | null;
  readonly fontFamily: string;
  /** El "De:" que ve el socio. Ajustado por tenant, un solo dominio tecnico. */
  readonly emailFromName: string;
  /** A donde contesta el club cuando llega un email. */
  readonly emailReplyTo: string;
}

export interface TenantFeature {
  readonly featureKey: FeatureKey;
  readonly enabled: boolean;
  /** Ajustes por feature. Nunca obligatorio: una feature no necesita config. */
  readonly config: Readonly<Record<string, unknown>>;
}

/**
 * Un tramo de la politica de cancelacion.
 *
 * `label` NO es opcional ni decorativo: es el texto que lee el socio en la pantalla
 * de confirmacion, y lo escribe el gestor del club. Sin el, la app tendria que
 * hardcodear el copy y la regla 1 lo prohibe. En T0 lo deje fuera de este tipo.
 */
export interface RefundTier {
  /** Horas de antelacion minimas que activan este tramo. */
  readonly hoursBefore: number;
  /** Porcentaje a devolver, 0 a 100. Entero. */
  readonly refundPercent: number;
  /** Texto que ve el socio. Lo escribe el club. */
  readonly label: string;
}

/**
 * Politica de cancelacion. Vive en `tenant_content` bajo `cancellation_policy`.
 *
 * No es un tipo libre: `validateCancellationPolicy` comprueba que los tramos estan
 * ordenados y sin solapes, porque el motor de T8 aplica "el primero que cumplas" y
 * sin orden ese "primero" no existe. El default del club son 3 tramos
 * (24h/100%, 12h/50%, 0h/0%), editables.
 */
export interface CancellationPolicy {
  readonly tiers: readonly RefundTier[];
  readonly policyText: string;
  /** Aviso legal (OQ-9). Tambien lo escribe el club. */
  readonly noticeText: string;
}

export type CourtType = "cristal" | "malla" | "mixto";
export type CourtSurface = "cesped" | "lomo" | "hormigon";

/** Pista. Columnas de `courts` (spec 4.2). */
export interface Court {
  readonly id: string;
  readonly name: string;
  readonly courtType: CourtType;
  readonly surface: CourtSurface | null;
  readonly indoor: boolean;
  /** 2 a 4, con `check` en la base. */
  readonly numPlayers: number;
  readonly defaultDurationMin: number;
  readonly minDurationMin: number;
  readonly maxDurationMin: number;
  readonly basePriceCents: number;
  readonly sortOrder: number;
  readonly isActive: boolean;
  readonly imagePath: string | null;
  /** Baja logica. `null` = viva. */
  readonly deletedAt: string | null;
}

/**
 * Franja que ocupa la pista. `court_blocks` (spec 4.2) y, desde T9, las reservas.
 *
 * Los dos son "algo que impide reservar aqui", asi que availability los consume con la
 * misma funcion y no distingue. En T5 solo entran los `court_blocks`, porque `bookings`
 * todavia no existe; la firma ya esta preparada para que en T9 sea la misma llamada.
 */
export interface TimeRange {
  /** ISO 8601 con offset, o `YYYY-MM-DDTHH:MM` en hora local del club. */
  readonly startsAt: string;
  readonly endsAt: string;
}

/**
 * Un hueco reservable de un dia, ya restado de lo ocupado.
 *
 * `startsAt` y `endsAt` en ISO 8601. Deliberadamente NO lleva `priceCents`: el motor de
 * precios es T7, y anadir el campo ahora haria que T6 (que se construye antes) leyera un
 * numero que luego cambia de signo. Availability y precio se juntan en T12.
 */
export interface AvailabilitySlot {
  readonly startsAt: string;
  readonly endsAt: string;
}

/** Lo que hay que saber para calcular la disponibilidad de una pista en un dia. */
export interface AvailabilityInput {
  /** La pista. De aqui sale la duracion del slot y el nombre. */
  readonly court: Pick<
    Court,
    "id" | "name" | "defaultDurationMin" | "minDurationMin" | "maxDurationMin"
  >;
  /** Dia en `YYYY-MM-DD`, en la zona horaria del club. */
  readonly date: string;
  /** Franjas que ocupan la pista ese dia. `court_blocks` y, en T9, reservas. */
  readonly busy: ReadonlyArray<TimeRange>;
  /**
   * Franja de apertura en minutos desde medianoche. Por defecto 8:00-22:00, que es lo
   * que dice el criterio 7.2.
   *
   * Como numeros y no como `Time`, para que la funcion sea pura de verdad: si abriera con
   * `new Date()` a partir de una cadena, su resultado dependeria de la zona horaria del
   * proceso, y el mismo input daria dos slots distintos en el servidor del club y en el
   * del portátil de quien escribe el test.
   */
  readonly openMinuteOfDay?: number;
  readonly closeMinuteOfDay?: number;
}

/** Resultado de `computeAvailability`. */
export interface AvailabilityResult {
  readonly courtId: string;
  readonly date: string;
  readonly slots: ReadonlyArray<AvailabilitySlot>;
}

export type PricingRuleScope = "global" | "court_type" | "court";

/**
 * Regla de precio. Columnas de `pricing_rules` (spec 4.3).
 *
 * `priceCents` es siempre IVA INCLUIDO (OQ-6): en Espana el precio al consumidor
 * es el final, y la app no hace factura fiscal, asi que la UI no desglosa nada.
 * Nunca `float` para dinero, nunca en euros: siempre centimos enteros.
 */
export interface PricingRule {
  readonly id: string;
  /** Visible en el panel del gestor. "Tarifa punta 18-21h". */
  readonly name: string;
  readonly scope: PricingRuleScope;
  /** Requerido si scope = 'court_type'. */
  readonly courtType: CourtType | null;
  /** Requerido si scope = 'court'. */
  readonly courtId: string | null;
  /** 0 domingo a 6 sabado. Vacio = todos. */
  readonly dayOfWeek: readonly number[];
  /** Hora LOCAL del club, `HH:mm`. */
  readonly startTime: string;
  readonly endTime: string;
  /** La regla define la duracion del slot. Default 90, sin selector en la UI. */
  readonly durationMin: number;
  readonly priceCents: number;
  /** Si es true, el precio se multiplica por el numero de jugadores. */
  readonly playerMultiplier: boolean;
  /** Desempate explicito: mayor numero gana. */
  readonly priority: number;
  readonly validFrom: string | null;
  readonly validTo: string | null;
  readonly isActive: boolean;
}

/**
 * Estados de `bookings.status` (spec 4.4). SIETE, no cinco: en T0 deje fuera
 * `no_show` y `expired`, que son los que distinguen "el socio no vino" de "el hold
 * caduco" y de "se cancelo". Sin ellos no se puede cerrar un slot por inasistencia
 * ni distinguirlo de un hold caducado.
 */
export type BookingStatus =
  | "held"
  | "pending_payment"
  | "confirmed"
  | "cancelled"
  | "completed"
  | "no_show"
  | "expired";

/**
 * Estados de `bookings.payment_status`. El comentario de la spec lista
 * 'unpaid' | 'paid' | 'refunded', que son los tres que usa el flujo del MVP.
 *
 * OJO: la tabla tiene `amount_refunded_cents` y `refund_percent_applied`, que solo
 * tienen sentido con devoluciones PARCIALES, y el tramo de 12h devuelve el 50%. Con
 * estos tres estados, un reembolso parcial se representa como 'refunded', que es
 * mentira. Falta un estado. No lo invento aqui: se decide antes de T14b, que es
 * donde se cablea el reembolso. Ver `findings.md`.
 */
export type PaymentStatus = "unpaid" | "paid" | "refunded";

/** Reserva. Columnas de `bookings` (spec 4.4). */
export interface Booking {
  readonly id: string;
  readonly courtId: string;
  /** Titular de la reserva. Clave foranea por `id`, nunca por email. */
  readonly userId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly status: BookingStatus;
  /** Obligatorio si status = 'held'. 3 minutos por la spec. */
  readonly holdExpiresAt: string | null;
  /** SNAPSHOT. Nunca recalcular: el club puede cambiar la tarifa despues. */
  readonly priceCents: number;
  /** Que regla se aplico, para auditar el importe. */
  /** Snapshot de `PriceQuote.breakdown`. La columna es `jsonb` pero su forma es esta. */
  readonly priceBreakdown: readonly PriceLine[];
  readonly currency: string;
  readonly numPlayers: number;
  readonly playerName: string;
  /** Calculado en SERVIDOR a partir de la edad (OQ-8), nunca aceptado del cliente. */
  readonly isMinor: boolean;
  /** Si isMinor = true, los cuatro son obligatorios. Sin datos de salud. */
  readonly guardianName: string | null;
  readonly guardianPhone: string | null;
  readonly guardianConsentAt: string | null;
  /** Libre. Sin datos sensibles. */
  readonly notes: string | null;
  readonly stripePaymentIntentId: string | null;
  readonly stripeChargeId: string | null;
  readonly stripeTransferId: string | null;
  /** Siempre 0 al lanzamiento (OQ-13). Vive en bookings, no en tenants. */
  readonly stripeApplicationFeeCents: number;
  readonly paymentStatus: PaymentStatus;
  readonly amountRefundedCents: number;
  /** Snapshot del tramo aplicado, para no recalcular contra una politica cambiada. */
  readonly refundTierHoursBefore: number | null;
  readonly refundPercentApplied: number | null;
  /** Partido abierto al que pertenece, si aplica (OQ-3). */
  readonly openMatchId: string | null;
}

/**
 * Fecha y hora LOCALES del club, `YYYY-MM-DDTHH:mm`. Sin zona.
 *
 * POR QUE ES UN TIPO PROPIO Y NO UN `string`
 * `string` admitiria `"2026-10-01 10:00"` y `"2026-10-01T10:00:00Z"`, y son la misma
 * reserva con dos horas distintas: la segunda trae UTC y la primera no trae nada. Un
 * error de zona no se ve comparando strings, se ve en el trimestre, cuando el club
 * se ve en el trimestre, cuando el club se queja de que el primer partido del dia
 * es a las 11 en vez de a las 10.
 *
 * Un `Date` tampoco vale: al perder el offset original pasa a depender de la zona
 */
export type LocalDateTime = string;

/** Una linea del desglose del precio. Lo que ve el socio en la confirmacion. */
export interface PriceLine {
  readonly label: string;
  readonly cents: number;
}

/**
 * Entrada del motor de precios. Tal cual la define la seccion 10 de la spec.
 *
 * `startsAt` es hora LOCAL, no UTC: las reglas de precio se aplican por hora de club
 * ("de 18:00 a 21:00 se cobra mas"), asi que aplicar la zona equivocada desplaza
 * todos los tramos al borde del dia.
 */
export interface PricingInput {
  readonly court: Pick<Court, "id" | "courtType" | "basePriceCents">;
  readonly rules: readonly PricingRule[];
  readonly startsAt: LocalDateTime;
  readonly durationMin: number;
  readonly numPlayers: number;
}

/**
 * Resultado de resolver el precio. Tal cual la define la seccion 10 de la spec.
 *
 * `breakdown` NO es decorativo: se guarda en `bookings.price_breakdown` y es lo que
 * permite explicar un importe seis meses despues ("me cobraste 27 euros") sin volver
 * a ejecutar el motor, que para entonces ya habria cambiado.
 *
 * OJO, y es una distincion real: aqui el campo es `totalCents`, y en `Booking` es
 * `priceCents`. No es un descuido al escribirlo: `PriceQuote` es el contrato del
 * MOTOR (spec 10) y `Booking.priceCents` es el SNAPSHOT de la COLUMNA
 * `bookings.price_cents` (spec 4.4). Son dos capas. Al mapear la cita a fila, el
 * total de la cita pasa a ser el precio de la reserva.
 */
export interface PriceQuote {
  readonly totalCents: number;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly breakdown: readonly PriceLine[];
}

/** Lo que devuelve el motor de reembolso (T8). */
export interface RefundQuote {
  readonly refundCents: number;
  /** Tramo aplicado, o null si la politica no cubria el caso. */
  readonly tierHoursBefore: number | null;
  /** Porcentaje aplicado, o null si no aplicaba ningun tramo. */
  readonly percentApplied: number | null;
  /** Etiqueta del tramo aplicado, para mostrarla al socio. */
  readonly label: string | null;
}
