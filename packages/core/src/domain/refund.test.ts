import { describe, expect, it } from "vitest";

import { TRAMOS_POR_DEFECTO, computeRefund } from "./refund.js";
import type { CancellationPolicy } from "./types.js";

/**
 * T8: `computeRefund` contra la tabla de casos de la spec (secciones 4.1, 5.2, 7.6).
 *
 * POR QUE LOS NUMEROS NO SALEN DE LA FUNCION
 * Igual que en `color.test.ts`: si los asserts se copiaran de la salida de la funcion,
 * el test compararia la funcion consigo misma y pasaria aunque la formula estuviese
 * mal. Los importes de aqui salen de la tabla de la spec, escrita a mano.
 *
 * LOS LIMITES EXACTOS SON PARTE DEL CONTRATO
 * "24h exactas -> 100%" y "12h exactas -> 50%" estan en la spec a proposito: el limite
 * del tramo es `>=` (inclusivo) y no `>` (exclusivo). Con `>`, cancelar EXACTAMENTE a
 * las 24h caeria en el tramo del 50% y el socio perderia media reserva por un minuto
 * de diferencia que nadie percibe.
 *
 * LA POLITICA POR DEFECTO
 * Son los 3 tramos del seed y de types.ts: 24h/100%, 12h/50%, 0h/0%. El test
 * `default y el seed no se desincronizan` compara contra el seed a mano: si alguien
 * toca uno de los dos sin el otro, este bloque falla.
 */

const DEFAULT: CancellationPolicy = {
  tiers: TRAMOS_POR_DEFECTO,
  policyText: "politica de prueba",
  noticeText: "aviso de prueba",
};

/** Politica custom para probar que el motor no esta casado con el default. */
function politica(
  cambios: Partial<{ tiers: CancellationPolicy["tiers"] }> = {},
): CancellationPolicy {
  return {
    ...DEFAULT,
    tiers: cambios.tiers ?? DEFAULT.tiers,
  };
}

describe("computeRefund: la tabla de la spec, con la politica por defecto", () => {
  it("25h antes -> 100%", () => {
    const quote = computeRefund({ priceCents: 2500, hoursBefore: 25, policy: DEFAULT });
    expect(quote.refundCents).toBe(2500);
    expect(quote.percentApplied).toBe(100);
    expect(quote.tierHoursBefore).toBe(24);
  });

  it("24h EXACTAS -> 100%, el limite es inclusivo", () => {
    // Con `>` en vez de `>=`, cancelar a las 24h exactas caeria en el tramo del 50%.
    // El socio perderia media reserva por un minuto de diferencia.
    const quote = computeRefund({ priceCents: 2500, hoursBefore: 24, policy: DEFAULT });
    expect(quote.refundCents).toBe(2500);
    expect(quote.percentApplied).toBe(100);
  });

  it("20h -> 50%", () => {
    const quote = computeRefund({ priceCents: 2500, hoursBefore: 20, policy: DEFAULT });
    expect(quote.refundCents).toBe(1250);
    expect(quote.percentApplied).toBe(50);
    expect(quote.tierHoursBefore).toBe(12);
  });

  it("12h EXACTAS -> 50%, el limite es inclusivo", () => {
    const quote = computeRefund({ priceCents: 2500, hoursBefore: 12, policy: DEFAULT });
    expect(quote.refundCents).toBe(1250);
    expect(quote.percentApplied).toBe(50);
  });

  it("5h -> 0%, cubre el tramo de 0 y no un fallback", () => {
    const quote = computeRefund({ priceCents: 2500, hoursBefore: 5, policy: DEFAULT });
    expect(quote.refundCents).toBe(0);
    expect(quote.percentApplied).toBe(0);
    // NO null: el tramo de 0% se APLICO, y el snapshot del booking tiene que
    // distinguir "tramo del 0%" de "ningun tramo aplicado".
    expect(quote.tierHoursBefore).toBe(0);
    expect(quote.label).toBe("Con menos de 12h no hay devolucion");
  });

  it("menos de 12h sin tramo de 0 en la politica -> null, no 0%", () => {
    // Politica custom SIN el tramo de 0: a las 5h ningun tramo cubre. Devuelve null
    // y no 0% a proposito: "no se aplico ningun tramo" es distinto de "el tramo del
    // 0% se aplico", y el snapshot del booking tiene que distinguirlo.
    const quote = computeRefund({
      priceCents: 2500,
      hoursBefore: 5,
      policy: politica({ tiers: DEFAULT.tiers.slice(0, 2) }),
    });
    expect(quote.refundCents).toBe(0);
    expect(quote.tierHoursBefore).toBeNull();
    expect(quote.percentApplied).toBeNull();
    expect(quote.label).toBeNull();
  });
});

describe("computeRefund: la ordenacion de los tramos", () => {
  it("los tramos llegan desordenados y el motor los ordena", () => {
    // La spec dice "ordena por hours_before descendente". El jsonb de la base no
    // garantiza orden: si el motor asumiera el orden de llegada, una politica
    // guardada al reves aplicaria el tramo del 0% a TODO y nadie cobraria nada.
    const quote = computeRefund({
      priceCents: 2500,
      hoursBefore: 30,
      policy: politica({
        tiers: [
          { hoursBefore: 0, refundPercent: 0, label: "cero" },
          { hoursBefore: 12, refundPercent: 50, label: "medio" },
          { hoursBefore: 24, refundPercent: 100, label: "todo" },
        ],
      }),
    });
    expect(quote.percentApplied).toBe(100);
  });

  it("no muta el array de tramos que le pasan", () => {
    // El motor es puro: ordenar el array de entrada mutaria el estado del que llama.
    // Este test falla si la ordenacion se hace a pelo sobre `policy.tiers`.
    const tiers = [
      { hoursBefore: 0, refundPercent: 0, label: "cero" },
      { hoursBefore: 24, refundPercent: 100, label: "todo" },
    ];
    const antes = [...tiers];
    computeRefund({ priceCents: 2500, hoursBefore: 30, policy: politica({ tiers }) });
    expect(tiers).toEqual(antes);
  });
});

describe("computeRefund: politica custom, no casada con el default", () => {
  it("un club con otros tramos obtiene el tramo de SU politica", () => {
    const quote = computeRefund({
      priceCents: 2500,
      hoursBefore: 30,
      policy: politica({
        tiers: [
          { hoursBefore: 48, refundPercent: 100, label: "48h" },
          { hoursBefore: 24, refundPercent: 50, label: "24h" },
        ],
      }),
    });
    // 30 >= 24 -> 50%. El tramo de 48 no cubre (30 < 48).
    expect(quote.percentApplied).toBe(50);
    expect(quote.tierHoursBefore).toBe(24);
    expect(quote.label).toBe("24h");
  });
});

describe("computeRefund: el importe, en centimos", () => {
  it("redondeo half-up: el 50% de 1999 centimos es 1000, no 999", () => {
    // 1999 * 50 / 100 = 999.5. Quedarse con 999 o subir a 1000 es una decision que
    // hay que tomar EN UN SITIO, no en cada llamada. Half-up es el redondeo que
    // espera el consumidor: 999.5 se redondea hacia arriba.
    const quote = computeRefund({ priceCents: 1999, hoursBefore: 20, policy: DEFAULT });
    expect(quote.refundCents).toBe(1000);
  });

  it("el 0% devuelve 0 centimos sin importar el precio", () => {
    const quote = computeRefund({ priceCents: 999999, hoursBefore: 2, policy: DEFAULT });
    expect(quote.refundCents).toBe(0);
  });
});

describe("computeRefund: fallos ruidosos, como en resolvePrice", () => {
  it("un precio negativo no es un descuento", () => {
    expect(() =>
      computeRefund({ priceCents: -100, hoursBefore: 25, policy: DEFAULT }),
    ).toThrow(/importe/i);
  });

  it("un precio NaN se propaga en silencio hasta el importe, y aqui se para", () => {
    // `NaN < 0` es false, asi que un guard de solo el signo dejaria pasar un NaN
    // hasta `Math.round(NaN * x)` = NaN: un reembolso de NaN centimos en el booking.
    expect(() =>
      computeRefund({ priceCents: Number.NaN, hoursBefore: 25, policy: DEFAULT }),
    ).toThrow(/importe/i);
  });

  it("unas horas NaN caerian en el tramo de cero sin que nadie lo note, y aqui se paran", () => {
    // `NaN >= 0` es false: un NaN en `hoursBefore` saltaria TODOS los tramos y
    // devolveria null (reembolso a cero) por un bug de fecha y no por la politica.
    expect(() =>
      computeRefund({ priceCents: 2500, hoursBefore: Number.NaN, policy: DEFAULT }),
    ).toThrow(/finito/i);
  });
});

describe("computeRefund: el default y el seed no se desincronizan", () => {
  it("los 3 tramos por defecto son 24h/100%, 12h/50%, 0h/0%", () => {
    // La spec (seccion 4.1) y el seed definen los 3 tramos con estos valores y estos
    // labels. Si alguien cambia uno de los dos sin el otro, este test falla: el motor
    // es la segunda mitad de ese contrato.
    expect(TRAMOS_POR_DEFECTO).toEqual([
      { hoursBefore: 24, refundPercent: 100, label: "Cancelacion gratuita hasta 24h antes" },
      { hoursBefore: 12, refundPercent: 50, label: "Entre 24h y 12h antes se devuelve el 50%" },
      { hoursBefore: 0, refundPercent: 0, label: "Con menos de 12h no hay devolucion" },
    ]);
  });

  it("un tenant sin politica definida usa los 3 tramos por defecto, y cumplen la tabla", () => {
    // El criterio de la spec: sin politica, los 3 tramos. El mismo importe que la
    // tabla de arriba, porque TRAMOS_POR_DEFECTO ES la politica del default.
    for (const [hours, cents] of [
      [25, 2500],
      [20, 1250],
      [5, 0],
    ] as const) {
      const quote = computeRefund({ priceCents: 2500, hoursBefore: hours, policy: DEFAULT });
      expect(quote.refundCents).toBe(cents);
    }
  });
});

describe("el default del motor y el de la seed dicen lo mismo", () => {
  /**
   * Este describe existe por una mentira en los comentarios: refund.ts decia que "el
   * test que fija el default garantiza que el seed y el motor no se desincronizan",
   * pero ese test solo fija los MISMO literales que la constante, no compara las dos
   * constantes entre si. La comparacion de verdad es esta: `DEFAULT_REFUND_TIERS`
   * vive en validation.ts (va a la seed y al panel), `TRAMOS_POR_DEFECTO` vive en
   * refund.ts (lo usa el motor cuando no hay politica). Si se tocan por separado, la
   * pantalla del socio le dice que le devuelven un 50% por una politica que el motor
   * interpreta con otro tramo. Que se lean igual de memoria y con los mismos valores
   * es el contrato.
   */
  it("los tramos son los mismos en los dos sitios", async () => {
    const { DEFAULT_REFUND_TIERS } = await import("./validation.js");
    expect(DEFAULT_REFUND_TIERS).toEqual(TRAMOS_POR_DEFECTO);
  });
});
