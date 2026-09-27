import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  brandStyle,
  CourtList,
  descripcionDePista,
  NEUTRAL_BRAND,
} from "./components.js";

/**
 * Smoke test de T0. En T0 no hay DOM que renderizar todavia, asi que esto
 * comprueba lo unico que se puede comprobar sin montar: que la capa `ui` no
 * arrastra logica ni configuracion de tenant.
 */
describe("ui: capa presentacional", () => {
  it("expone la marca como variables CSS, no como valores fijos", () => {
    const style = brandStyle({
      primary: "#123456",
      secondary: "#abcdef",
      fontFamily: "Inter, sans-serif",
      onPrimary: "#ffffff",
    });

    expect(style["--brand-primary"]).toBe("#123456");
    expect(style["--brand-secondary"]).toBe("#abcdef");
    expect(style["--brand-on-primary"]).toBe("#ffffff");
    expect(style.fontFamily).toBe("Inter, sans-serif");
  });

  it("lleva la fuente en el MISMO objeto que los colores", () => {
    // La fuente es parte de la marca y sale de la misma fila de `tenant_branding`, asi
    // que va aqui y no en un `<style>` aparte. Este test falla si alguien los separa,
    // que es el camino por el que la mitad de la marca se queda sin pintar.
    const style = brandStyle({
      primary: "#123456",
      secondary: "#abcdef",
      fontFamily: "Inter, sans-serif",
      onPrimary: "#ffffff",
    });

    expect(Object.keys(style)).toContain("fontFamily");
  });
});

/**
 * El respaldo de `styles.css` NO es un color de marca, y eso hay que poder
 * comprobarlo en vez de creerlo.
 *
 * Por que este test existe: la regla 1 prohibe colores de marca en el codigo que se
 * renderiza, y el respaldo de `:root` es justo uno de esos ficheros. La salida facil
 * para que el test de hex pase es borrar el valor de las variables y dejarlas
 * indefinidas, y la consecuencia no es "la pagina se ve sin marca": es que
 * `var(--brand-primary)` no resuelve a nada y el fondo queda transparente. Ese es el
 * fallo que este test evita.
 *
 * El invariante es el croma. En `oklch(L C H)` un gris tiene `C = 0` y cualquier color
 * con identidad tiene `C > 0`. Un gris azulado muy sutil (`C = 0.004`) tambien pasaria,
 * y es una decision: un token cuyo unico proposito es "no tener identidad" no puede
 * distinguirse a ojo del azul de un club, asi que el limite se pone donde se acaba el
 * gris. El guardia del hex cubre el otro 90% de las vias de colarse un color.
 */
describe("ui: el respaldo de los tokens de marca es un gris, no un color", () => {
  const styles = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "styles.css"), "utf8");

  /** Los tres numeros de un `oklch(L C H)`, sin el envoltorio. */
  const OKLCH = /oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s*\)/;

  const TOKENS = ["--brand-primary", "--brand-secondary", "--brand-on-primary"] as const;

  for (const token of TOKENS) {
    it(`${token} esta declarado en un gris de croma cero`, () => {
      const declaration = new RegExp(`${token}:\\s*([^;]+);`).exec(styles);
      // Sin `!` ni `as`: el repo compila con `noUncheckedIndexedAccess`, y un
      // `declaration![1].trim()` deja de avisar justo cuando el fichero no declara el
      // token, que es el fallo que este test existe para ver.
      if (declaration === null) {
        throw new Error(`${token} no esta declarado en styles.css`);
      }

      const value = (declaration[1] ?? "").trim();
      const match = OKLCH.exec(value);

      // Se exige `oklch()` y no "cualquier color": un `currentColor` o un `gray` de
      // nombre pasarian un test de croma trivialmente, y no son el gris exacto que
      // espera la paleta de la app.
      if (match === null) {
        throw new Error(`${token} deberia estar en oklch(), no en "${value}"`);
      }

      const croma = Number(match[2] ?? Number.NaN);
      expect(croma, `${token} tiene croma ${croma}: eso ya es un color`).toBe(0);
    });
  }

  it("no hay ningun color hex en styles.css", () => {
    // Red de seguridad para el resto del fichero: el respaldo es el unico color que se
    // permite, y sale en oklch(), asi que cualquier hex aqui es un color sin justificacion.
    // Por eso `--brand-on-primary`, que es blanco, va en `oklch(1 0 0)` y no en `#ffffff`:
    // el blanco tambien se escribe en oklch para no tener que abrir una excepcion aqui.
    //
    // Se miran los DECLARACIONES, no los comentarios. Este propio fichero y el
    // `styles.css` explican ratios de contraste citando colores concretos, y un color
    // escrito en un comentario no pinta nada: quitarlo del escaneo no deja pasar un color
    // de club, solo deja explicar por que el blanco se pone en oklch.
    const sinComentarios = styles.replace(/\/\*[\s\S]*?\*\//g, "");
    const hex = /#[0-9a-fA-F]{3,8}\b/.exec(sinComentarios);
    expect(hex?.[0], "styles.css no deberia contener ningun hex").toBeUndefined();
  });

  /**
   * El respaldo esta escrito en DOS sitios: el `:root` de este CSS, que es lo que se ve
   * si nada lo sobrescribe, y `NEUTRAL_BRAND` en `components.tsx`, que es lo que
   * sobrescribe el layout cuando el club no tiene fila en `tenant_branding`.
   *
   * No se puede tener en uno solo: un token de `:root` tiene que ser un literal en el CSS,
   * y un literal no lee una constante de TypeScript. Asi que hay dos, y lo unico que
   * impide que se separen en silencio es este test. Sin el, cambiar el gris de respaldo en
   * el CSS deja la pantalla sin marca con un color distinto segas por donde vengas, y no
   * hay ningun error, solo una pantalla que se ve rara.
   */
  it("el respaldo del CSS y el de `NEUTRAL_BRAND` dicen lo mismo", () => {
    const declarado = (token: string): string => {
      const match = new RegExp(`${token}:\\s*([^;]+);`).exec(styles);
      if (match === null) throw new Error(`${token} no esta declarado en styles.css`);
      return (match[1] ?? "").trim();
    };

    expect(declarado("--brand-primary")).toBe(NEUTRAL_BRAND.primary);
    expect(declarado("--brand-secondary")).toBe(NEUTRAL_BRAND.secondary);
    expect(declarado("--brand-on-primary")).toBe(NEUTRAL_BRAND.onPrimary);
  });
});

/**
 * El texto de la tarjeta de pista, que es donde se equivoca uno sin darse cuenta.
 *
 * `descripcionDePista` esta exportada para esto, y estos numeros vienen de la migracion:
 * `courts_court_type_allowed` deja `cristal`, `malla` y `mixto`, y `courts_surface_allowed`
 * deja `cesped`, `lomo` y `hormigon` o nada. Los tests usan valores de ahi, no inventados,
 * para que un dia la migracion cambie el conjunto y se note.
 */
describe("ui: la descripcion de una pista", () => {
  it("junta tipo, superficie y si esta cubierta, con mayuscula la primera letra", () => {
    // La base guarda en minusculas porque son valores de un `check`. "cristal, cesped,
    // cubierta" en una tarjeta parece un descuido, asi que la primera letra sube.
    expect(
      descripcionDePista({ courtType: "cristal", surface: "cesped", indoor: true }),
    ).toBe("Cristal, Cesped, cubierta");
  });

  it("dice 'al aire libre' cuando no es cubierta, y no un interrogante", () => {
    // Este es el fallo que hizo sacar la funcion: un "?" pegado ahi se leia en voz alta.
    expect(
      descripcionDePista({ courtType: "malla", surface: null, indoor: false }),
    ).toBe("Malla, al aire libre");
  });

  it("sin superficie, no sale un separador de mas", () => {
    // `surface` es la unica de las dos que la spec deja nullable, asi que este es un
    // caso de verdad y no uno inventado para el test.
    const texto = descripcionDePista({
      courtType: "mixto",
      surface: null,
      indoor: true,
    });

    expect(texto).toBe("Mixto, cubierta");
    expect(texto).not.toContain(", ,");
    expect(texto.startsWith(",")).toBe(false);
  });
});

/**
 * Lo poco que se puede comprobar de un componente sin DOM ni `@testing-library`.
 *
 * Un elemento de React es un objeto con `type` y `props`, y `jsx("p", ...)` deja el `type`
 * como la cadena `"p"`. Es una asercion superficial, y por eso solo mira DOS cosas que son
 * las que se rompen: que un catalogo vacio NO se pinte como una `<ul>` vacia (que en
 * pantalla es un hueco sin explicar), y que el numero de `<li>` sea el de pistas.
 *
 * Lo que NO se comprueba aqui es el HTML final. Haria falta un renderer, que es una
 * dependencia nueva y una entrada mas en el lockfile: eso se pide, no se cuela.
 */
describe("ui: CourtList sin renderer", () => {
  it("un club sin pistas explica el motivo, en vez de dejar un hueco", () => {
    const elemento = CourtList({ courts: [] });

    expect(elemento.type).toBe("p");
    expect(elemento.props.className).toContain("border-dashed");
  });

  it("con pistas, hay un elemento por pista y en el mismo orden", () => {
    const elemento = CourtList({
      courts: [
        { id: "a", name: "Pista 1", courtType: "cristal", surface: "cesped", indoor: true, numPlayers: 4 },
        { id: "b", name: "Pista 2", courtType: "malla", surface: "hormigon", indoor: false, numPlayers: 4 },
      ],
    });

    expect(elemento.type).toBe("ul");
    // El `key` es lo que React usa para reconciliar la lista, y con un indice en vez del
    // id, reorderar el catalogo marcaria las tarjetas equivocadas.
    const hijos = elemento.props.children as readonly { key: string }[];
    expect(hijos.map((hijo) => hijo.key)).toEqual(["a", "b"]);
  });
});
