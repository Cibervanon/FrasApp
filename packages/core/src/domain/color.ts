/**
 * El color con el que hay que escribir encima de un color de marca.
 *
 * ---------------------------------------------------------------------------------------
 * EL PROBLEMA QUE ESTA FUNCION RESUELVE
 *
 * El color primario lo elige el gestor, y nada le impide elegir `#f5e642` (amarillo
 * palido) o `#ffffff`. Entonces un boton con `background: var(--brand-primary)` y
 * `text-white` — que es lo que escribe cualquiera sin pensar — se queda en amarillo claro
 * con texto blanco encima. Contraste 1:1. El boton desaparece.
 *
 * Y el caso no es exotico: los clubes eligen el color de su pista, y el color de una pista
 * de cesped es verde, el de una pista de cristal es azul claro y el de las pistas de playa
 * es arena. Son justo los colores que no aguantan texto blanco. No es un error de un club
 * mal elegido, es la mitad de los colores que la gente elige.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE NO SE RESUELVE EN CSS
 *
 * Porque CSS no puede decidirlo. `color-contrast()` todavia no existe en los navegadores, y
 * el truco de poner el texto en negro y en blanco a la vez, o de usar `mix-blend-mode`, dan
 * bordes suaves y un texto que se ve mal en una de las dos opciones. Ademas el valor que
 * sale de la base es un `#rrggbb` que hay que mirar, y mirar un color es un calculo.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE NO SE USA EL ALGORITMO DE WCAG COMPLETO
 *
 * Porque aqui se elige entre NEGRO y BLANCO, que son los dos extremos y solo dos
 * candidatos. De los dos, el contraste mayor gana siempre, y para un fondo con L
 * relativa mayor que ~0.179 el blanco gana, y por debajo gana el negro. La razon es la
 * misma que usa WCAG para el modo automatico, y el margen (7% a favor del blanco) sale de
 * la luminancia a la que los dos empatan.
 *
 * ---------------------------------------------------------------------------------------
 * LA CONVERSION A LUMINANCIA RELATIVA
 *
 * Es la de WCAG 2.x, con el exponente 2.4 en los canales lineales y los factores 0.2126,
 * 0.7152 y 0.0722. NO es la del espacio sRGB con el exponente 1/2.2 ni la simple media de
 * los tres canales, que son las dos que salen en tutoriales y las dos que dan numeros que
 * no cuadran con las tablas de contraste de WCAG.
 *
 * Los canales por debajo de 0.04045 se dividen por 12.92 en vez de sacarles la potencia: es
 * el tramo de la curva que es practicamente lineal y en el que una potencia de 2.4 haria
 * la entrada oscurecida de mas. Ese mismo criterio, invertido, es el de la funcion, y por
 * eso esta aqui el `if` en vez de una potencia y ya.
 */

/** Los tres canales de un color, de 0 a 255. */
interface Rgb {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

/** Blanco y negro puros, que son los dos unicos candidatos. */
const BLANCO = "#ffffff";
const NEGRO = "#000000";

/** Luminancia relativa a partir de la que el blanco gana a partir de igual. */
const UMBRAL = 0.179;

/**
 * Quita el `#` y se asegura de que son 6 digitos hex.
 *
 * El `?:` es porque el valor viene de `tenant_branding.primary_color`, y ese campo tiene un
 * `check` en la migracion, pero el que escribe aqui no es la base: es la gente que llama a
 * esta funcion. Un `#fff` de tres digitos aqui daria `parseInt("f", 16)` y un canal
 * silenciosamente mal, o sea un boton con el texto mal puesto y ningun error. Se normaliza
 * a tres digitos, que es lo que significa `#fff` en cualquier parte.
 */
function aRgb(hex: string): Rgb {
  const limpio = hex.startsWith("#") ? hex.slice(1) : hex;
  const tres = limpio.length === 3 ? limpio.replace(/./g, (c) => c + c) : limpio;

  return {
    r: parseInt(tres.slice(0, 2), 16),
    g: parseInt(tres.slice(2, 4), 16),
    b: parseInt(tres.slice(4, 6), 16),
  };
}

/** Un canal de 0 a 255 a su valor lineal, que es lo que la luminancia espera. */
function aLineal(canal: number): number {
  const c = canal / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** La luminancia relativa de un color, de 0 (negro) a 1 (blanco). */
function luminancia(hex: string): number {
  const { r, g, b } = aRgb(hex);
  return (
    0.2126 * aLineal(r) + 0.7152 * aLineal(g) + 0.0722 * aLineal(b)
  );
}

/**
 * Negro o blanco, segun el que se lea mejor encima de `fondo`.
 *
 * Devuelve el color, no un booleano, porque quien lo usa lo mete en un `style` y ya.
 */
export function readableForeground(fondo: string): string {
  return luminancia(fondo) > UMBRAL ? NEGRO : BLANCO;
}
