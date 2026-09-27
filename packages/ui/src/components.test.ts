import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { brandVars } from "./components.js";

/**
 * Smoke test de T0. En T0 no hay DOM que renderizar todavia, asi que esto
 * comprueba lo unico que se puede comprobar sin montar: que la capa `ui` no
 * arrastra logica ni configuracion de tenant.
 */
describe("ui: capa presentacional", () => {
  it("expone los colores como variables CSS, no como valores fijos", () => {
    const style = brandVars({ primary: "#123456", secondary: "#abcdef" });

    expect(style["--brand-primary"]).toBe("#123456");
    expect(style["--brand-secondary"]).toBe("#abcdef");
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

  const TOKENS = ["--brand-primary", "--brand-secondary"] as const;

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
    const hex = /#[0-9a-fA-F]{3,8}\b/.exec(styles);
    expect(hex?.[0], "styles.css no deberia contener ningun hex").toBeUndefined();
  });
});
