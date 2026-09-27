/**
 * Motor de reembolso puro. Dado un número de horas antes de la reserva
 * y una política de tramos (horas -> porcentaje), devuelve el tramo aplicado
 * y la hora del inicio del tramo.
 *
 * Si no se pasa política, se usa la por defecto del tenant (los 3 tramos del
 * cancellation_policy de la spec).
 */
export type CancellationPolicyTramo = {
  hours_before: number;
  percent: number;
};

export const politicasPorDefecto: readonly CancellationPolicyTramo[] = [
  { hours_before: 25, percent: 100 },
  { hours_before: 24, percent: 100 },
  { hours_before: 20, percent: 50 },
  { hours_before: 12, percent: 50 },
  { hours_before: 5, percent: 0 },
];

export function computeRefund(
  hoursBefore: number,
  policy: readonly CancellationPolicyTramo[] = politicasPorDefecto,
): { tierHoursBefore: number; percentApplied: number } {
  // Busca el primer tramo cuya hora límite es >= hoursBefore
  for (const tramo of policy) {
    if (hoursBefore >= tramo.hours_before) {
      return { tierHoursBefore: tramo.hours_before, percentApplied: tramo.percent };
    }
  }
  // Si hoursBefore es menor que el mínimo (5), devuelve 0%
  return { tierHoursBefore: 5, percentApplied: 0 };
}