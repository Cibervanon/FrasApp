import next from "eslint-config-next";

/**
 * ESLint 10 en flat config. Next 16 elimino el comando `next lint`, asi que el
 * lint se ejecuta con el CLI de ESLint directamente.
 *
 * `--max-warnings 0` en el script: un aviso de lint que se acumula es un aviso
 * que nadie lee.
 *
 * El objeto de reglas de abajo declara `files` restringido a TS y TSX a
 * proposito. Sin `files`, se aplicaria tambien a `.mjs` y `.js`, donde el
 * plugin `@typescript-eslint` no esta registrado, y ESLint aborta con
 * "could not find plugin".
 *
 * Nota: los globs van con comillas y sin escribir la secuencia de cierre de
 * comentario, porque `*` seguido de `/` dentro de este bloque lo cerraria
 * antes de tiempo y el fichero no parsearia.
 */
const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "playwright-report/**",
      "test-results/**",
      "next-env.d.ts",
    ],
  },
  ...next,
  {
    files: ["**/*.ts", "**/*.tsx"],
    rules: {
      // Sin `any` explicito. El tipado estricto ya esta en tsconfig; esto
      // cierra la puerta a la via de escape de la que todo el mundo se vale.
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
];

export default config;
