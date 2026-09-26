import { defineConfig } from "vitest/config";

/**
 * Tests unitarios: rapidos, sin base de datos, sin navegador.
 *
 * Los tests de RLS e integracion llevan el sufijo `.db.test.ts` y NO se ejecutan
 * aqui. Van en `pnpm test:db`, que necesita Supabase local. Motivo: si la base no
 * esta levantada, `pnpm test` fallaria por falta de Postgres y dejaria de ser una
 * senal util.
 *
 * `pnpm verify` **si** incluye `test:db`, de modo que un RLS roto no puede pasar
 * el gate por no mirarlo.
 *
 * Nota: los globs van sin la secuencia de cierre de comentario, porque `*` seguido
 * de `/` dentro de este bloque lo cerraria antes de tiempo.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: ["src/**/*.db.test.ts"],
  },
});
