import { describe, it, expect } from "vitest";
import { computeRefund, politicasPorDefecto } from "./refund";

describe("computeRefund", () => {
  it("25h antes -> 100%", () => {
    const { percentApplied } = computeRefund(25);
    expect(percentApplied).toBe(100);
  });

  it("24h exactas -> 100%", () => {
    const { percentApplied } = computeRefund(24);
    expect(percentApplied).toBe(100);
  });

  it("20h -> 50%", () => {
    const { percentApplied } = computeRefund(20);
    expect(percentApplied).toBe(50);
  });

  it("12h exactas -> 50%", () => {
    const { percentApplied } = computeRefund(12);
    expect(percentApplied).toBe(50);
  });

  it("5h -> 0%", () => {
    const { percentApplied } = computeRefund(5);
    expect(percentApplied).toBe(0);
  });

  it("horas inferiores a 5 devuelven 0%", () => {
    const { percentApplied } = computeRefund(1);
    expect(percentApplied).toBe(0);
  });

  it("usa la política por defecto cuando no se pasa ninguna", () => {
    const { percentApplied } = computeRefund(8);
    // 8h está entre 12 y 5, la regla es: si hoursBefore >= 12 -> 50, si >=5 -> 0? según spec el mínimo es 5h -> 0.
    // Con la política por defecto, 8 >= 5 así que 0%. Probaremos que usa el array por defecto.
    expect(percentApplied).toBe(0);
  });

  it("politica personalizada overridea la por defecto", () => {
    const customPolicy = [
      { hours_before: 48, percent: 100 },
      { hours_before: 24, percent: 50 },
    ];
    // 30h >= 24 -> 50%, the first tramo (48h) is not reached
    const { percentApplied } = computeRefund(30, customPolicy);
    expect(percentApplied).toBe(50);
  });
});