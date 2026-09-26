import { describe, expect, it } from "vitest";

import { cancellationPolicySchema, tenantConfigSchema } from "./schema.js";

const validBranding = {
  primaryColor: "#1a4d8f",
  accentColor: "#e8a33d",
  logoUrl: null,
  senderName: "Club Padel Norte",
  replyToEmail: "padel@clubnorte.example",
};

describe("config-schema: contrato de tenant", () => {
  it("acepta un tenant valido", () => {
    const result = tenantConfigSchema.safeParse({
      slug: "club-norte",
      name: "Club Padel Norte",
      minPlayerAge: 18,
      branding: validBranding,
      features: ["online_payments", "news"],
      cancellationPolicy: {
        tiers: [
          { minHoursBefore: 24, percent: 100 },
          { minHoursBefore: 12, percent: 50 },
          { minHoursBefore: 0, percent: 0 },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("rechaza un color que no es hex de 6 digitos", () => {
    const result = tenantConfigSchema.safeParse({
      slug: "club-norte",
      name: "Club Padel Norte",
      branding: { ...validBranding, primaryColor: "rojo" },
      features: [],
      cancellationPolicy: { tiers: [{ minHoursBefore: 0, percent: 0 }] },
    });

    expect(result.success).toBe(false);
  });

  it("acepta minPlayerAge fuera del rango 14-21", () => {
    const result = tenantConfigSchema.safeParse({
      slug: "club-norte",
      name: "Club Padel Norte",
      minPlayerAge: 12,
      branding: validBranding,
      features: [],
      cancellationPolicy: { tiers: [{ minHoursBefore: 0, percent: 0 }] },
    });

    expect(result.success).toBe(false);
  });
});

describe("config-schema: politica de cancelacion", () => {
  it("rechaza dos tramos con el mismo minHoursBefore", () => {
    const result = cancellationPolicySchema.safeParse({
      tiers: [
        { minHoursBefore: 24, percent: 100 },
        { minHoursBefore: 24, percent: 50 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rechaza que con menos aviso se devuelva mas", () => {
    const result = cancellationPolicySchema.safeParse({
      tiers: [
        { minHoursBefore: 24, percent: 50 },
        { minHoursBefore: 12, percent: 100 },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("acepta una escalera decreciente, que es lo normal", () => {
    // 24h->100%, 12h->50%, 0h->0%. Menos aviso, menos devolucion: coherente.
    const result = cancellationPolicySchema.safeParse({
      tiers: [
        { minHoursBefore: 24, percent: 100 },
        { minHoursBefore: 12, percent: 50 },
        { minHoursBefore: 0, percent: 0 },
      ],
    });

    expect(result.success).toBe(true);
  });

  it("acepta un tramo del 100% hasta el final", () => {
    const result = cancellationPolicySchema.safeParse({
      tiers: [{ minHoursBefore: 0, percent: 100 }],
    });

    expect(result.success).toBe(true);
  });
});
