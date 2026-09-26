import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
  // Sin `coverage` a proposito: la spec pide 100% en `core`, pero en T0 no hay
  // logica de negocio todavia. Medir cobertura de codigo de configuracion da
  // un 100% que no significa nada. El umbral real se activa en T7, con
  // resolvePrice y computeRefund implementados, y ahi se vuelve verificable.
});
