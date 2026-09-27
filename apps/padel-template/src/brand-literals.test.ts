/**
 * Regla 1, en forma de test: ningun componente lleva dentro un color, un logo o un texto
 * de marca. Si esto falla, la plantilla lleva el club de demostracion hardcodeado y
 * cualquier cliente nuevo lo hereda sin darse cuenta.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE ESTE GUARD ESTA EN LA APP Y NO EN `packages/ui`
 *
 * La lista de nombres prohibidos es de ESTA instancia: son los clubes que existen en la
 * base de datos de desarrollo y en la seed. `ui` es un paquete que no sabe que existe
 * ningun club, asi que esa lista no tiene donde vivir alli. Ademas el guard tiene que
 * mirar las dos capas a la vez, porque una marca se puede colar por cualquiera de los dos
 * lados: un componente de `ui` con el azul del club, o una pagina de la app con su logo.
 * Un guard por capa dejaria media superficie sin vigilar.
 *
 * `packages/ui` tiene su propio guard en `src/boundaries.test.ts`, pero ese NO es este:
 * ese vigila los imports (que framework se puede meter en la capa). Este vigila los
 * literales.
 *
 * ---------------------------------------------------------------------------------------
 * QUE ESCANEA, Y QUE NO, Y POR QUE
 *
 * Si: `.ts`, `.tsx` y `.css` bajo `src/app/`, `src/components/` y `packages/ui/src/`. O sea
 * todo lo que se renderiza.
 *
 * No: los ficheros de test, ni `src/test/`, ni `src/lib/server/`.
 *
 * Los tests se excluyen porque necesitan valores de ejemplo, y un `#123456` como DATO de
 * entrada no es marca: es el valor que le pasa el servidor a un componente. El ejemplo
 * concreto es `db-harness.ts`, que siembra `#111111` y `#222222` como colores de los dos
 * tenants de prueba. Esos si son colores, y estan en la base de datos, no en el codigo que
 * se pinta.
 *
 * `src/lib/server/` se excluye porque no se renderiza: es SQL y JSON. Un color ahi no se ve
 * en pantalla. Si alguna vez se colara, el guard de `courts`/`branding` lo dira al fallar
 * el parseo del esquema, que es donde un color invalido se detecta de verdad.
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE ESTE GUARD NO PUEDE VER, Y POR QUE NO SE DISFRAZA DE OTRO
 *
 * NO detecta un color escrito como clase de Tailwind (`text-sky-500`, `bg-blue-700`).
 * Regex sobre texto no distingue "el azul de la marca" de "un azul de la paleta", y
 * prohibitir las clases de color por nombre dejaria sin poder escribir el estado de hover.
 * Lo que si se prohibe es el **hex**, que es justo la forma en que alguien escribe un
 * color de marca cuando sabe el color exacto, que es el caso peligroso.
 *
 * NO detecta un nombre de club que aun no exista en la base. La lista es cerrada. Por eso
 * la lista esta aqui, a mano, y no se lee de la base: si el club nuevo aparece, hay que
 * añadirlo a mano, y ese trabajo manual es el que hace visible el coste de dar de alta un
 * club en desarrollo.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/** Este fichero vive en `src/`, asi que su directorio es un nivel arriba de la app. */
const SRC_DIR = dirname(fileURLToPath(import.meta.url));
const APP_DIR = dirname(SRC_DIR);
const REPO_ROOT = resolve(APP_DIR, "..", "..");

const SELF = "brand-literals.test.ts";

/**
 * Nombres y slugs de club que existen en este repositorio.
 *
 * La lista es de clubs REALES de esta base, no inventados: si se inventara un nombre, el
 * guard pasaria mientras el nombre de verdad sigue escrito en un componente. Estos salen de
 * `supabase/seed.sql` y de los fixtures del harness y de los tests de T5.
 */
const NOMBRES_DE_CLUB: ReadonlyArray<string> = [
  "Club Padel Demo", // seed.sql
  "club-padel-demo", // seed.sql (slug, y el valor de TENANT_SLUG en .env.example)
  "Club A", // db-harness.ts
  "Club B", // db-harness.ts
  "club-a", // db-harness.ts (slug)
  "club-b", // db-harness.ts (slug)
  "Club T5d A", // route.db.test.ts de availability
  "Club T5d B", // route.db.test.ts de availability
  "Padel Demo", // subcadena de "Club Padel Demo", por si alguien lo escribe suelto
];

/**
 * Un color hex, en las tres formas que se escriben: 3 digitos, 6 digitos, y con alfa de 8.
 * No se admiten 4 (que es 3 + alfa, muy raro) ni con `%`.
 *
 * El `#` de aqui es un literal de la regla, y este fichero esta excluido de su propio
 * escaneo (`SELF`), asi que no se detecta a si mismo.
 */
const COLOR_HEX = /#[0-9a-fA-F]{3,8}\b/g;

/**
 * Quita los comentarios antes de buscar marca.
 *
 * Sin esto, el comentario que explica la regla ("no escribas #1a4d8f aqui") la violaria, y
 * la unica forma de salir seria callarse: escribir la regla sin nombrarla. Un guard que
 * obliga a no explicar por que se prohibe algo es un guard que empuja al silencio.
 *
 * LIMITACION CONOCIDA: stripper de verdad tentativa, no un parser. Si un string del codigo
 * contuviera `//` sin `:` delante, se comeria el resto de la linea. La app tiene URLs en
 * comentarios (`https://...`), y el `:` las protege. Es la misma limitacion que asumen los
 * guards de `core` y de `ui`.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...filesUnder(full));
    } else if (/\.(ts|tsx|css)$/.test(entry) && !entry.endsWith(".d.ts")) {
      found.push(full);
    }
  }
  return found;
}

/** Las tres carpetas que se renderizan, y el paquete `ui` de este monorepo. */
function renderizableFiles(): string[] {
  const dirs = [
    join(SRC_DIR, "app"),
    join(SRC_DIR, "components"),
    join(REPO_ROOT, "packages", "ui", "src"),
  ];
  return dirs
    .flatMap(filesUnder)
    .filter((path) => !path.endsWith(SELF) && !/\.test\.(ts|tsx)$/.test(path));
}

const FILES = renderizableFiles().map((path) => {
  const source = readFileSync(path, "utf8");
  return {
    path: relative(REPO_ROOT, path).replace(/\\/g, "/"),
    code: stripComments(source),
  };
});

/**
 * Todas las lineas que cumplen una condicion, para que el fallo diga la linea y no solo
 * el fichero. Se informa linea a linea porque "el nombre de club aparece en la app" no
 * lleva a ningun sitio; "app/page.tsx:3" si.
 */
function lineasQueCumplen(
  files: typeof FILES,
  condicion: (linea: string) => boolean,
): string[] {
  const out: string[] = [];
  for (const file of files) {
    file.code.split("\n").forEach((line, index) => {
      if (condicion(line)) {
        out.push(`${file.path}:${index + 1}  ${line.trim()}`);
      }
    });
  }
  return out;
}

/**
 * Quita todo lo que no es letra ni numero, y pasa a minusculas.
 *
 * ESTA FUNCION EXISTE PORQUE EL CONTROL NEGATIVO LA ENCONTRO NECESARIA. El guard
 * comparaba los nombres de club tal cual, asi que `Club Padel Demo` no cazaba con
 * `ClubPadelDemo`, que es justo el nombre que le pones a un componente sin pensar. Lo
 * mismo con `padel-demo`, `PADDEL_DEMO` y `padelDemo`. Los cuatro son el mismo club y
 * cuatro personas distintas los escriben asi.
 *
 * El coste de normalizar es que el patron es mas ancho: `clubpaddemo` tambien casaria
 * dentro de un identificador mas largo. Se acepta. Un falso positivo sobre una
 * concatenacion absurda te hace mirar una linea; un nombre de club hardcodeado llega a
 * produccion y lo ve el cliente.
 */
function normaliza(texto: string): string {
  return texto.toLowerCase().replace(/[^a-z0-9]/g, "");
}

describe("regla 1: cero marca literal en lo que se renderiza", () => {
  it("hay codigo que comprobar", () => {
    // Sin esto, un fallo al recoger ficheros daria un "0 tests" que parece verde, que es
    // como un RLS roto pasaria un test de RLS.
    expect(FILES.length).toBeGreaterThan(0);
  });

  it("no hay ningun color hex escrito a mano", () => {
    const offenders = lineasQueCumplen(FILES, (line) => {
      // `COLOR_HEX` es global, y `.test` con `/g` avanza el `lastIndex` entre llamadas: el
      // estado se reinicia a mano en vez de usar un patron nuevo por linea, que ademas
      // seria mas lento.
      const casada = COLOR_HEX.test(line);
      COLOR_HEX.lastIndex = 0;
      return casada;
    });
    // El mensaje nombra el fichero y la linea. Un "no" sin mas no dice donde arreglar.
    expect(offenders).toEqual([]);
  });

  for (const nombre of NOMBRES_DE_CLUB) {
    it(`no aparece el nombre de club "${nombre}"`, () => {
      // El texto se normaliza ANTES de buscar, y linea a linea, para que
      // `ClubPadelDemo`, `PADDEL_DEMO` y `club-padel-demo` caigan los tres.
      const needle = normaliza(nombre);
      const offenders = lineasQueCumplen(FILES, (linea) =>
        normaliza(linea).includes(needle),
      );
      expect(offenders).toEqual([]);
    });
  }

  it("los componentes reciben la marca por props, no la piden", () => {
    // Un componente que se importa la configuracion del tenant por su cuenta ya no es
    // presentacional: es una segunda fuente de la marca, y la regla 1 deja de depender de
    // que alguien pase la prop. El guard de imports de `ui` ya prohibe
    // `@frasapp/config-schema`; este prohibe el camino que queda, que es pedirla al servidor.
    const offenders = FILES.filter((file) =>
      /getServerSideProps|useTenant|fetchTenant|loadTenant/i.test(file.code),
    ).map((file) => file.path);
    expect(offenders).toEqual([]);
  });
});
