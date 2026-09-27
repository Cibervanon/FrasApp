/**
 * El guardián de la capa `ui`. Si esto falla, `ui` ha dejado de ser presentacional.
 *
 * ES EL GEMELO DE `core/src/boundaries.test.ts`, Y COPIA SU MODO DE TRABAJAR A PROPOSITO
 * Dos guards que miran lo mismo con reglas parecidas se mantienen solos; dos que se
 * desvian hay que arreglarlos dos veces. La diferencia es que `ui` SI puede importar
 * `react` (es un peer dependency suya, sin el cual no hay componentes), mientras que
 * `core` no puede ni tocarlo.
 *
 * POR QUE ESCANEA FUENTES Y NO IMPORTS
 * Un `import type { ReactNode } from "react"` no aparece en el JavaScript compilado, asi
 * que un guard que mirase el producto final no lo veria. Y aqui el error que hay que cazar
 * es justo un import de tipo: `import type { SupabaseClient } from "@supabase/supabase-js"`
 * no rompe el build, no rompe los tests y no se ve hasta que alguien le pasa una clave a
 * un componente que deberia ser tonto.
 *
 * POR QUE ESTE FICHERO NO SE ESCANEA A SI MISMO
 * Sus patrones son literales que casan consigo mismos: un `@supabase` escrito dentro de la
 * expresion regular que busca `@supabase` se detecta a si mismo y el guard falla siempre
 * por ser el guard. El precio es que el guard no vigila el guard, y es aceptable porque
 * este fichero no importa nada prohibido.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const SELF = "boundaries.test.ts";

/**
 * Fuentes de `ui`: `.ts`, `.tsx` y `.css`, que es lo que se publica.
 *
 * Se excluyen los `.d.ts` (los genera `tsc`) y este mismo fichero. Los tests NO se
 * excluyen aqui, a diferencia de los hex de `brand-literals.test.ts` en la app: un test
 * que importa `@supabase` para comprobar un mock sigue siendo una capa `ui` que depende
 * de Supabase, y eso hay que verlo.
 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (
      /\.(ts|tsx|css)$/.test(entry) &&
      !entry.endsWith(".d.ts") &&
      entry !== SELF
    ) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Quita los comentarios antes de buscar codigo prohibido.
 *
 * `styles.css` usa comentarios `/* ... *\/` de bloque, igual que TypeScript, asi que el
 * mismo stripper sirve para los dos sin ramificar.
 *
 * LIMITACION CONOCIDA: es un stripter de verdad tentativa, no un parser. Si un string
 * del codigo contuviera `//` sin `:` delante, se comeria el resto de la linea. No pasa
 * nada hoy porque `ui` no lleva URLs; si algun dia las lleva, esto hay que cambiarlo por
 * un parseo real. Es la misma limitacion que admite el guard de `core`, y por eso esta
 * escrita en los dos sitios en vez de escondida en uno.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FILES = sourceFiles(SRC_DIR).map((path) => {
  const source = readFileSync(path, "utf8");
  return {
    path: path.slice(SRC_DIR.length + 1),
    esTest: /\.test\.(ts|tsx)$/.test(path),
    code: stripComments(source),
  };
});

describe("limites de capas: ui es presentacional", () => {
  it("hay codigo que comprobar", () => {
    // Sin esto, un fallo al recoger ficheros daria un "0 tests" que parece verde.
    expect(FILES.length).toBeGreaterThan(0);
  });

  /**
   * Lo que `ui` NO puede importar, y por que.
   *
   * `react` NO esta aqui, y su ausencia es deliberada: es un peer dependency de este
   * paquete (`package.json`), asi que importar tipos de React es lo unico que se le
   * permite saber de React. Lo que no puede es importar el framework que decide COMO se
   * renderiza, ni el cliente que decide COMO se habla con la base de datos.
   *
   * `alcance` distingue dos preguntas que se parecen y no son la misma:
   *
   * - `"todos"`: vale en cualquier fichero, tests incluidos. Es la direccion de la
   *   dependencia. Un test que importa `@supabase` esta diciendo que el modulo necesita un
   *   cliente de Supabase, y eso es un problema de diseno que un test no se puede
   *  pdocargar legitimando.
   * - `"publicado"`: solo en el codigo que se publica. Aqui entra `node:`. Un test que
   *   lee `styles.css` con `readFileSync` esta haciendo el trabajo del guard, no
   *   burdensome la capa: `ui` no se ejecuta en el navegador, se compila, y nada de esto
   *   llega al bundle. Prohibirselo a un test dejaria dos salidas y ninguna buena: o el
   *   test no puede comprobar nada, o el guard se relaja en todo.
   *
   * El filtro de `alcance` se aplica al comprobar, no al recoger ficheros, para que anadir
   * una regla nueva no pueda cambiar silenciosamente el conjunto que se mira.
   */
  const FORBIDDEN_IMPORTS: ReadonlyArray<
    readonly [motivo: string, pattern: RegExp, alcance: "todos" | "publicado"]
  > = [
    [
      "@supabase (regla 2: la RLS es de la capa de datos, no de un boton)",
      /from\s+["']@supabase\//,
      "todos",
    ],
    [
      "next (un componente presentacional no sabe si hay App Router o Pages)",
      /from\s+["']next(\/[^"']*)?["']/,
      "todos",
    ],
    [
      "pg (nadie en la UI habla con la base de datos; lo hace lib/server)",
      /from\s+["']pg["']|require\(["']pg["']\)/,
      "todos",
    ],
    [
      "el esquema de @frasapp/config-schema (la marca entra ya parseada, por props)",
      /from\s+["']@frasapp\/config-schema/,
      "todos",
    ],
    [
      "los builtins de node (esta capa se renderiza en el navegador)",
      /from\s+["']node:/,
      "publicado",
    ],
  ];

  for (const [motivo, pattern, alcance] of FORBIDDEN_IMPORTS) {
    it(`no importa ${motivo}`, () => {
      const mirados =
        alcance === "publicado" ? FILES.filter((file) => !file.esTest) : FILES;
      const offenders = mirados
        .filter((file) => pattern.test(file.code))
        .map((file) => file.path);
      expect(offenders).toEqual([]);
    });
  }

  it("no habla con la red", () => {
    // Un componente que hace `fetch` es un componente con estado, y el estado en una capa
    // presentacional es la forma corta de que dos tenants compartan pantalla.
    const offenders = FILES.filter((file) => !file.esTest && /\bfetch\(/.test(file.code)).map(
      (file) => file.path,
    );
    expect(offenders).toEqual([]);
  });
});

describe("la marca entra por props, no por el modulo", () => {
  /**
   * `ui` declara el tipo de los colores (`BrandColors`) y las variables CSS, pero el
   * VALOR tiene que venir de fuera. Este test no puede comprobar el valor (no hay base de
   * datos aqui), asi que comprueba lo unico que si puede: que ningun componente tenga un
   * color escrito dentro. El guard de hex vive en la app, en `brand-literals.test.ts`,
   * porque la lista de nombres de club es de esta instancia y no del paquete.
   *
   * Lo que si se comprueba aqui es que la capa no tenga su propia fuente de la verdad:
   * si `ui` exportara un color por defecto, un club sin `tenant_branding` caeria en el
   * color de otro y la regla 1 seria cierta solo mientras nadie se olvidara de sobreescribir.
   */
  it("no exporta ningun color por defecto", () => {
    const offenders = FILES.filter((file) =>
      /export\s+(const|let)\s+\w*(COLOR|COLOUR|PRIMARY|SECONDARY|ACCENT|BRAND)\w*\s*=/i.test(
        file.code,
      ),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
