/**
 * Carga `.env.local` en `process.env` para los tests de integracion.
 *
 * POR QUE HACE FALTA ESTE FICHERO
 * Vitest no lee `.env.local` por su cuenta. Vite solo expone a `import.meta.env`
 * las variables con prefijo `VITE_`, y aqui no hay ninguna: son credenciales de
 * base de datos, que jamas deben llevar ese prefijo porque acabarian en el
 * bundle del navegador. Asi que sin esto, `process.env.PGPASSWORD` seria
 * undefined y el test de RLS no tendria con que conectarse.
 *
 * POR QUE BUSCA POR `process.cwd()` Y NO POR `import.meta.url`
 * Primero lo intente con `import.meta.url` y `.env.local` no se cargaba: el
 * module runner de Vitest no da una ruta de fichero real, asi que el directorio
 * calculado no existia y el `existsSync` devolvia false sin decir nada. Un fallo
 * silencioso en la carga de credenciales es el peor sitio posible para un fallo
 * silencioso.
 *
 * `process.cwd()` si es fiable: Turbo lanza cada tarea con el directorio del
 * paquete, asi que aqui es `apps/padel-template`. Y por si alguien lanza Vitest
 * a mano desde la raiz del monorepo, se sube buscando hasta 3 niveles.
 */

import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { config as loadEnv } from "dotenv";

/** Busca `.env.local` en el directorio actual y tres niveles hacia arriba. */
function findEnvFile() {
  let dir = process.cwd();
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = join(dir, ".env.local");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const envFile = findEnvFile();

if (envFile) {
  // `override: false` para que lo que ya este en el entorno real gane: asi se
  // puede apuntar el test a otra base sin editar el fichero.
  loadEnv({ path: envFile, override: false });
  if (!process.env["PGPASSWORD"]) {
    console.warn(
      `[setup-env] ${resolve(envFile)} no define PGPASSWORD. ` +
        `Los tests de RLS fallaran al conectar.`,
    );
  }
} else {
  console.warn(
    `[setup-env] No se encontro .env.local ni en ${process.cwd()} ni 3 niveles ` +
      `arriba. Los tests de RLS fallaran al conectar.`,
  );
}
