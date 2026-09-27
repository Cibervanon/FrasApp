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
 *
 * Van con `fontFamily` porque los tres salen de la MISMA fila de `tenant_branding` y los
 * tres se aplican en el mismo atributo `style`. Separarlos obligaria al servidor a montar
 * dos objetos para un solo proposito, y a alguien a aplicar el color en un sitio y la
 * fuente en otro, que es la forma de que la mitad de la marca se quede sin pintar.
 */
export interface BrandStyle {
  readonly primary: string;
  readonly secondary: string;
  readonly fontFamily: string;
  /**
   * El color con el que se ESCRIBE encima de `primary`, no un cuarto color de marca.
   *
   * Lo CALCULA quien llama, con `readableForeground` de `packages/core`, y no se calcula
   * aqui por dos razones: `ui` no depende de `core` (y anadir esa dependencia es tocar el
   * lockfile), y esta capa no debe saber de contrastes, que es logica de negocio, no
   * maquetado.
   */
  readonly onPrimary: string;
}

/**
 * El respaldo de `styles.css`, en el mismo sitio donde el CSS lo declara.
 *
 * Vive en los dos sitios por una razon que no se puede evitar: un token de `:root` tiene
 * que ser un literal en el CSS, y un literal no puede leer una constante de TypeScript. Asi
 * que el CSS pone el que se ve si nada se sobrescribe, y esta constante es la que se
 * sobrescribe en runtime cuando el club no tiene marca. `components.test.ts` compara los
 * dos y falla si dejan de decir lo mismo, que es la forma de que esta duplicacion no se
 * rompa sola.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE LOS TRES COLORES ESTAN EN `oklch()` Y NO EN HEX
 *
 * Porque el guard de marca de la app prohibe cualquier hex en lo que se renderiza, y este
 * fichero se renderiza. Se podria pedir una excepcion para el blanco, que no es un color de
 * club, y seria la primera puerta que se abre en el guard mas importante del repositorio.
 * Con `oklch(1 0 0)` el blanco entra por el mismo lado que los grises, y el guard sigue sin
 * excepciones.
 *
 * Cuando hay marca, el `onPrimary` lo pone `readableForeground`, que devuelve hex porque
 * compara en hex. Los dos formatos conviven sin problema: `var(--brand-on-primary)` acepta
 * los dos, y el navegador no nota el cambio.
 * ---------------------------------------------------------------------------------------
 */
export const NEUTRAL_BRAND: BrandStyle = {
  primary: "oklch(0.216 0 0)",
  secondary: "oklch(0.145 0 0)",
  fontFamily: "system-ui, sans-serif",
  onPrimary: "oklch(1 0 0)",
};

/**
 * `CSSProperties` no admite variables CSS personalizadas, asi que se amplia.
 * Con un cast a secas el typecheck pasaria pero el tipo mentiria, que es peor.
 */
export type BrandStyleProps = CSSProperties & {
  "--brand-primary": string;
  "--brand-secondary": string;
  "--brand-on-primary": string;
};

/**
 * Aplica la marca del tenant como variables CSS, mas la fuente. Los componentes de abajo
 * las usan, en lugar de tener marca propia.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE `fontFamily` ESTA EN EL MISMO OBJETO Y NO EN UN `<style>`
 *
 * Porque React tiene una API para esto, que es el atributo `style`, y el objeto que se le
 * pasa admite claves `kebab-case` que empiezan por `--`. Es CSSOM, no texto: el navegador
 * parsesa el valor, y no hay nada que interpretar de nuevo.
 *
 * La alternativa es la que se ve en cualquier tutorial de marca blanca: concatenar un
 * `<style>{`:root{--brand-primary:${color}}`}</style>` con el color metido en una plantilla
 * de texto. Eso convierte el color del gestor en CODIGO, con las tres cosas que eso
 * arrastra: hay que escapar el valor (o no, y un color con `}` cierra la regla antes de
 * tiempo), el CSP tiene que permitir `style-src 'unsafe-inline'`, y el color pasa a estar
 * en el HTML en vez de estar en un atributo. Con el objeto, el React escapa y el CSP
 * puede seguir siendo estricto. Y como `fontFamily` va con las variables, la fuente del
 * club tambien se aplica sin tocar CSS.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE ESTA APLICADO UNA VEZ, EN EL SERVIDOR, Y NO EN CADA COMPONENTE
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
export function brandStyle(brand: BrandStyle): BrandStyleProps {
  return {
    "--brand-primary": brand.primary,
    "--brand-secondary": brand.secondary,
    "--brand-on-primary": brand.onPrimary,
    fontFamily: brand.fontFamily,
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

export interface CourtListProps {
  readonly courts: readonly {
    readonly id: string;
    readonly name: string;
    readonly courtType: string;
    readonly surface: string | null;
    readonly indoor: boolean;
    readonly numPlayers: number;
  }[];
}

/**
 * La primera letra en mayuscula. Formato, no traduccion.
 *
 * La base guarda `cristal` y `cesped` en minusculas, porque son valores de un `check` y en
 * SQL se comparan asi. "cristal, cesped, cubierta" en una tarjeta parece un descuido, asi que
 * la primera letra sube aqui.
 *
 * Y es un `slice`, no un diccionario de translationes, a proposito: los dos campos son
 * listas CERRADAS en la migracion (`courts_court_type_allowed` y `courts_surface_allowed`),
 * pero un mapa de "cristal" -> "Cristal" en el componente obliga a tocar el codigo cada vez
 * que la migracion admite un valor mas, y el fallo si se olvida es una pista con la palabra
 * en ingles en medio del texto del club. Con un `slice`, un valor nuevo sale en mayuscula
 * solo y nadie se entera de que hubo un mapa que actualizar.
 */
function mayuscula(texto: string): string {
  return texto.slice(0, 1).toUpperCase() + texto.slice(1);
}

/**
 * Como se juega en una pista, en una linea y sin repetir lo que ya dice el titulo.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE ESTA EXPORTADA SI SOLO LA USA `CourtList`
 *
 * Porque es la parte de este componente que DECIDE, y las decisiones se prueban. La parte
 * que maquina son etiquetas, y probarlas sin DOM necesitaria `@testing-library/react` mas
 * una entrada mas en el lockfile, que es una decision de proyecto y no un detalle de test.
 * El texto que sale delante del socio, en cambio, se puede comprobar aqui mismo.
 *
 * El separador es una coma y un espacio, y no un punto medio (`·`) a proposito: un lector
 * de pantalla hace una pausa en la coma y lee "Cristal, Cesped, cubierta" como tres cosas,
 * que es lo que es. Con un `·` la pausa no la marca nadie.
 *
 * Y en general este repositorio no es "ASCII-only", que es una regla que se suele creer y
 * aqui no es cierta: lo que `pnpm check:encoding` prohibe es el mojibake (BOM, controles
 * C0/C1, CJK, U+FFFD), porque eso si sale roto en pantalla. Un `·` en un texto que ve el
 * socio es UTF-8 valido y el HTML lo declara con `<meta charSet="utf-8">`; el titulo de la
 * pagina lo lleva y se ve bien.
 *
 * Y esta funcion es donde se rompen las cosas de verdad: el texto que sale delante del
 * socio. Una fila anadida a una tabla a mano y nadie se entero; un "?" pegado tres veces
 * en la misma pantalla. Eso se comprueba con un test, y un test necesita que la funcion
 * sea alcanzable.
 *
 * ---------------------------------------------------------------------------------------
 * EL ORDEN Y POR QUE
 *
 * El orden es el que lee el socio de izquierda a derecha: de que tipo es, de que es, y si
 * esta cubierta. `indoor` va al final porque es el dato que mas se confunde (una pista
 * "cubierta" lo dice el techo, no el tipo de pista) y por eso necesita la palabra entera y
 * no un icono, que ademas un lector de pantalla leeria como "cubierta interrogacion".
 */
export function descripcionDePista(court: {
  readonly courtType: string;
  readonly surface: string | null;
  readonly indoor: boolean;
}): string {
  const partes = [mayuscula(court.courtType)];
  if (court.surface !== null) partes.push(mayuscula(court.surface));
  partes.push(court.indoor ? "cubierta" : "al aire libre");
  return partes.join(", ");
}

/**
 * El catalogo de pistas, en tarjetas. Muestra, no decide: sin precios y sin disponibilidad,
 * que son T7.
 *
 * El texto sale de la base tal cual lo escribio el gestor, sin diccionarios por aqui, y por
 * eso la tarjeta no puede quedarse en blanco ni pedir un tipo que no exista: lo que no hay
 * en la base, no se pinta.
 */
export function CourtList({ courts }: CourtListProps) {
  if (courts.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-neutral-300 bg-white p-6 text-center text-sm text-neutral-600">
        Este club todavia no tiene pistas dadas de alta.
      </p>
    );
  }

  return (
    <ul className="flex flex-col gap-3">
      {courts.map((court) => (
        <li key={court.id}>
          <article className="rounded-lg border border-neutral-200 bg-white p-4 shadow-sm">
            <h2 className="text-base font-semibold text-neutral-900">{court.name}</h2>
            <p className="mt-1 text-sm text-neutral-600">
              {descripcionDePista(court)}
            </p>
            <p className="mt-2 text-sm font-medium text-neutral-800">
              {court.numPlayers} jugadores
            </p>
          </article>
        </li>
      ))}
    </ul>
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
