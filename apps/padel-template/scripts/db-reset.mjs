/**
 * Resetea la base local de desarrollo con PostgreSQL nativo de Windows.
 *
 * POR QUE ESTO EXISTE Y POR QUE NO ES `supabase db reset`
 * El plan original usaba Supabase CLI, que levanta su propia base en Docker. El
 * usuario eligió PostgreSQL nativo para no instalar el kernel de WSL2 ni Docker
 * en su equipo. Como `supabase db reset` y `supabase start` dependen de Docker,
 * este script hace el mismo trabajo contra el Postgres que ya está instalado.
 *
 * ORDEN DE APLICACIÓN
 *   1. Crea la base de datos desde cero.
 *   2. `auth-shim.sql`: el esquema `auth` con `jwt()`, `uid()` y `role()`.
 *      Va PRIMERO porque las políticas RLS de la migración 001 los referencian.
 *   3. Las migraciones de `supabase/migrations/`, en orden de nombre.
 *   4. `seed.sql`.
 *
 * El shim va aparte y las migraciones NO lo incluyen, a propósito: en producción
 * Supabase ya tiene esas funciones, y meterlas en una migración daría
 * "already exists" en el despliegue real.
 *
 * CREDENCIALES
 * Salen de variables de entorno, nunca de codigo. Se leen de
 * `apps/padel-template/.env.local`, que ya está en `.gitignore`. Si falta la
 * contraseña el script para con un mensaje claro en vez de adivinar: un default
 * silencioso significa conectar a una base equivocada y creerse que todo va bien.
 */

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { config as loadEnv } from "dotenv";
import { Client } from "pg";

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SUPABASE_DIR = join(APP_DIR, "supabase");
const MIGRATIONS_DIR = join(SUPABASE_DIR, "migrations");

// `override: false`: lo que ya este en el entorno real gana sobre el fichero, para
// poder apuntar a otra base sin editar nada.
loadEnv({ path: join(APP_DIR, ".env.local"), override: false });
const env = process.env;

const required = (key) => {
  const value = env[key];
  if (!value) {
    console.error(
      `\nFalta ${key} en apps/padel-template/.env.local.\n` +
        `Ejemplo:\n` +
        `  PGHOST=localhost\n` +
        `  PGPORT=5432\n` +
        `  PGUSER=postgres\n` +
        `  PGPASSWORD=<la que pusiste al instalar>\n` +
        `  PGDATABASE=padel_template\n` +
        `  PGADMIN_DATABASE=postgres\n`,
    );
    process.exit(1);
  }
  return value;
};

const config = {
  host: env["PGHOST"] ?? "localhost",
  port: Number(env["PGPORT"] ?? 5432),
  user: env["PGUSER"] ?? "postgres",
  password: required("PGPASSWORD"),
  database: env["PGDATABASE"] ?? "padel_template",
  adminDatabase: env["PGADMIN_DATABASE"] ?? "postgres",
};

/** `DROP DATABASE` falla si hay conexiones abiertas, y las deja los tests de RLS. */
async function recreateDatabase() {
  const admin = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.adminDatabase,
  });
  await admin.connect();
  try {
    const { rowCount } = await admin.query(
      "select pg_terminate_backend(pid) from pg_stat_activity where datname = $1 and pid <> pg_backend_pid()",
      [config.database],
    );
    if (rowCount && rowCount > 0) {
      console.log(`  cerradas ${rowCount} conexiones abiertas`);
    }
    await admin.query(`drop database if exists "${config.database}"`);
    await admin.query(`create database "${config.database}"`);
  } finally {
    await admin.end();
  }
}

async function applyFile(client, path, label) {
  const sql = readFileSync(path, "utf8");
  try {
    await client.query(sql);
    console.log(`  ok  ${label}`);
  } catch (error) {
    console.error(`  FALLO  ${label}`);
    console.error(`         ${error.message}`);
    if (error.position) {
      const lines = sql.split("\n");
      const line = sql.slice(0, error.position).split("\n").length;
      console.error(`         linea ${line}: ${lines[line - 1]?.trim() ?? ""}`);
    }
    process.exit(1);
  }
}

async function main() {
  console.log(
    `Base local: ${config.user}@${config.host}:${config.port}/${config.database}`,
  );

  console.log("\n1/4 recreando la base de datos");
  await recreateDatabase();

  const client = new Client({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
  });
  await client.connect();
  try {
    // Cada paso en su propia transaccion: si la migracion falla, la base se
    // queda vacia y no medio aplicada, que es mas facil de diagnosear.
    console.log("\n2/4 aplicando el shim de auth");
    await applyFile(client, join(SUPABASE_DIR, "local", "auth-shim.sql"), "auth-shim.sql");

    console.log("\n3/4 aplicando migraciones");
    const migrations = readdirSync(MIGRATIONS_DIR)
      .filter((name) => name.endsWith(".sql"))
      .sort();
    if (migrations.length === 0) {
      console.error("  no hay migraciones en supabase/migrations/");
      process.exit(1);
    }
    for (const name of migrations) {
      await applyFile(client, join(MIGRATIONS_DIR, name), name);
    }

    console.log("\n4/4 aplicando la seed");
    await applyFile(client, join(SUPABASE_DIR, "seed.sql"), "seed.sql");
  } finally {
    await client.end();
  }

  console.log("\nBase lista. Ahora: pnpm test:db\n");
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  if (error.code === "ECONNREFUSED") {
    console.error(
      `No hay nada escuchando en ${config.host}:${config.port}.\n` +
        `Si acabas de instalar PostgreSQL, el servicio deberia estar arrancando:\n` +
        `  Get-Service postgresql-x64-17\n`,
    );
  }
  if (error.code === "28P01") {
    console.error(`La contraseña no es correcta. Revisa PGPASSWORD en .env.local\n`);
  }
  process.exit(1);
});
