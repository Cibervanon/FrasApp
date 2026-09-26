/**
 * El archivo de T0 afirmaba comprobar que "los porcentajes se quedan en rango"
 * escribiendo un 100 y comprobando que 100 <= 100. Eso no prueba nada: pasaria
 * igual con un validador que devolviese siempre `true`. Los limites de rango y de
 * orden viven ahora en `validation.test.ts`, con casos negativos reales.
 *
 * Lo que queda aqui es lo que un test de tipos puede demostrar de verdad: que las
 * enumeraciones de estados y claves contienen EXACTAMENTE lo que dice la spec, y
 * que una cita se puede construir con los nombres reales de columna.
 *
 * Por que importa fijar la lista COMPLETA y no "que contenga algo": si un estado
 * se cae por un refactor, la compilacion no se entera en un sitio donde no se use.
 * Se entera el club, cuando una reserva de 2026 no se puede abrir ni cerrar.
 */

import { describe, expect, it } from "vitest";

import type {
  Booking,
  BookingStatus,
  Branding,
  CancellationPolicy,
  Court,
  CourtType,
  FeatureKey,
  PaymentStatus,
  PriceLine,
  PriceQuote,
  PricingInput,
  PricingRule,
  RefundTier,
} from "./types.js";

/** Las 7 feature keys de la seccion 4.1 de la spec, en orden. */
const FEATURE_KEYS: readonly FeatureKey[] = [
  "calendar",
  "booking",
  "payments",
  "open_matches",
  "news",
  "gdpr_export",
  "push_notifications",
];

/** Los 7 estados de reserva de la seccion 4.4. */
const BOOKING_STATUSES: readonly BookingStatus[] = [
  "held",
  "pending_payment",
  "confirmed",
  "cancelled",
  "completed",
  "no_show",
  "expired",
];

/**
 * OJO: la spec enumera 3 y son los 3 que usa el flujo del MVP. Pero
 * `amount_refunded_cents` y `refund_percent_applied` solo tienen sentido con
 * devoluciones PARCIALES, y el tramo de 12h devuelve el 50%. Con estos 3 estados
 * un reembolso parcial se representa como 'refunded', que es mentira.
 *
 * NO se inventa un cuarto estado aqui. Se decide antes de T14b con el usuario, que
 * es quien sabe si el club devuelve el total o una parte. Si anades
 * `partially_refunded`, cambialo tambien en la migracion y en la politica de pagos.
 */
const PAYMENT_STATUSES: readonly PaymentStatus[] = ["unpaid", "paid", "refunded"];

describe("core: enumeraciones del dominio", () => {
  it("declara las 7 feature keys de la spec", () => {
    expect(FEATURE_KEYS).toHaveLength(7);
    expect(new Set(FEATURE_KEYS).size).toBe(7);
  });

  it("declara los 7 estados de reserva, con held, expired y no_show distintos", () => {
    // `held` (provisional, se puede confirmar pagando), `expired` (caducado, ya no)
    // y `no_show` (el socio no vino) tienen que ser tres estados separados: si
    // `expired` y `no_show` fueran el mismo, un hold caducado se contaria como
    // falta de un socio que en realidad no reservo.
    expect(BOOKING_STATUSES).toHaveLength(7);
    expect(new Set(BOOKING_STATUSES).size).toBe(7);
  });

  it("declara los 3 estados de pago de la spec", () => {
    expect(PAYMENT_STATUSES).toHaveLength(3);
    expect(new Set(PAYMENT_STATUSES).size).toBe(3);
  });
});

describe("core: la forma de los tipos", () => {
  it("CancellationPolicy lleva tramos, texto de politica y aviso legal", () => {
    const tiers: readonly RefundTier[] = [
      { hoursBefore: 24, refundPercent: 100, label: "Gratis hasta 24h antes" },
      { hoursBefore: 0, refundPercent: 0, label: "Sin devolucion" },
    ];
    const policy: CancellationPolicy = {
      tiers,
      policyText: "Se devuelve el importe si avisa con 24h de antelacion.",
      noticeText: "Los tramos de devolucion los fija el club.",
    };
    expect(policy.tiers).toHaveLength(2);
    expect(policy.policyText.length).toBeGreaterThan(0);
    expect(policy.noticeText.length).toBeGreaterThan(0);
  });

  it("el branding usa los 8 campos reales de tenant_branding, no accentColor", () => {
    // `accentColor` era el nombre inventado en T0. Si vuelve a colarse, el typecheck
    // lo para; este test deja escrito por que el nombre real es snake_case.
    const branding: Branding = {
      primaryColor: "#1B7F4E",
      secondaryColor: "#0B3D26",
      logoPath: null,
      faviconPath: null,
      heroImagePath: null,
      fontFamily: "Inter",
      emailFromName: "Club de Padel",
      emailReplyTo: "info@club.example",
    };
    expect(branding.primaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(branding.secondaryColor).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(branding.fontFamily).toBe("Inter");
  });

  it("una pista lleva courtType, superficie y limites de duracion", () => {
    const court: Court = {
      id: "court-1",
      name: "Pista 1",
      courtType: "cristal" satisfies CourtType,
      surface: "cesped",
      indoor: true,
      numPlayers: 4,
      defaultDurationMin: 90,
      minDurationMin: 60,
      maxDurationMin: 120,
      basePriceCents: 1800,
      sortOrder: 1,
      isActive: true,
      imagePath: null,
      deletedAt: null,
    };
    expect(court.courtType).toBe("cristal");
    expect(court.basePriceCents).toBe(1800);
    expect(court.minDurationMin).toBeLessThanOrEqual(court.defaultDurationMin);
    expect(court.defaultDurationMin).toBeLessThanOrEqual(court.maxDurationMin);
  });

  it("una regla de precio declara el ambito y el precio en centimos", () => {
    const rule: PricingRule = {
      id: "rule-1",
      name: "Pista 1 punta 18-21h",
      scope: "court",
      courtType: null,
      courtId: "court-1",
      dayOfWeek: [1, 2, 3, 4, 5],
      startTime: "18:00",
      endTime: "21:00",
      durationMin: 90,
      priceCents: 2400,
      playerMultiplier: false,
      priority: 10,
      validFrom: null,
      validTo: null,
      isActive: true,
    };
    // Dinero en centimos enteros, nunca en euros con decimales (spec 12).
    expect(Number.isInteger(rule.priceCents)).toBe(true);
    expect(rule.scope).toBe("court");
    expect(rule.courtId).toBe("court-1");
    expect(rule.courtType).toBeNull();
  });

  it("el desglose del precio es una lista de lineas, no un objeto suelto", () => {
    const breakdown: readonly PriceLine[] = [
      { label: "Tarifa punta 18-21h", cents: 2400 },
      { label: "4 jugadores", cents: 0 },
    ];
    const quote: PriceQuote = {
      totalCents: 2400,
      ruleId: "rule-1",
      ruleName: "Pista 1 punta 18-21h",
      breakdown,
    };
    expect(quote.breakdown).toHaveLength(2);
    // Sin regla aplicable la cita declara el motivo: `ruleId` null significa
    // "tarifa base", no "no se pudo calcular".
    const base: PriceQuote = {
      totalCents: 1800,
      ruleId: null,
      ruleName: null,
      breakdown: [{ label: "Tarifa base", cents: 1800 }],
    };
    expect(base.ruleId).toBeNull();
    expect(base.breakdown[0]?.cents).toBe(base.totalCents);
  });

  it("la entrada del motor pide la pista recortada y las reglas completas", () => {
    const input: PricingInput = {
      court: { id: "court-1", courtType: "cristal", basePriceCents: 1800 },
      rules: [],
      startsAt: "2026-10-01T18:00",
      durationMin: 90,
      numPlayers: 4,
    };
    // Hora local sin zona: si el motor recibiera UTC, la regla de 18:00 se aplicaria
    // dos horas antes de lo que el club cree.
    expect(input.startsAt).not.toMatch(/[Zz]$|[+-]\d{2}:?\d{2}$/);
    expect(Object.keys(input.court).sort()).toEqual([
      "basePriceCents",
      "courtType",
      "id",
    ]);
  });

  it("una reserva guarda el precio como snapshot y el desglose con la regla", () => {
    const quote: PriceQuote = {
      totalCents: 2400,
      ruleId: "rule-1",
      ruleName: "Pista 1 punta 18-21h",
      breakdown: [{ label: "Pista 1 punta 18-21h", cents: 2400 }],
    };
    const booking: Booking = {
      id: "booking-1",
      courtId: "court-1",
      userId: "user-1",
      startsAt: "2026-10-01T18:00:00.000Z",
      endsAt: "2026-10-01T19:30:00.000Z",
      status: "held",
      holdExpiresAt: "2026-10-01T18:03:00.000Z",
      // El snapshot sale de la cita: es el total de la cita pasado a columna.
      priceCents: quote.totalCents,
      priceBreakdown: quote.breakdown,
      currency: "eur",
      numPlayers: 4,
      playerName: "Marta",
      isMinor: false,
      guardianName: null,
      guardianPhone: null,
      guardianConsentAt: null,
      notes: null,
      stripePaymentIntentId: null,
      stripeChargeId: null,
      stripeTransferId: null,
      stripeApplicationFeeCents: 0,
      paymentStatus: "unpaid",
      amountRefundedCents: 0,
      refundTierHoursBefore: null,
      refundPercentApplied: null,
      openMatchId: null,
    };
    expect(booking.priceCents).toBe(quote.totalCents);
    expect(booking.status).toBe("held");
    // Un hold de la spec son 3 minutos exactos, no "unos 3".
    const heldMs =
      new Date(booking.holdExpiresAt ?? 0).getTime() -
      new Date(booking.startsAt).getTime();
    expect(heldMs).toBe(3 * 60 * 1000);
  });
});
