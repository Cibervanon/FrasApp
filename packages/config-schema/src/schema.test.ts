import { describe, expect, it } from "vitest";

import {
  MVP_FEATURE_KEYS,
  cancellationPolicySchema,
  featureKeySchema,
  tenantConfigSchema,
} from "./schema.js";

const validBranding = {
  primary_color: "#1a4d8f",
  secondary_color: "#e8a33d",
  logo_path: null,
  favicon_path: null,
  hero_image_path: null,
  font_family: "Inter",
  email_from_name: "Club Padel Norte",
  email_reply_to: "padel@clubnorte.example",
};

const validPolicy = {
  tiers: [
    {
      hours_before: 24,
      refund_percent: 100,
      label: "Cancelacion gratuita hasta 24h antes",
    },
    {
      hours_before: 12,
      refund_percent: 50,
      label: "Entre 24h y 12h antes se devuelve el 50%",
    },
    { hours_before: 0, refund_percent: 0, label: "Con menos de 12h no hay devolucion" },
  ],
  policy_text: "Texto de la politica",
  notice_text: "Texto del aviso",
};

describe("config-schema: feature_key", () => {
  it("acepta exactamente las 7 features del MVP de la spec", () => {
    // Si la spec anade o quita una feature, este test obliga a actualizar la
    // seed de T1 en el mismo commit. Regla 3: sin excepcion.
    expect([...MVP_FEATURE_KEYS]).toEqual([
      "calendar",
      "booking",
      "payments",
      "open_matches",
      "news",
      "gdpr_export",
      "push_notifications",
    ]);
  });

  it("MVP_FEATURE_KEYS no tiene duplicados", () => {
    expect(new Set(MVP_FEATURE_KEYS).size).toBe(MVP_FEATURE_KEYS.length);
  });

  it("rechaza una feature que no existe en la spec", () => {
    const result = featureKeySchema.safeParse("guest_bookings");
    expect(result.success).toBe(false);
  });

  it("rechaza una feature inventada por el cliente", () => {
    const result = featureKeySchema.safeParse("discount_coupons");
    expect(result.success).toBe(false);
  });
});

describe("config-schema: contrato de tenant", () => {
  it("acepta un tenant valido con la forma de la BD", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      min_player_age: 18,
      branding: validBranding,
      features: ["booking", "payments"],
      content: { cancellation_policy: validPolicy },
    });

    expect(result.success).toBe(true);
  });

  it("aplica los defaults de la spec a min_player_age, currency, timezone y locale", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      branding: validBranding,
      features: [],
      content: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_player_age).toBe(18);
      expect(result.data.currency).toBe("eur");
      expect(result.data.timezone).toBe("Europe/Madrid");
      expect(result.data.locale).toBe("es-ES");
    }
  });

  it("rechaza un color que no es hex de 6 digitos", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      branding: { ...validBranding, primary_color: "rojo" },
      features: [],
      content: {},
    });

    expect(result.success).toBe(false);
  });

  it("rechaza min_player_age fuera del rango 14-21", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      min_player_age: 12,
      branding: validBranding,
      features: [],
      content: {},
    });

    expect(result.success).toBe(false);
  });

  it("rechaza un email_reply_to que no es email", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      branding: { ...validBranding, email_reply_to: "no-es-un-email" },
      features: [],
      content: {},
    });

    expect(result.success).toBe(false);
  });
});

describe("config-schema: politica de cancelacion", () => {
  it("rechaza dos tramos con el mismo hours_before", () => {
    const result = cancellationPolicySchema.safeParse({
      ...validPolicy,
      tiers: [
        { hours_before: 24, refund_percent: 100, label: "a" },
        { hours_before: 24, refund_percent: 50, label: "b" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rechaza que con menos aviso se devuelva mas", () => {
    const result = cancellationPolicySchema.safeParse({
      ...validPolicy,
      tiers: [
        { hours_before: 24, refund_percent: 50, label: "a" },
        { hours_before: 12, refund_percent: 100, label: "b" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("acepta la escalera por defecto de la spec", () => {
    // 24h->100%, 12h->50%, 0h->0%. Menos aviso, menos devolucion: coherente.
    const result = cancellationPolicySchema.safeParse(validPolicy);
    expect(result.success).toBe(true);
  });

  it("exige label en cada tramo, porque lo ve el socio", () => {
    const result = cancellationPolicySchema.safeParse({
      ...validPolicy,
      tiers: [{ hours_before: 0, refund_percent: 0 }],
    });

    expect(result.success).toBe(false);
  });

  it("acepta un tramo del 100% hasta el final", () => {
    const result = cancellationPolicySchema.safeParse({
      ...validPolicy,
      tiers: [{ hours_before: 0, refund_percent: 100, label: "Siempre reembolsable" }],
    });

    expect(result.success).toBe(true);
  });
});
