import { describe, expect, it } from "vitest";

import { subDeCabecera, subDeSesion, subDeValor } from "./session";

/**
 * T11: `subDeSesion` lee la identidad de la cookie `frasapp_session`.
 *
 * PURO, SIN BASE: este fichero no importa ni `db` ni `tenant`. La identidad de la peticion
 * se decide ANTES de abrir ninguna conexion, de forma que una cookie mal formada cuesta
 * cero accesos a Postgres: el 401 es inmediato. Por eso es un test unitario de `pnpm test`
 * y no uno de `.db.test.ts`.
 *
 * LIMITE, EN VOZ ALTA: leer el payload de un JWT no es verificar una firma. `subDeSesion`
 * es la puerta que deja entrar un `sub` cuando la futura sesion de Supabase la valide por
 * firma; hasta entonces un token inventado entra igual. Lo que estos tests fijan es el
 * FORMATO que tiene que tener la cookie para que valga, sin afirmar que sea autentica.
 */

/** El `sub` fijo con el que se firman los tokens de prueba. */
const SUB = "00000000-0000-4000-8000-0000000000f1";

/** Monta un JWT de tres partes con el payload dado, sin firma real. */
function tokenCon(payload: string): string {
  const base64url = Buffer.from(payload).toString("base64url");
  return `cabecera.${base64url}.firma`;
}

/** Una peticion que llega con la cookie puesta. */
function peticionCon(cookie: string): Request {
  return new Request("http://localhost/api/holds", {
    method: "POST",
    headers: { cookie },
  });
}

describe("T11: la identidad sale de la cookie de sesion", () => {
  it("sin cookie no hay sesion", () => {
    expect(subDeSesion(peticionCon("otra=snack"))).toBeNull();
  });

  it("un JWT de tres partes con `sub` uuid devuelve ese sub", () => {
    const token = tokenCon(JSON.stringify({ sub: SUB }));
    expect(subDeSesion(peticionCon(`frasapp_session=${token}`))).toBe(SUB);
  });

  it("la encuentra entre otras cookies, en cualquier posicion", () => {
    const token = tokenCon(JSON.stringify({ sub: SUB }));
    expect(subDeSesion(peticionCon(`preferencias=oscuro; frasapp_session=${token}; tema=verde`))).toBe(SUB);
  });

  it("un token con dos partes no es un JWT: sin sesion", () => {
    const casiToken = `${Buffer.from(JSON.stringify({ sub: SUB })).toString("base64url")}.firma`;
    expect(subDeSesion(peticionCon(`frasapp_session=${casiToken}`))).toBeNull();
  });

  it("un payload que no es JSON prudentemente no es una sesion", () => {
    const token = tokenCon("esto-no-es-json");
    expect(subDeSesion(peticionCon(`frasapp_session=${token}`))).toBeNull();
  });

  it("un `sub` que no es uuid no sirve de identidad", () => {
    const token = tokenCon(JSON.stringify({ sub: "no-es-un-uuid" }));
    expect(subDeSesion(peticionCon(`frasapp_session=${token}`))).toBeNull();
  });

  it("sin `sub` en el token no hay sesion", () => {
    const token = tokenCon(JSON.stringify({ otro: "campo" }));
    expect(subDeSesion(peticionCon(`frasapp_session=${token}`))).toBeNull();
  });

  it("un `sub` que no es string no sirve de identidad", () => {
    const token = tokenCon(JSON.stringify({ sub: 4711 }));
    expect(subDeSesion(peticionCon(`frasapp_session=${token}`))).toBeNull();
  });

  it("un valor de cookie mal formado no tira la peticion", () => {
    expect(subDeSesion(peticionCon("frasapp_session=%%%no-decodificable%%%"))).toBeNull();
  });

  it("un valor url-encoded de mas se limpia antes de leer", () => {
    const token = tokenCon(JSON.stringify({ sub: SUB }));
    expect(subDeSesion(peticionCon(`frasapp_session=${encodeURIComponent(token)}`))).toBe(SUB);
  });
});

describe("T13: subDeCabecera lee la misma cookie sin fabricar una peticion", () => {
  const token = tokenCon(JSON.stringify({ sub: SUB }));

  it("una cabecera cruda con la cookie devuelve el sub", () => {
    expect(subDeCabecera(`preferencias=oscuro; frasapp_session=${token}`)).toBe(SUB);
  });

  it("null o sin la cookie devuelve null", () => {
    expect(subDeCabecera(null)).toBeNull();
    expect(subDeCabecera("otra=snack")).toBeNull();
  });

  it("un valor url-encoded de mas se limpia antes de leer", () => {
    expect(subDeCabecera(`frasapp_session=${encodeURIComponent(token)}`)).toBe(SUB);
  });
});

describe("T13: subDeValor lee el valor que devuelve next/headers.cookies()", () => {
  const token = tokenCon(JSON.stringify({ sub: SUB }));

  it("el valor desnombrado de la cookie devuelve el sub", () => {
    expect(subDeValor(token)).toBe(SUB);
  });

  it("null o vacio devuelve null", () => {
    expect(subDeValor(null)).toBeNull();
    expect(subDeValor("")).toBeNull();
  });
});