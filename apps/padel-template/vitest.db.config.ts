import { defineConfig } from "vitest/config";

/**
 * Tests de integracion contra Postgres REAL. Requiere `supabase start`.
 *
 * Nunca mocks para RLS: el mock no aplica la politica, asi que un RLS roto pasaria
 * el test. Este config existe para que estos tests no se mezclen con los unitarios
 * y para que quede explicito que necesitan la base de datos levantada.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.db.test.ts"],
    // El RLS necesita ventana propia: cada test abre una sesion y hace
    // `set local role authenticated`, y la paralelidad las pisaria.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
