import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `tsc` solo emite JS y declaraciones: no copia CSS. Tailwind 4 se importa
 * desde el CSS, no desde JS, asi que este paso es el que hace que
 * `@frasapp/ui/styles.css` exista de verdad en `dist`.
 *
 * Los tokens de marca se declaran aqui como fallback. El tenant los sobreescribe
 * en runtime desde `tenant_branding`; por eso son `var(--brand-*, fallback)` y no
 * un color fijo.
 */
const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "..", "src", "styles.css");
const dest = join(here, "..", "dist", "styles.css");

await mkdir(dirname(dest), { recursive: true });
await copyFile(src, dest);

console.log("styles.css copiado a dist");
