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
    // Carga `.env.local` antes de los tests: Vitest no lo hace solo, y las
    // credenciales de la base no pueden llevar prefijo VITE_ porque acabarian
    // en el bundle del navegador.
    setupFiles: ["src/test/setup-env.ts"],
    // El RLS necesita ventana propia: cada test abre una sesion y hace
    // `set local role authenticated`, y la paralelidad las pisaria.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
