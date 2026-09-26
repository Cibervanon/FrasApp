/**
 * Validadores puros del dominio. Sin Zod, sin `throw`, sin dependencias.
 *
 * POR QUE NO ZOD AQUI Y SI EN `config-schema`
 * `config-schema` valida lo que ENTRA de la base y de la API, y ahi Zod es lo
 * correcto. `core` es un modelo de dominio, no un borde: meter Zod aqui
 * arrastraria un validador de runtime a la capa que Checkpoint 2 exige que sea pura
 * y ejecutable en 100 ms sin cargar nada.
 *
 * POR QUE DEVUELVEN RESULT Y NO LANZAN
 * Un `throw` obliga al llamante a acordarse del `try`, y un `try` olvidado se
 * convierte en "el usuario ve un 500". Devolviendo un resultado, el compilador
 * obliga a mirar `ok` antes de usar el valor. En un gestor donde el texto de error
 * se le muestra al dueno del club, poder dar un mensaje concreto importa mas que
 * la brevedad del codigo.
 *
 * Son funciones puras: mismos datos de entrada, mismo resultado. Ni `Date.now()`,
 * ni `Math.random()`, ni lectura de la base.
 */

import type { CancellationPolicy, RefundTier } from "./types.js";

/** Un problema concreto, con el indice del tramo al que se refiere. */
export interface PolicyProblem {
  /** Tramo donde esta el problema, o -1 si el problema es la lista entera. */
  readonly tierIndex: number;
  /** Clave corta y estable, para tests y para traducir. No es el texto al usuario. */
  readonly code: PolicyProblemCode;
  /** Explicacion para quien depura. El texto al gestor sale de otro sitio. */
  readonly detail: string;
}

export type PolicyProblemCode =
  | "no_tiers"
  | "not_descending"
  | "duplicate_tier"
  | "negative_hours"
  | "percent_out_of_range"
  | "percent_not_integer"
  | "empty_label";

export type ValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problems: readonly PolicyProblem[] };

/**
 * Valida los tramos de la politica de cancelacion.
 *
 * QUE COMPRUEBA Y POR QUE CADA COSA IMPORTA
 *
 * - Al menos un tramo. Con cero tramos, el motor de T8 no tiene nada que aplicar y
 *   tendria que inventar un porcentaje, que es exactamente el importe fijo en
 *   codigo que la spec prohibe.
 *
 * - Ordenados por `hoursBefore` ESTRICTAMENTE descendente. El motor aplica "el
 *   primero que cumplas", asi que sin orden ese "primero" no existe y el resultado
 *   depende de como vinieran los datos. El orden no es cosmetico: es la
 *   precondicion del algoritmo.
 *
 * - Sin `hoursBefore` repetidos, que es un solape: dos tramos de 24h se pisan y el
 *   que gane es el orden de llegada de los datos.
 *
 * - `refundPercent` entero entre 0 y 100. Es dinero: un 12.5% no se puede
 *   representar en centimos sin redondear, y el redondeo se decide en un sitio
 *   distinto al que calcula la politica.
 *
 * - `label` no vacio. Es el texto que lee el socio y lo escribe el gestor. Si
 *   puede ir vacio, la app tiene que hardcodear el copy y la regla 1 lo prohibe.
 */
export function validateCancellationPolicy(
  policy: CancellationPolicy,
): ValidationResult<CancellationPolicy> {
  const problems: PolicyProblem[] = [];
  const { tiers } = policy;

  if (tiers.length === 0) {
    problems.push({
      tierIndex: -1,
      code: "no_tiers",
      detail: "La politica no tiene tramos. El motor de reembolso no tendria nada que aplicar.",
    });
    return { ok: false, problems };
  }

  tiers.forEach((tier, index) => {
    if (!Number.isInteger(tier.hoursBefore) || tier.hoursBefore < 0) {
      problems.push({
        tierIndex: index,
        code: "negative_hours",
        detail: `hoursBefore debe ser un entero >= 0. Es ${String(tier.hoursBefore)}.`,
      });
    }

    if (!Number.isInteger(tier.refundPercent)) {
      problems.push({
        tierIndex: index,
        code: "percent_not_integer",
        detail: `refundPercent debe ser un entero. Es ${String(tier.refundPercent)}.`,
      });
    } else if (tier.refundPercent < 0 || tier.refundPercent > 100) {
      problems.push({
        tierIndex: index,
        code: "percent_out_of_range",
        detail: `refundPercent debe estar entre 0 y 100. Es ${tier.refundPercent}.`,
      });
    }

    if (tier.label.trim() === "") {
      problems.push({
        tierIndex: index,
        code: "empty_label",
        detail: "El texto del tramo no puede estar vacio: es lo que lee el socio.",
      });
    }
  });

  // El orden y los solapes se comprueban sobre la lista ORIGINAL, no sobre una
  // copia ordenada. Ordenar antes de comprobar haria que la prueba pasase siempre:
  // "ordenado" seria cierto por construccion y no estariamos midiendo nada.
  for (let index = 1; index < tiers.length; index += 1) {
    const previous = tiers[index - 1];
    const current = tiers[index];
    if (previous === undefined || current === undefined) continue;

    if (current.hoursBefore === previous.hoursBefore) {
      problems.push({
        tierIndex: index,
        code: "duplicate_tier",
        detail: `Dos tramos con hoursBefore = ${current.hoursBefore}. Se solapan: cual aplica dependeria del orden de los datos.`,
      });
    } else if (current.hoursBefore > previous.hoursBefore) {
      problems.push({
        tierIndex: index,
        code: "not_descending",
        detail: `Los tramos deben ir de mas a menos horas. El tramo ${index} tiene ${current.hoursBefore}h y el anterior ${previous.hoursBefore}h.`,
      });
    }
  }

  if (problems.length > 0) {
    return { ok: false, problems };
  }
  return { ok: true, value: policy };
}

/** Atajo: `true` si la politica es valida. Para cuando solo boolean sirve. */
export function isValidCancellationPolicy(policy: CancellationPolicy): boolean {
  return validateCancellationPolicy(policy).ok;
}

/**
 * Tramos por defecto que sugiere la spec (OQ-5): 24h/100%, 12h/50%, 0h/0%.
 *
 * Van a la seed y al panel del gestor como punto de partida, editables. NO son una
 * constante de la que dependa el motor: `computeRefund` (T8) recibe los tramos como
 * argumento, y esto es solo lo que se crea la primera vez. Asi el club puede
 * cambiarlo sin que el motor cambie, que es el punto de OQ-5.
 */
export const DEFAULT_REFUND_TIERS: readonly RefundTier[] = [
  {
    hoursBefore: 24,
    refundPercent: 100,
    label: "Cancelacion gratuita hasta 24h antes",
  },
  {
    hoursBefore: 12,
    refundPercent: 50,
    label: "Entre 24h y 12h antes se devuelve el 50%",
  },
  {
    hoursBefore: 0,
    refundPercent: 0,
    label: "Con menos de 12h no hay devolucion",
  },
];
