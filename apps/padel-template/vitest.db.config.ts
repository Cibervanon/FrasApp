import { defineConfig } from "vitest/config";

/**
 * Tests de integracion contra Postgres REAL. Requiere el Postgres local levantado.
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
    //
    // ESTO ES CONFIGURACION, NO UNA GARANTIA. Que se pueda reescribir es
    // precisamente el problema, asi que `db-harness.ts` toma ADEMAS un
    // `pg_advisory_lock` sobre la base. Si alguien quita estas dos lineas, el
    // cerrojo del harness hace fallar la suite con un mensaje que dice que
    // revisar, en vez de dejar que dos ficheros se pisen en silencio.
    fileParallelism: false,
    // `describe.concurrent` y `it.concurrent` harian correr tests de dentro del
    // mismo fichero a la vez. Contra una base compartida eso es un `terms_notice`
    // en el commits de otro test. Se prohibe explicitamente en vez de confiar en que
    // nadie lo escriba.
    sequence: { concurrent: false },
    hookTimeout: 30_000,
    testTimeout: 30_000,
  },
});
