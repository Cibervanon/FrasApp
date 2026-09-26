import type { CSSProperties, ReactNode } from "react";

/**
 * Componentes presentacionales. **Cero marca, cero logica, cero Supabase.**
 *
 * La marca entra por props desde `config-schema`. Si un componente lleva un
 * color, un logo o un nombre de club dentro, viola la regla 1 y el test de
 * limites de capas (T6) lo marca.
 */

export interface BrandColors {
  readonly primary: string;
  readonly accent: string;
}

/**
 * `CSSProperties` no admite variables CSS personalizadas, asi que se amplia.
 * Con un cast a secas el typecheck pasaria pero el tipo mentiria, que es peor.
 */
export type BrandVars = CSSProperties & {
  "--brand-primary": string;
  "--brand-accent": string;
};

/**
 * Aplica los colores del tenant como variables CSS. Los componentes de abajo
 * las usan, en lugar de tener colores propios.
 */
export function brandVars(colors: BrandColors): BrandVars {
  return {
    "--brand-primary": colors.primary,
    "--brand-accent": colors.accent,
  };
}

export interface CardProps {
  readonly title: string;
  readonly children: ReactNode;
}

/** Tarjeta basica. Sin colores propios: usa las variables del tenant. */
export function Card({ title, children }: CardProps) {
  return (
    <section
      className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm"
      style={brandVars({ primary: "var(--brand-primary)", accent: "var(--brand-accent)" })}
    >
      <h2 className="mb-2 text-lg font-semibold text-neutral-900">{title}</h2>
      {children}
    </section>
  );
}

export interface SlotGridProps {
  readonly slots: readonly { readonly id: string; readonly label: string; readonly available: boolean }[];
  readonly onSelect: (slotId: string) => void;
}

/**
 * Rejilla de franjas horarias. Muestra, no decide: no sabe nada de precios ni
 * de disponibilidad real, solo de lo que le pasan.
 */
export function SlotGrid({ slots, onSelect }: SlotGridProps) {
  return (
    <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {slots.map((slot) => (
        <li key={slot.id}>
          <button
            type="button"
            disabled={!slot.available}
            onClick={() => {
              onSelect(slot.id);
            }}
            className={
              slot.available
                ? "w-full rounded-md border border-neutral-300 px-3 py-2 text-sm hover:bg-neutral-50 disabled:cursor-not-allowed disabled:opacity-40"
                : "w-full rounded-md border border-neutral-200 px-3 py-2 text-sm text-neutral-400 line-through"
            }
          >
            {slot.label}
          </button>
        </li>
      ))}
    </ul>
  );
}
