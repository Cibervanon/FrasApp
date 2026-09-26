/**
 * Tests de los validadores de dominio. Puros, sin reloj y sin base de datos.
 *
 * Cada regla tiene su caso NEGATIVO explicito. Un validador al que solo se le
 * pasan datos buenos no se sabe si filtra: puede que devuelva `ok: true` siempre y
 * todos los tests verdes sean mentira. Aqui cada comprobacion se rompe a proposito
 * y se espera que el validador lo detecte.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_REFUND_TIERS,
  isValidCancellationPolicy,
  validateCancellationPolicy,
} from "./validation.js";
import type { CancellationPolicy, RefundTier } from "./types.js";

function policy(tiers: readonly RefundTier[]): CancellationPolicy {
  return {
    tiers,
    policyText: "texto de prueba",
    noticeText: "aviso de prueba",
  };
}

/** Los 3 tramos por defecto de la spec (OQ-5), que ademas son un caso valido. */
const VALID = DEFAULT_REFUND_TIERS;

/** Codigos de problema presentes en un resultado, para assertar en corto. */
function codes(result: ReturnType<typeof validateCancellationPolicy>): string[] {
  return result.ok ? [] : result.problems.map((problem) => problem.code);
}

describe("validateCancellationPolicy: lo que debe pasar", () => {
  it("acepta los 3 tramos por defecto de la spec", () => {
    const result = validateCancellationPolicy(policy(VALID));
    expect(result.ok).toBe(true);
  });

  it("acepta un unico tramo", () => {
    const result = validateCancellationPolicy(
      policy([{ hoursBefore: 0, refundPercent: 0, label: "Sin devolucion" }]),
    );
    expect(result.ok).toBe(true);
  });

  it("acepta el 0% y el 100%, los extremos del rango", () => {
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 48, refundPercent: 100, label: "Gratis" },
        { hoursBefore: 0, refundPercent: 0, label: "Nada" },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("acepta tramos con horas repetidas siempre que bajen, como 72/48/24/0", () => {
    // 24 aparece en el par (24, 12) y en (12, 0)? No: los valores son distintos.
    // Lo que se prueba es que dos tramos a 24h CONSECUTIVOS serian solape, y que
    // una secuencia larga bien ordenada es valida.
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 72, refundPercent: 100, label: "a" },
        { hoursBefore: 48, refundPercent: 100, label: "b" },
        { hoursBefore: 24, refundPercent: 50, label: "c" },
        { hoursBefore: 0, refundPercent: 0, label: "d" },
      ]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("validateCancellationPolicy: lo que debe fallar", () => {
  it("rechaza una politica sin tramos", () => {
    const result = validateCancellationPolicy(policy([]));
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("no_tiers");
  });

  it("rechaza tramos ordenados de menos a mas", () => {
    // Este es el caso que importa: el motor aplica "el primero que cumplas", asi que
    // en orden ascendente aplicaria el de 0h SIEMPRE y devolveria 0% a todo el
    // mundo. Un error silencioso de dinero.
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 0, refundPercent: 0, label: "c" },
        { hoursBefore: 12, refundPercent: 50, label: "b" },
        { hoursBefore: 24, refundPercent: 100, label: "a" },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("not_descending");
  });

  it("rechaza dos tramos con las mismas horas: se solapan", () => {
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 24, refundPercent: 100, label: "a" },
        { hoursBefore: 24, refundPercent: 50, label: "b" },
        { hoursBefore: 0, refundPercent: 0, label: "c" },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("duplicate_tier");
  });

  it("rechaza horas negativas", () => {
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: -1, refundPercent: 100, label: "a" },
        { hoursBefore: 0, refundPercent: 0, label: "b" },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("negative_hours");
  });

  it("rechaza horas no enteras", () => {
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 24.5, refundPercent: 100, label: "a" },
        { hoursBefore: 0, refundPercent: 0, label: "b" },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("negative_hours");
  });

  it("rechaza un porcentaje por encima de 100", () => {
    const result = validateCancellationPolicy(
      policy([{ hoursBefore: 24, refundPercent: 150, label: "a" }]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("percent_out_of_range");
  });

  it("rechaza un porcentaje negativo", () => {
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 24, refundPercent: -10, label: "a" },
        { hoursBefore: 0, refundPercent: 0, label: "b" },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("percent_out_of_range");
  });

  it("rechaza un porcentaje decimal", () => {
    // 12.5% no se puede representar en centimos sin redondear, y el redondeo
    // pertenece a otro sitio que no calcula la politica.
    const result = validateCancellationPolicy(
      policy([{ hoursBefore: 24, refundPercent: 12.5, label: "a" }]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("percent_not_integer");
  });

  it("rechaza un texto vacio", () => {
    // El texto lo lee el socio. Si puede ir vacio, la app hardcodea el copy y la
    // regla 1 lo prohibe.
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 24, refundPercent: 100, label: "" },
        { hoursBefore: 0, refundPercent: 0, label: "b" },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("empty_label");
  });

  it("rechaza un texto que solo tiene espacios", () => {
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 24, refundPercent: 100, label: "   " },
        { hoursBefore: 0, refundPercent: 0, label: "b" },
      ]),
    );
    expect(result.ok).toBe(false);
    expect(codes(result)).toContain("empty_label");
  });

  it("acumula varios problemas en vez de parar en el primero", () => {
    // El gestor del club tiene que ver todo lo que esta mal de una vez. Si solo
    // devolviera el primero, tendria que reintentar N veces, y en la mayoria de
 // pantallas habria que corregir cada error.
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: -5, refundPercent: 200, label: "" },
        { hoursBefore: 0, refundPercent: 0, label: "ok" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.problems.length).toBeGreaterThanOrEqual(3);
      expect(result.problems.map((p) => p.tierIndex)).toContain(0);
    }
  });

  it("señala el indice del tramo con problema", () => {
    const result = validateCancellationPolicy(
      policy([
        { hoursBefore: 24, refundPercent: 100, label: "ok" },
        { hoursBefore: 12, refundPercent: 999, label: "malo" },
        { hoursBefore: 0, refundPercent: 0, label: "ok" },
      ]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const percentProblem = result.problems.find(
        (p) => p.code === "percent_out_of_range",
      );
      expect(percentProblem?.tierIndex).toBe(1);
    }
  });
});

describe("el validador no muta la entrada", () => {
  it("no reordena los tramos ni toca sus campos", () => {
    const tiers: RefundTier[] = [
      { hoursBefore: 0, refundPercent: 0, label: "c" },
      { hoursBefore: 24, refundPercent: 100, label: "a" },
    ];
    const copia = structuredClone(tiers);
    validateCancellationPolicy(policy(tiers));
    expect(tiers).toEqual(copia);
    expect(tiers[0]?.hoursBefore).toBe(0);
  });
});

describe("isValidCancellationPolicy", () => {
  it("coincide con el validador completo", () => {
    expect(isValidCancellationPolicy(policy(VALID))).toBe(true);
    expect(isValidCancellationPolicy(policy([]))).toBe(false);
    expect(
      isValidCancellationPolicy(
        policy([
          { hoursBefore: 0, refundPercent: 0, label: "c" },
          { hoursBefore: 24, refundPercent: 100, label: "a" },
        ]),
      ),
    ).toBe(false);
  });
});

describe("DEFAULT_REFUND_TIERS", () => {
  it("el valor por defecto de la seed es una politica valida", () => {
    // Si el default fuera invalido, la seed crearia una politica que el propio
    // validador rechaza, y el club tendria que arreglarla antes de cobrar.
    expect(isValidCancellationPolicy(policy(DEFAULT_REFUND_TIERS))).toBe(true);
  });

  it("son los tres tramos que dice la spec: 24h/100, 12h/50, 0h/0", () => {
    expect(DEFAULT_REFUND_TIERS.map((t) => t.hoursBefore)).toEqual([24, 12, 0]);
    expect(DEFAULT_REFUND_TIERS.map((t) => t.refundPercent)).toEqual([100, 50, 0]);
  });

  it("los tres textos no estan vacios", () => {
    for (const tier of DEFAULT_REFUND_TIERS) {
      expect(tier.label.trim().length).toBeGreaterThan(0);
    }
  });
});
