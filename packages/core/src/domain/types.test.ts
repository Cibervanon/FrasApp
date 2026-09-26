import { describe, expect, it } from "vitest";

import type { CancellationPolicy, RefundTier } from "./types.js";

/**
 * Smoke test de T0. No prueba logica de negocio: comprueba que el paquete se
 * compila, se importa y que los tipos describen lo que dicen.
 *
 * La logica real (resolvePrice en T7, computeRefund en T8) no existe todavia.
 */
describe("core: tipos del dominio", () => {
  it("describe una politica de cancelacion ordenada y sin solapes", () => {
    const tiers: readonly RefundTier[] = [
      { minHoursBefore: 12, percent: 50 },
      { minHoursBefore: 0, percent: 0 },
      { minHoursBefore: 24, percent: 100 },
    ];

    const ordered = [...tiers].sort((a, b) => b.minHoursBefore - a.minHoursBefore);
    const policy: CancellationPolicy = { tiers: ordered };

    expect(policy.tiers.map((t) => t.percent)).toEqual([100, 50, 0]);
  });

  it("no deja que el porcentaje se salga del rango", () => {
    const tier: RefundTier = { minHoursBefore: 24, percent: 100 };
    expect(tier.percent).toBeGreaterThanOrEqual(0);
    expect(tier.percent).toBeLessThanOrEqual(100);
  });
});
