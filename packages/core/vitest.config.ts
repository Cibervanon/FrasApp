import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  coverage: {
    provider: "v8",
    include: ["src/**/*.ts"],
    exclude: [
      "src/**/*.test.ts",
      // El barril `index.ts` son re-exports. Los tests de `core` importan del
      // modulo de origen, no del barril, asi que medirlo mide el 0% de un fichero
      // sin logica. Lo que si se comprueba es que el barril compila y exporta bien:
      // lo hacen `typecheck` y `build`, y las apps lo importan en cada `verify`.
      "src/index.ts",
      // Solo `type` e `interface`. Al compilar queda un modulo vacio: no hay
      // statements que ejecutar ni rama que cubrir.
      "src/domain/types.ts",
    ],
    reporter: ["text", "html"],
    // 100% en TODO el paquete, no solo en el fichero nuevo. La spec (11) pide 100%
    // en `core` porque es logica pura y barata de cubrir, y un umbral global es lo
    // unico que impide que la cobertura baje sin que nadie lo note: un umbral por
    // fichero nuevo deja los viejos pudriendose en silencio.
    //
    // `perFile` evita el truco clasico de promediar: un fichero al 50% tapado por
    // otro al 100% sale 100% en el total y nadie se entera.
    thresholds: {
      100: true,
      perFile: true,
    },
  },
});
