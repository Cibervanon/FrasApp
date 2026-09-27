/**
 * Motor de reembolso, funcion PURA. T8 de la spec (secciones 4.1, 5.2, 7.6).
 *
 * POR QUE ES PURA Y NO LEE `tenant_content`
 * El socio cancela una reserva y el importe que se le devuelve no puede depender de
 * cuando se ejecuta el codigo ni de si el club esta editando la politica ese mismo
 * segundo. Si el motor leyera la base, probarlo exigiria levantar Postgres, y un fallo
 * de reembolso seria un ticket de soporte en vez de un test rojo. Recibe los tramos
 * como argumento (ya validados por `validateCancellationPolicy` de T2) y los aplica.
 * Quien trae los tramos es el endpoint de cancelacion (T14b), que los lee de
 * `tenant_content['cancellation_policy']`.
 *
 * COMO APLICA LOS TRAMOS
 * La spec dice "ordena por `hours_before` descendente, aplica el primero que cumplas".
 * Con los 3 tramos por defecto (24h/100%, 12h/50%, 0h/0%):
 *   - 25h antes  -> 100% (cubre el tramo de 24)
 *   - 24h EXACTAS -> 100% (el limite es inclusivo: `>=`)
 *   - 20h        -> 50%
 *   - 12h EXACTAS -> 50%
 *   - 5h         -> 0% (cubre el tramo de 0)
 * Los limites exactos son parte de la tabla de casos, no un accidente del orden.
 *
 * EL SNAPSHOT (por eso existe `RefundQuote`)
 * Devuelve `tierHoursBefore` y `percentApplied` para que el endpoint los guarde en el
 * booking: si el club cambia la politica despues, el socio sigue viendo QUE tramo se le
 * aplico. Recalcular contra la politica actual seria contestar una pregunta distinta.
 */

import type { CancellationPolicy, RefundQuote } from "./types.js";

/**
 * Los 3 tramos por defecto del club. Los mismos del seed (`supabase/seed.sql`) y de la
 * documentacion de `CancellationPolicy` en types.ts. El club los puede editar desde el
 * panel; son el VALOR por defecto, no un fijo.
 *
 * Los labels son los que ve el socio al cancelar. Estan aqui Y en el seed por la misma
 * razon que el motor es puro: un tenant sin politica definida en la base usa estos, y
 * el test que fija el default es el que garantiza que el seed y el motor no se
 * desincronizan.
 */
export const TRAMOS_POR_DEFECTO: CancellationPolicy["tiers"] = [
  { hoursBefore: 24, refundPercent: 100, label: "Cancelacion gratuita hasta 24h antes" },
  { hoursBefore: 12, refundPercent: 50, label: "Entre 24h y 12h antes se devuelve el 50%" },
  { hoursBefore: 0, refundPercent: 0, label: "Con menos de 12h no hay devolucion" },
];

/**
 * Calcula el reembolso de una reserva cancelada.
 *
 * DEVUELVE `RefundQuote`, que es lo que firma types.ts: `refundCents` para el importe,
 * `tierHoursBefore` y `percentApplied` para el snapshot, y `label` para la pantalla.
 * `null` en el tramo SOLO cuando la politica no cubria el caso (tiers vacios, o
 * `hoursBefore` negativo por una reserva ya empezada, que el endpoint de T14b debe
 * rechazar antes de llegar aqui con un 422).
 *
 * FALLOS RUIDOSOS, igual que en `resolvePrice`:
 *   - `priceCents` negativo o no finito: una reserva que paga el club no es un
 *     descuento, y un `NaN` que llegue hasta el importe se propaga en silencio.
 *   - `hoursBefore` no finito: `NaN >= 0` es `false`, asi que un `NaN` caeria en el
 *     fallback `null` y el reembolso saldria a cero SIN que nadie se enterara.
 */
export function computeRefund(input: {
  priceCents: number;
  hoursBefore: number;
  policy: CancellationPolicy;
}): RefundQuote {
  if (!Number.isFinite(input.priceCents) || input.priceCents < 0) {
    throw new Error(
      `El precio de la reserva '${input.priceCents}' no es un importe valido: tiene que ` +
        `ser un numero de centimos finito y no negativo. Un precio negativo no es un ` +
        `descuento, es una reserva que paga el club, y un NaN se propaga hasta el ` +
        `importe sin que nadie lo note.`,
    );
  }
  if (!Number.isFinite(input.hoursBefore)) {
    throw new Error(
      `Las horas de antelacion '${input.hoursBefore}' no son un numero finito. ` +
        `Un NaN se compara como falso contra todo y caeria en el tramo de cero ` +
        `porcentaje sin que nadie se enterara: un reembolso a 0 por un bug de fecha ` +
        `y no por la politica del club.`,
    );
  }

  // COPIA antes de ordenar, y a proposito: el motor es puro, y ordenar el array que
  // le pasan mutaria el estado del que llama. Los tramos de la base llegan en el orden
  // del jsonb, que no es ningun contrato, asi que el orden no se puede asumir: se
  // ordena SIEMPRE, descendente por `hoursBefore`, que es lo que hace que "el primero
  // que cumplas" exista.
  const ordenados = [...input.policy.tiers].sort(
    (a, b) => b.hoursBefore - a.hoursBefore,
  );

  for (const tier of ordenados) {
    if (input.hoursBefore >= tier.hoursBefore) {
      return {
        // Redondeo half-up al centimo: el 50% de 1999 centimos es 999.5, y quedarse
        // con 999 o subir a 1000 es una decision que hay que tomar en un sitio y no
        // en cada llamada. Half-up es el redondeo que espera el consumidor.
        refundCents: Math.round((input.priceCents * tier.refundPercent) / 100),
        tierHoursBefore: tier.hoursBefore,
        percentApplied: tier.refundPercent,
        label: tier.label,
      };
    }
  }

  // Ningun tramo cubre el caso: politica sin tramos, o `hoursBefore` negativo (la
  // reserva ya empezo; el endpoint tiene que rechazarla con 422 ANTES de llamar aqui).
  // Devuelve null y no 0% a proposito: "no se aplico ningun tramo" y "se aplico el
  // tramo del 0%" son cosas distintas, y el snapshot del booking tiene que
  // distinguirlas para que la pantalla del socio explique por que no vio dinero.
  return { refundCents: 0, tierHoursBefore: null, percentApplied: null, label: null };
}
