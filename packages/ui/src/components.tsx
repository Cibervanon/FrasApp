import type { CSSProperties, ReactNode } from "react";

/**
 * Componentes presentacionales. **Cero marca, cero logica, cero Supabase.**
 *
 * La marca entra por props desde `config-schema`. Si un componente lleva un
 * color, un logo o un nombre de club dentro, viola la regla 1 y el test de
 * limites de capas (T6) lo marca.
 */

/**
 * Los nombres de estos dos colores son los de la base de datos, no los que
 * molarian mas. En `tenant_branding` la columna se llama `secondary_color`, y
 * llamarla `accent` aqui obligaba a traducir en cada frontera; el nombre que no
 * coincide con la columna es el que se equivoca primero y sin que nadie se entere.
 */
export interface BrandColors {
  readonly primary: string;
  readonly secondary: string;
}

/**
 * `CSSProperties` no admite variables CSS personalizadas, asi que se amplia.
 * Con un cast a secas el typecheck pasaria pero el tipo mentiria, que es peor.
 */
export type BrandVars = CSSProperties & {
  "--brand-primary": string;
  "--brand-secondary": string;
};

/**
 * Aplica los colores del tenant como variables CSS. Los componentes de abajo
 * las usan, en lugar de tener colores propios.
 *
 * Quien llama a esto es el servidor, una vez por pagina, en el elemento raiz. Los
 * componentes NO lo llaman, y antes de este cambio `Card` si lo hacia, pasandose a si
 * mismo `var(--brand-primary)` como valor de `--brand-primary`. Eso no era un
 * pseudocodigo inocuo: una variable personalizada que se referencia a si misma es
 * invalida en tiempo de calculo, y una propiedad personalizada invalida se resuelve
 * como si no estuviera definida. En una pagina sin marca, el efecto era que `Card` se
 * borraba a si misma las variables de su subarbol y todo lo que colgara de ahi se
 * quedaba sin color. Un fallo que solo aparece cuando el tenant NO tiene branding, que
 * es justo cuando nadie lo va a mirar.
 */
export function brandVars(colors: BrandColors): BrandVars {
  return {
    "--brand-primary": colors.primary,
    "--brand-secondary": colors.secondary,
  };
}

export interface CardProps {
  readonly title: string;
  readonly children: ReactNode;
}

/**
 * Tarjeta basica. Neutra a proposito: es el contenedor de contenido que usan todas las
 * pantallas, y si llevara un tinte de marca, cada club veria las cajas de todo el club
 * del color de su primary, que es exactamente el efecto "pasted from the club" que la
 * regla 1 quiere evitar. La marca entra en los sitios que de verdad la piden (cabecera,
 * enlaces primarios), no en el marco de todo lo demas.
 */
export function Card({ title, children }: CardProps) {
  return (
    <section className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
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
