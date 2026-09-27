import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { clearTenantCache, resolveTenantId } from "./tenant";
import { baseQuery, tenantQuery } from "./db";
import {
  prepareDatabase,
  releaseDatabaseLease,
  TENANT_IDS,
  withAdmin,
} from "../../test/db-harness";

/**
 * T5a: la capa de servidor entra en la base como el ROL del tenant, no como superusuario.
 *
 * POR QUE ESTE FICHERO EXISTE
 * `/api/courts` y `/api/availability` son publicas (spec 5.1): las llama alguien sin
 * sesion, asi que no hay JWT y `current_tenant_id()` es null. Con las 8 politicas de T4,
 * que son `to authenticated`, eso devuelve CERO filas: el catalogo del club salia vacio.
 *
 * La decision (del usuario, no mia) es que el handler resuelve el tenant y consulta con el
 * rol `authenticated` y un JWT de servidor que solo lleva `tenant_id`. Asi la RLS sigue
 * siendo el unico punto de aislamiento.
 *
 * Lo que estos tests protegen NO es "que la consulta funcione". Es que `tenantQuery` no
 * sea una puerta trasera: si por lo que sea acabara corriendo como superusuario, TODO lo
 * de arriba valdria y un endpoint leakearia el catalogo de otro club sin que nada
 * fallara. Por eso el primero comprueba `current_user` y el ultimo que un tenant
 * inexistente no ve NADA en vez de ver el mundo entero.
 */

const COURT_A = "00000000-0000-4000-8000-0000000005a1";
const COURT_B = "00000000-0000-4000-8000-0000000005b1";

/** Tenant que no existe en la base. Un UUID bien formado y sin fila. */
const TENANT_FANTASMA = "00000000-0000-4000-8000-00000000dead";

/**
 * Lo que tiene que contener el error, en ES o en EN.
 *
 * Deliberadamente solo mira la palabra `uuid`, y no la frase entera: el objeto del test
 * es que el rechazo SUENE (fallar ruidosamente, no devolver un catalogo vacio en
 * silencio), no memorizar la redaccion de Postgres. Unico error de uuid plausible aqui es
 * el cast de `current_tenant_id()`, porque no hay otra conversion a uuid en el camino.
 */
const CLAIMS_ERROR = /uuid/i;

beforeAll(async () => {
  await prepareDatabase();

  // Fixtures COMPROMETIDAS, a diferencia de los demas ficheros de la suite, que siembran
  // dentro de una transaccion que se revierte. Aqui hace falta commit porque
  // `tenantQuery` abre su propia conexion desde un pool, y una conexion no ve lo que otra
  // tiene sin confirmar. Por eso `afterAll` las borra de forma explicita: si este fichero
  // muere a mitad, `afterAll` tampoco corre y `courts` se queda con filas que el siguiente
  // fichero puede encontrar. Se mitiga con IDs fijos y reconocibles.
  await withAdmin(async (db) => {
    for (const [id, tenant] of [
      [COURT_A, TENANT_IDS.a],
      [COURT_B, TENANT_IDS.b],
    ] as const) {
      await db.query(
        `insert into public.courts
           (id, tenant_id, name, court_type, base_price_cents, default_duration_min,
            min_duration_min, max_duration_min)
         values ($1, $2, $3, 'cristal', 1200, 90, 60, 180)
         on conflict (id) do update set name = excluded.name`,
        [id, tenant, id === COURT_A ? "Pista T5-A" : "Pista T5-B"],
      );
    }
  });
});

afterAll(async () => {
  clearTenantCache();
  await withAdmin(async (db) => {
    await db.query(`delete from public.courts where id = any($1)`, [[COURT_A, COURT_B]]);
  });
  await releaseDatabaseLease();
});

describe("T5a: la capa de servidor consulta con el rol del tenant", () => {
  it("corre como `authenticated`, no como superusuario", async () => {
    const rows = await tenantQuery<{ current_user: string }>(
      TENANT_IDS.a,
      `select current_user`,
    );
    // La asercion que hace que este fichero signifique algo. Con el rol `postgres` las
    // RLS no aplican y un aislamiento roto pasaria el resto de estos tests en verde.
    expect(rows[0]?.current_user).toBe("authenticated");
  });

  it("los claims llevan el tenant resuelto y ningun usuario", async () => {
    const rows = await tenantQuery<{ claims: string }>(
      TENANT_IDS.a,
      `select current_setting('request.jwt.claims', true) as claims`,
    );
    const claims = JSON.parse(rows[0]?.claims ?? "{}") as Record<string, unknown>;

    expect(claims.tenant_id).toBe(TENANT_IDS.a);
    // `sub` identifies a PERSON. Un visitante sin sesion no es nadie, y poner un `sub`
    // inventado seria fabricar una identidad. Si algun dia hace falta, tiene que venir
    // de la sesion real, no de aqui.
    expect(claims.sub).toBeUndefined();
  });

  it("un endpoint publico ve las pistas de SU club y nada mas", async () => {
    const rows = await tenantQuery<{ id: string; tenant_id: string }>(
      TENANT_IDS.a,
      `select id, tenant_id from public.courts order by id`,
    );

    // Existe la fila del tenant A...
    expect(rows.map((r) => r.id)).toContain(COURT_A);
    // ...y la del tenant B es INVISIBLE, no filtrada despues. La RLS no devuelve la fila
    // asi que el handler ni la llega a ver, y no puede imprimirla por error.
    expect(rows.map((r) => r.id)).not.toContain(COURT_B);
    expect(rows.every((r) => r.tenant_id === TENANT_IDS.a)).toBe(true);
  });

  it("una pista de otro tenant no existe: 0 filas, para poder responder 404", async () => {
    const rows = await tenantQuery<{ id: string }>(
      TENANT_IDS.a,
      `select id from public.courts where id = $1`,
      [COURT_B],
    );
    // Esto es lo que convierte "no la veo" en "no existe". Un `where id = $1` sin RLS
    // devolveria la fila del otro club, y el endpoint tendria que adivinar si responde
    // 403 o 404. Con RLS la combinacion (tenant A, pista de B) no es un estado
    // observable: es la misma respuesta que un id que no existe en ningun sitio.
    expect(rows).toHaveLength(0);
  });

  it("un tenant que no existe no ve NADA, en vez de ver el mundo entero", async () => {
    const rows = await tenantQuery<{ id: string }>(
      TENANT_FANTASMA,
      `select id from public.courts`,
    );
    // El fallo silencioso que esto evita: que una regla de RLS mal escrita devuelva
    // `true` con un tenant nulo, y entonces cualquier `tenant_id` desconocido viera el
    // catalogo completo. Aqui sale 0, que es lo unico aceptable.
    expect(rows).toHaveLength(0);
  });

  it("un tenant_id que no es un uuid falla ruidosamente en vez de devolver filas", async () => {
    // Un `tenant_id` con basura tiene que ROMPER, no devolver un catalogo vacio: si
    // rompe, el error dice "aqui hay un bug"; si devuelve 0 filas, parece que el club no
    // tiene pistas y se esconde un fallo.
    await expect(
      tenantQuery("no-es-un-uuid", `select id from public.courts`),
    ).rejects.toThrow(CLAIMS_ERROR);
  });
});

describe("T5a: el tenant sale de la variable de entorno de la instancia", () => {
  const original = process.env["TENANT_SLUG"];

  afterAll(() => {
    if (original === undefined) delete process.env["TENANT_SLUG"];
    else process.env["TENANT_SLUG"] = original;
    clearTenantCache();
  });

  it("resuelve el slug de TENANT_SLUG al uuid de esa fila", async () => {
    process.env["TENANT_SLUG"] = "club-b";
    clearTenantCache();
    await expect(resolveTenantId()).resolves.toBe(TENANT_IDS.b);
  });

  it("memoiza hasta que se limpia la cache", async () => {
    process.env["TENANT_SLUG"] = "club-a";
    clearTenantCache();
    await expect(resolveTenantId()).resolves.toBe(TENANT_IDS.a);

    // El patron es el que importa: cambiar la variable SIN limpiar la cache NO cambia el
    // resultado. Si asi fuera, no habria cache. Y luego limpiarlo SI cambia, que es lo que
    // hace que `clearTenantCache` exista y no sea decorativo.
    process.env["TENANT_SLUG"] = "club-b";
    await expect(resolveTenantId()).resolves.toBe(TENANT_IDS.a);

    clearTenantCache();
    await expect(resolveTenantId()).resolves.toBe(TENANT_IDS.b);
  });

  it("sin TENANT_SLUG falla con un mensaje que dice que hacer", async () => {
    delete process.env["TENANT_SLUG"];
    clearTenantCache();
    await expect(resolveTenantId()).rejects.toThrow(/TENANT_SLUG/);
  });

  it("un slug que no existe en la base falla en vez de devolver un tenant cualquiera", async () => {
    process.env["TENANT_SLUG"] = "club-que-no-existe";
    clearTenantCache();
    // Si esto devolviera algo, el endpoint serviria el catalogo del primer club que
    // encuentre. Que no haya fila es un error de despliegue y se dice.
    await expect(resolveTenantId()).rejects.toThrow(/no existe|no esta/i);
  });

  it("un tenant_id que no es uuid no es un slug: la busqueda no puede devolver una fila", async () => {
    // `slug` tiene un `check` de formato en la tabla, asi que un UUID no puede estar
    // slugueado. Este test deja escrito que el fallback "si no hay slug, uso el
    // TENANT_ID" NO existe a proposito: aceptarlo daria dos fuentes de verdad para la
    // misma cosa, y la que se configure por error es la que gana.
    const rows = await baseQuery<{ found: boolean }>(
      `select exists(select 1 from public.tenants where slug = $1) as found`,
      ["00000000-0000-4000-8000-00000000000a"],
    );
    expect(rows[0]?.found).toBe(false);
  });
});
