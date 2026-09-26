/**
 * Carga `.env.local` en `process.env` para los tests de integracion.
 *
 * POR QUE HACE FALTA ESTE FICHERO
 * Vitest no lee `.env.local` por su cuenta. Vite solo expone a `import.meta.env`
 * las variables con prefijo `VITE_`, y aqui no hay ninguna: son credenciales de
 * base de datos, que jamas deben llevar ese prefijo porque acabarían en el
 * bundle del navegador. Asi que sin esto, `process.env.PGPASSWORD` seria
 * undefined y el test de RLS no tendria con que conectarse.
 *
 * Se ejecuta como `setupFiles` de `vitest.db.config.ts`, antes que cualquier
 * test. Y es solo para los tests: en la app Next ya carga `.env.local` solo.
 */

import { config } from "dotenv";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = join(APP_DIR, ".env.local");

if (existsSync(ENV_FILE)) {
  // `override: false` para que una variable ya presente en el entorno real gane.
  // Asi se puede apuntar el test a otra base sin editar el fichero, que es lo
  // que hara el Checkpoint 0 si se levanta mas de una instancia.
  config({ path: ENV_FILE, override: false });
}
