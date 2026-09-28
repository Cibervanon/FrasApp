#!/usr/bin/env node
/**
 * Comprueba la codificacion de los ficheros de texto del repo. Falla con codigo 1.
 *
 * POR QUE ESTO ES UN SCRIPT Y NO "OJALA REVISARLO"
 * He revisado la codificacion a mano cuatro veces en tres tareas, y las cuatro
 * veces por el motivo equivocado. Dos veces por buscar solo CJK y dejar pasar
 * mojibake, y una vez por fiarme de lo que imprimia la consola de PowerShell, que
 * al recibir UTF-8 por un canal Latin-1 convierte una enye correcta en tres
 * caracteres de dibujo de caja, y al recibirlo bien muestra como roto un fichero
 * que esta entero. Casi se cuela un hallazgo FALSO en findings.md diciendo que
 * habia corrupcion donde no la habia. Este comentario no pega los caracteres
 * raros que dan el error: si los pegara, el propio check los detectaria a si
 * mismo, y ademas que se copien mal al leerlos es justo el problema.
 *
 * Por eso: bytes, nunca consola. Y por eso es un script, para que la comprobacion
 * no dependa de que alguien se acuerde.
 *
 * QUE BUSCA, Y POR QUE CADA COSA
 *
 * - BOM. UTF-8 con BOM hace que `dotenv` lea el nombre de la primera variable con
 *   un caracter invisible delante y no la encuentre.
 * - Controles C0 que no son tabulador ni salto de linea. Aparecen cuando un
 *   fichero se escribe con escapes de shell en vez de con una herramienta de
 *   edicion: en PowerShell, "\a" dentro de comillas dobles es BEL y "\f" es form
 *   feed. Me comio un bloque entero de tasks/todo.md antes de que este check
 *   existiera, y el check anterior no lo veia porque solo buscaba C1.
 * - C1 (U+0080-U+009F). Es la firma de UTF-8 leido como Latin-1 cuando la
 *   secuencia original era de 3 bytes: el punto medio (C2 B7) reinterpretado da
 *   U+00C2 y U+0082, y ese U+0082 cae en C1. Ojo: C1 NO ve la enye, porque
 *   "n" con tilde son 2 bytes (C3 B1) y su version corrupta es U+00C3 U+00B1, sin
 *   ningun C1 de por medio. Para eso esta la allowlist de mas abajo.
 * - U+FFFD, el caracter de reemplazo: bytes que no eran UTF-8 valido.
 * - CJK, Hangul y kana, con mensaje propio porque el sintoma mas claro de que se
 *   ha colado texto de otro idioma.
 * - Cualquier otro no-ASCII que no este en ALLOWED_NON_ASCII. Esto es lo que
 *   cubre los casos de 2 bytes como la enye.
 *
 * LO QUE NO BUSCA, Y POR QUE NO
 * No prohibe tildes ni tipografia no ascii legitima. Este repo escribe en espanol
 * y usa tildes con normalidad, asi que la regla es "que no haya corrupcion", no
 * "que no haya acentos". Lo que si queda fuera es el dibujo de caja y cualquier
 * otro simbolo no ascii sin motivo: en un repo de codigo no aparece solo.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");

/** Extensiones que se comprueban. El lockfile lo genera la herramienta, no se edita. */
const EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json", ".md", ".sql", ".toml", ".yml", ".yaml"]);

/** Directorios que no son codigo nuestro. `.claude` es la infraestructura del agente
 * (skills del entorno, no el producto): hay que poder actualizarla desde GitNexus sin
 * que tumbe el chequeo de encoding del proyecto. */
const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "dist", ".turbo", "coverage", ".turbo-cache", ".claude"]);

/**
 * Caracteres NO ASCII que son legitimos en este repo. Lo que no este aqui se
 * considera error.
 *
 * Allowlist y no heuristica, a proposito. Intente primero detectar mojibake con
 * "U+00C2 o U+00C3 seguidos de un caracter alto", y es incorrecto: U+00C3 es el
 * byte inicial de una secuencia UTF-8 de dos bytes, asi que `o` acentuada
 * (C3 B3) y su version corrupta (C3 83 C2 B3) empiezan igual. La heuristica
 * marco 60 sitios y no puede distinguir uno de otro sin saber la intencion.
 *
 * Una allowlist si es correcta por construccion: todo lo legitimo se declara, y
 * el mojibake no se declara porque nadie lo escribe a proposito. Se verifico que
 * el repo entero cae dentro de esta lista.
 */
const ALLOWED_NON_ASCII = new Set([
  0x00a9, // (c) copyright
  0x00ab, // <<  <<
  0x00bb, // >>  >>
  0x00b7, // · separador, el mas usado del repo
  0x00d3, // O acentuada
  0x00e1, // a acentuada
  0x00e9, // e acentuada
  0x00ed, // i acentuada
  0x00f1, // enye
  0x00f3, // o acentuada
  0x00fa, // u acentuada
  0x00fc, // u con dieresis
  0x2013, // - raya corta
  0x2014, // — raya larga
  0x2018, // ' comilla simple izquierda
  0x2019, // ' comilla simple derecha
  0x201c, // " comillas dobles izquierda
  0x201d, // " comillas dobles derecha
  0x20ac, // € euro
  0x2192, // -> flecha
  0x2264, // <= menor o igual
  0x2265, // >= mayor o igual
]);

const findings = [];

function report(file, line, column, code, message) {
  findings.push({ file, line, column, code, message });
}

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...walk(full));
    } else if (EXTENSIONS.has(extname(entry))) {
      found.push(full);
    }
  }
  return found;
}

for (const path of walk(ROOT)) {
  const rel = relative(ROOT, path).replaceAll("\\", "/");
  const bytes = readFileSync(path);

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    report(rel, 1, 1, "bom", "BOM UTF-8 al principio del fichero. Guardalo sin BOM.");
  }

  const text = bytes.toString("utf8");
  let line = 1;
  let column = 1;

  for (let i = 0; i < text.length; i += 1) {
    const cp = text.codePointAt(i);
    const char = text[i];
    if (char === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
    if (cp === undefined) continue;

    // C0: saltos de linea y tabulador son legitimos; cualquier otro control C0
    // no lo es. Aparecen cuando un fichero se escribe con escapes de shell en vez
    // de con una herramienta de edicion: en PowerShell, "\a" dentro de una cadena
    // con comillas dobles es BEL, "\f" es form feed y "\b" es backspace. Me comio
    // un bloque entero de tasks/todo.md antes de que este check existiera, asi que
    // se vigila. No hay ningun motivo legitimo para un BEL en un fichero de texto.
    if (cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) {
      report(
        rel,
        line,
        column,
        "c0",
        `Control C0 U+${cp.toString(16).toUpperCase().padStart(4, "0")}. ` +
          `Suele ser un escape de shell mal interpreted (\a, \f, \b, \v).`,
      );
      continue;
    }

    // Emojis y otros supplementary plane: se saltan dos unidades UTF-16.
    if (cp > 0xffff) {
      i += 1;
      continue;
    }

    if (cp === 0xfffd) {
      report(rel, line, column, "replacement", "U+FFFD. Los bytes no eran UTF-8 valido.");
      continue;
    }

    if (cp >= 0x80 && cp <= 0x9f) {
      report(
        rel,
        line,
        column,
        "c1",
        `C1 U+${cp.toString(16).toUpperCase().padStart(4, "0")}. Firma de UTF-8 leido como Latin-1.`,
      );
      continue;
    }

    // CJK y Hangul van con mensaje propio porque son el sintoma mas claro de que
    // se ha colado texto de otro idioma, y merecen decirselo al que lee.
    const isCjk =
      (cp >= 0x4e00 && cp <= 0x9fff) || // han
      (cp >= 0x3400 && cp <= 0x4dbf) || // han extension A
      (cp >= 0xac00 && cp <= 0xd7af) || // hangul silabico
      (cp >= 0x3040 && cp <= 0x30ff); // hiragana y katakana
    if (isCjk) {
      report(
        rel,
        line,
        column,
        "cjk",
        `CJK U+${cp.toString(16).toUpperCase().padStart(4, "0")}. Este repo escribe en espanol.`,
      );
      continue;
    }

    // Allowlist: cualquier no-ASCII que no se haya declarado es mojibake. C1 ya
    // ha salido antes con su mensaje especifico, aqui solo el resto.
    if (cp > 0x7f && !ALLOWED_NON_ASCII.has(cp)) {
      report(
        rel,
        line,
        column,
        "no-permitido",
        `U+${cp.toString(16).toUpperCase().padStart(4, "0")} no esta en la allowlist de caracteres ` +
          `legitimos. Casi siempre es mojibake; si de verdad es necesario, anadelo a ` +
          `ALLOWED_NON_ASCII en scripts/check-encoding.mjs con un comentario.`,
      );
    }
  }
}

if (findings.length === 0) {
  console.log("Codificacion correcta: sin BOM, sin controles C0, sin C1, sin CJK, sin U+FFFD, sin mojibake.");
  process.exit(0);
}

console.error(`\n${findings.length} problema(s) de codificacion:\n`);
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}:${f.column}  [${f.code}] ${f.message}`);
}
console.error("\nComprueba que el fichero este en UTF-8 SIN BOM y con tildes correctas.");
process.exit(1);
