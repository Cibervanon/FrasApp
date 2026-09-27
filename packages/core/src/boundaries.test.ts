/**
 * El guardián de la regla de capas. Si esto falla, `core` ha dejado de ser `core`.
 *
 * Un type-only import de React no rompe el build ni los tests, asi que nada mas te
 * avisa. Aqui se comprueba el codigo fuente entero, incluidos los `import` que
 * TypeScript elimina al compilar.
 *
 * `Date.now()` y `new Date()` sin argumentos tambien se prohiben: `core` tiene que
 * ser puro para que el precio y el reembolso sean reproducibles y testeables como
 * tabla de casos. Una funcion que lee el reloj no se puede probar con "ahora".
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// Este fichero vive en `src/`, asi que su directorio ES la raiz del fuente. Un `..`
// de mas hacia el guardarse en `dist/` y escanear `node_modules` con el arbol de
// tipos de TypeScript dentro, que falla siempre y no dice nada de este paquete.
const SRC_DIR = dirname(fileURLToPath(import.meta.url));

/** Nombre de este propio fichero: no se escanea a si mismo (ver `sourceFiles`). */
const SELF = "boundaries.test.ts";

/**
 * Todo `.ts` de codigo propio bajo `src/`, que es lo que se publica.
 *
 * Se excluyen los `.d.ts` (los genera tsc, no los escribimos) y este mismo fichero.
 * Exclusion del guard necesaria: sus patrones son literales que casan consigo
 * mismo. Un `Date.now()` escrito dentro de la expresion regular que busca
 * `Date.now()` se detecta a si mismo, y el guard falla siempre por ser el
 * guard. El precio de esto es que el guard no vigila el guard, que es aceptable
 * porque este fichero no importa nada prohibido.
 */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...sourceFiles(full));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts") && entry !== SELF) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Quita los comentarios antes de buscar codigo prohibido.
 *
 * POR QUE ESTO ES NECESARIO Y NO UN DETALLE
 * `validation.ts` documenta que no usa `Math.random()`. Esa frase contiene la
 * llamada. Sin esto, el propio intento de documentar la regla la viola, y la
 * solucion seria callarse: escribir la regla sin nombrarla. Un guard que obliga a
 * no explicar por que se prohibe algo es un guard que empuja al silencio.
 *
 * LIMITACION CONOCIDA: es un stripper de verdad tentativa, no un parser de
 * TypeScript. Si un string del codigo contuviera `//` sin `:` delante, se comeria el
 * resto de la linea. No pasa nada hoy porque `core` no lleva URLs ni literales de
 * ese tipo; si algun dia los lleva, esto hay que cambiarlo por un parseo real.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    // El `:` evita partir `https://` dentro de un string.
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

const FILES = sourceFiles(SRC_DIR).map((path) => {
  const source = readFileSync(path, "utf8");
  return {
    path: path.slice(SRC_DIR.length + 1),
    source,
    code: stripComments(source),
  };
});

describe("limites de capas: core es puro", () => {
  it("hay codigo que comprobar", () => {
    // Sin esto, un fallo al recoger ficheros daria un "0 tests" que parece verde.
    expect(FILES.length).toBeGreaterThan(0);
  });

  const FORBIDDEN_IMPORTS: ReadonlyArray<readonly [string, RegExp]> = [
    ["react", /from\s+["']react["']|require\(["']react["']\)/],
    ["next", /from\s+["']next(\/[^"']*)?["']|require\(["']next(\/[^"']*)?["']\)/],
    ["@supabase", /from\s+["']@supabase\//],
    ["dotenv", /from\s+["']dotenv["']/],
  ];

  for (const [name, pattern] of FORBIDDEN_IMPORTS) {
    it(`no importa ${name}`, () => {
      const offenders = FILES.filter((file) => pattern.test(file.code)).map(
        (file) => file.path,
      );
      expect(offenders).toEqual([]);
    });
  }

  it("no lee el reloj", () => {
    const offenders = FILES.filter((file) =>
      /Date\.now\(\)|new\s+Date\s*\(\s*\)/.test(file.code),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("no genera numeros aleatorios", () => {
    // `computeRefund` con `Math.random()` seria una funcion pura que no lo es.
    const offenders = FILES.filter((file) =>
      /Math\.random\(\)/.test(file.code),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("no usa fetch ni http", () => {
    const offenders = FILES.filter((file) =>
      /\bfetch\(|node:https?|node:http/.test(file.code),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});

describe("el umbral de cobertura no se puede vaciar de archivos", () => {
  /**
   * POR QUE ESTE TEST EXISTE
   *
   * `coverage.thresholds` mide los ficheros que el run carga. Si nadie importa
   * `validation.ts` en ningun test, ese fichero no aparece en el informe, y el
   * informe sale 100%. O sea: BORRAR UN `*.test.ts` deja la cobertura al 100% y el
   * `pnpm verify` en verde, que es el peor resultado posible para un gate: verde
   * Midiendo menos.
   *
   * Se comprobo: correr `vitest run --coverage src/domain/color.test.ts` deja
   * `availability.ts` y `validation.ts` fuera del informe y sigue marcando 100%.
   *
   * La regla que este test pone es la que la spec quiere decir con "100% en
   * `core`": todo modulo de logica tiene al menos un test que lo importa. No
   * comprueba CUANTO cubren, de eso se encarga el umbral; comprueba que estan todos.
   */
  it("cada modulo de logica lo importa al menos un test", () => {
    const modulos = readdirSync(join(SRC_DIR, "domain"))
      .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".d.ts"))
      // Los propios tests no son modulos de logica, y sin esto el test se detecta
      // a si mismo: `pricing.test.ts` no importa `./pricing`.
      .filter((entry) => !entry.endsWith(".test.ts"))
      // `types.ts` es solo declaraciones: al compilar no queda codigo que ejecutar.
      .filter((entry) => entry !== "types.ts");

    expect(modulos.length).toBeGreaterThan(0);

    const fuentesDeTest = FILES.filter((file) => file.path.endsWith(".test.ts")).map(
      (file) => file.source,
    );
    const sinTest = modulos.filter(
      (modulo) =>
        !fuentesDeTest.some((source) => source.includes(`./${modulo.slice(0, -3)}.js`)),
    );

    expect(sinTest, `modulos sin un solo test que los importe: ${sinTest.join(", ")}`)
      .toEqual([]);
  });
});

describe("la lista de features es la misma en core y en config-schema", () => {
  /**
   * Esta es la red que evita lo que paso en T1: `core` declaraba 5 features y
   * `config-schema` 7, porque los dos se escribieron por separado. Dos fuentes de
   * verdad que no coinciden producen un `FeatureKey` que no compila contra el enum
   * real, o peor, que compila y deja features sin cubrir.
   *
   * Compara el fuente de los dos sin importar ninguno: si se importaran, el test
   * probaria que el modulo carga, no que dicen lo mismo.
   */
  it("core y config-schema declaran las mismas feature keys", () => {
    const coreTypes = readFileSync(resolve(SRC_DIR, "domain", "types.ts"), "utf8");
    const coreBlock = coreTypes.match(/export type FeatureKey\s*=\s*([\s\S]*?);/)?.[1];
    expect(coreBlock, "no se encontro el tipo FeatureKey en core").toBeDefined();

    const coreKeys = [...(coreBlock ?? "").matchAll(/"([a-z_]+)"/g)].map(
      (match) => match[1],
    );
    expect(coreKeys.length).toBeGreaterThan(0);

    const configSchemaPath = resolve(
      SRC_DIR,
      "..",
      "..",
      "config-schema",
      "src",
      "schema.ts",
    );
    const configSchema = readFileSync(configSchemaPath, "utf8");
    // El enum de Zod es la fuente de verdad: `z.enum([...])` en `featureKeySchema`.
    const schemaKeys = [
      ...(configSchema.match(/featureKeySchema\s*=\s*z\.enum\(\[([\s\S]*?)\]\)/)?.[1] ??
        "").matchAll(/"([a-z_]+)"/g),
    ].map((match) => match[1]);
    expect(schemaKeys.length).toBeGreaterThan(0);

    // En ambos sentidos: si uno tiene una clave que el otro no, el fallo tiene que
    // ser explicito, no "las listas se parecen".
    expect([...coreKeys].sort()).toEqual([...schemaKeys].sort());
  });
});
