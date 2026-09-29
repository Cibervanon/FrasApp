import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { POST } from "./route";
import { DELETE as liberarHold } from "./[id]/route";
import { closePool } from "../../../lib/server/db";
import { clearTenantCache } from "../../../lib/server/tenant";
import { prepareDatabase, releaseDatabaseLease, withAdmin } from "../../../test/db-harness.js";

/**
 * T14c E3: el contrato HTTP de la edad y del tutor en `POST /api/holds`.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE OTRO FICHERO Y NO MAS CASOS EN EL DE T11
 *
 * El de T11 (`route.db.test.ts`) prueba el ciclo del hold: precio, 409, 404, cookie. Este
 * prueba OTRA cosa, que es un contrato con codigos de status y un `code` de cuerpo
 * (`faltan_datos_tutor`, `tutor_no_requerido`) que una pantalla va a leer para decidir que
 * formulario pintar. Mezclarlos en un fichero de 12 casos mas 15 haria que cada fallo nou
 * diga de que tarea es, y este repo ya tiene un fichero por tarea.
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE ESTA SEPARADO A PROPOSITO
 *
 * Hay dos tipos de "no vale" y tienen status distintos a proposito:
 *
 *   - La FORMA la mira la ruta: fecha que no parece una fecha, tutor a medias, vinculo que
 *     no es del enum. 400 con el campo en el mensaje.
 *   - El FONDO lo mira `holds.ts`, con el dia del club: fecha que no existe en el
 *     calendario, fecha de futuro, y el "es menor" de verdad. 400 o 422.
 *
 * Un 422 (menor sin tutor) NO es un 400: el cuerpo esta bien escrito, lo que falta es un
 * dato. Y el 400 de fecha no es un 422: ahi el socio ha escrito mal.
 *
 * Los dos tenants: uno sin `min_player_age` (el default de la columna, que es 18) y otro con
 * 21, para que el umbral se vea venir de la fila y no del codigo.
 */

const TENANT_POR_DEFECTO = "00000000-0000-4000-8000-0000000006c0";
const TENANT_ALTO = "00000000-0000-4000-8000-0000000006c1";
const SLUG_DEFECTO = "club-t14c-r-defecto";
const SLUG_ALTO = "club-t14c-r-alto";

const PISTA = "00000000-0000-4000-8000-0000000006c2";
const PISTA_ALTA = "00000000-0000-4000-8000-0000000006c3";

const USUARIO = "00000000-0000-4000-8000-0000000006c4";

const TENANTES = [TENANT_POR_DEFECTO, TENANT_ALTO];
const PISTAS = [PISTA, PISTA_ALTA];

const ZONA = "Europe/Madrid";
const PRECIO_BASE = 1200;

/** El dia que comparten los casos que NO deben escribir nada. */
const DIA_SIN_ESCRITURA = "2026-12-10T08:00";

function placeholders(ids: readonly string[]): string {
  return ids.map((_, index) => `$${index + 1}`).join(", ");
}

function cookieDe(sub: string): string {
  const payload = Buffer.from(JSON.stringify({ sub })).toString("base64url");
  return `frasapp_session=cabecera.${payload}.firma`;
}

/** Resta anos con aritmetica de calendario, sin `Date` y sin el helper privado de `core`. */
function restarAnios(fecha: string, anos: number): string {
  const ano = Number(fecha.slice(0, 4)) - anos;
  const mes = fecha.slice(5, 7);
  const dia = fecha.slice(8, 10);
  if (mes === "02" && dia === "29") return `${ano}-02-28`;
  return `${ano}-${mes}-${dia}`;
}

async function hoyDelClub(): Promise<string> {
  let hoy = "";
  await withAdmin(async (db) => {
    const filas = await db.query<{ hoy: string }>(
      `select to_char(now() at time zone $1, 'YYYY-MM-DD') as hoy`,
      [ZONA],
    );
    hoy = filas.rows[0]?.hoy ?? "";
  });
  return hoy;
}

function apuntarA(slug: string): void {
  process.env["TENANT_SLUG"] = slug;
  clearTenantCache();
}

interface RespuestaJson {
  error?: string;
  code?: string;
  id?: string;
  isMinor?: boolean;
}

async function pedir(
  cuerpo: unknown,
  cookie: string | null = cookieDe(USUARIO),
): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cookie !== null) headers["cookie"] = cookie;
  return POST(
    new Request("http://localhost:3000/api/holds", {
      method: "POST",
      headers,
      body: typeof cuerpo === "string" ? cuerpo : JSON.stringify(cuerpo),
    }),
  );
}

/** Un cuerpo de adulto valido, para que cada caso cambie solo lo que quiere cambiar. */
function cuerpoBase(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    courtId: PISTA,
    startsAt: "2026-12-01T08:00",
    numPlayers: 4,
    playerName: "Socio",
    playerBirthDate: "1990-01-01",
    ...extra,
  };
}

async function filasEn(pista: string): Promise<number> {
  let total = 0;
  await withAdmin(async (db) => {
    const filas = await db.query<{ total: string }>(
      `select count(*)::text as total from public.bookings where court_id = $1`,
      [pista],
    );
    total = Number(filas.rows[0]?.total ?? "0");
  });
  return total;
}

beforeAll(async () => {
  await prepareDatabase();

  await withAdmin(async (db) => {
    await db.query(
      `delete from public.bookings where court_id in (${placeholders(PISTAS)})`,
      [...PISTAS],
    );
    await db.query(
      `delete from public.court_blocks where court_id in (${placeholders(PISTAS)})`,
      [...PISTAS],
    );
    await db.query(`delete from public.courts where id in (${placeholders(PISTAS)})`, [...PISTAS]);
    await db.query(`delete from public.tenants where id in (${placeholders(TENANTES)})`, [
      ...TENANTES,
    ]);
    await db.query(`delete from auth.users where id = $1`, [USUARIO]);

    // El primero se inserta SIN `min_player_age`, a proposito: lo que se prueba abajo es el
    // DEFAULT de la columna (18), y ponerlo a mano no probaria nada. El segundo lo pone a 21,
    // que es el otro extremo del rango que permite el CHECK.
    await db.query(
      `insert into public.tenants (id, name, slug, timezone) values ($1, 'T14c ruta', $2, $3)`,
      [TENANT_POR_DEFECTO, SLUG_DEFECTO, ZONA],
    );
    await db.query(
      `insert into public.tenants (id, name, slug, timezone, min_player_age)
       values ($1, 'T14c alto', $2, $3, 21)`,
      [TENANT_ALTO, SLUG_ALTO, ZONA],
    );
    await db.query(
      `insert into public.courts
         (id, tenant_id, name, court_type, base_price_cents, sort_order,
          default_duration_min, min_duration_min, max_duration_min)
       values
         ($1, $3, 'Pista T14c', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180),
         ($2, $4, 'Pista T14c alta', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180)`,
      [PISTA, PISTA_ALTA, TENANT_POR_DEFECTO, TENANT_ALTO],
    );
    await db.query(`insert into auth.users (id, email) values ($1, 'socio-t14c-ruta@test')`, [
      USUARIO,
    ]);
  });

  // Sin esto, la ruta resolveria el club de `.env.local` (`club-padel-demo`) y todas las
  // pistas de este fichero serian de otro tenant: 404 en los casos que deberian ser 201.
  apuntarA(SLUG_DEFECTO);
});

afterAll(async () => {
  delete process.env["TENANT_SLUG"];
  clearTenantCache();
  await withAdmin(async (db) => {
    await db.query(
      `delete from public.bookings where court_id in (${placeholders(PISTAS)})`,
      [...PISTAS],
    );
    await db.query(
      `delete from public.court_blocks where court_id in (${placeholders(PISTAS)})`,
      [...PISTAS],
    );
    await db.query(`delete from public.courts where id in (${placeholders(PISTAS)})`, [...PISTAS]);
    await db.query(`delete from auth.users where id = $1`, [USUARIO]);
    await db.query(`delete from public.tenants where id in (${placeholders(TENANTES)})`, [
      ...TENANTES,
    ]);
  });
  await closePool();
  await releaseDatabaseLease();
});

describe("T14c E3: la fecha de nacimiento es obligatoria y tiene que existir", () => {
  it("sin `playerBirthDate` responde 400 y no crea nada", async () => {
    const antes = await filasEn(PISTA);
    const cuerpo = cuerpoBase();
    delete cuerpo["playerBirthDate"];

    const respuesta = await pedir(cuerpo);

    expect(respuesta.status).toBe(400);
    const cuerpoJson = (await respuesta.json()) as RespuestaJson;
    expect(cuerpoJson.error).toContain("playerBirthDate");
    expect(await filasEn(PISTA)).toBe(antes);
  });

  it("una fecha con forma rara responde 400 y dice cual es el problema", async () => {
    const antes = await filasEn(PISTA);

    for (const mala of ["ayer", "20150301", "2015-13-45", "01-01-1990", "1990-1-1", ""]) {
      const respuesta = await pedir(
        cuerpoBase({ startsAt: DIA_SIN_ESCRITURA, playerBirthDate: mala }),
      );
      expect(respuesta.status, `fecha '${mala}'`).toBe(400);
      expect(((await respuesta.json()) as RespuestaJson).error).toContain("playerBirthDate");
    }

    expect(await filasEn(PISTA)).toBe(antes);
  });

  it("una fecha que no existe en el calendario responde 400 (la mira el servidor)", async () => {
    const antes = await filasEn(PISTA);

    // Pasa la forma `YYYY-MM-DD` de la ruta, y solo el calendario puede decir que no.
    for (const imposible of ["2015-02-30", "2015-04-31", "2015-02-29"]) {
      const respuesta = await pedir(
        cuerpoBase({ startsAt: DIA_SIN_ESCRITURA, playerBirthDate: imposible }),
      );
      expect(respuesta.status, `fecha '${imposible}'`).toBe(400);
      expect(((await respuesta.json()) as RespuestaJson).error).toContain("calendario");
    }

    expect(await filasEn(PISTA)).toBe(antes);
  });

  it("una fecha de futuro responde 400", async () => {
    const antes = await filasEn(PISTA);

    // 2099 en vez de "manana": el test no necesita que sea maana, necesita que sea futuro,
    // y una fecha fija no depende de que dia se ejecute ni de aritmetica de dias.
    const respuesta = await pedir(
      cuerpoBase({ startsAt: DIA_SIN_ESCRITURA, playerBirthDate: "2099-01-01" }),
    );

    expect(respuesta.status).toBe(400);
    expect(((await respuesta.json()) as RespuestaJson).error).toContain("futuro");
    expect(await filasEn(PISTA)).toBe(antes);
  });
});

describe("T14c E3: menor sin tutor es 422, y el cuerpo no puede decir lo contrario", () => {
  it("un menor sin tutor recibe 422 con `code` y no se escribe nada", async () => {
    const hoy = await hoyDelClub();
    const antes = await filasEn(PISTA);

    const respuesta = await pedir(
      cuerpoBase({
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: restarAnios(hoy, 15),
      }),
    );

    expect(respuesta.status).toBe(422);
    const cuerpoJson = (await respuesta.json()) as RespuestaJson;
    expect(cuerpoJson.code).toBe("faltan_datos_tutor");
    expect(cuerpoJson.error).toContain("tutor");
    expect(await filasEn(PISTA)).toBe(antes);
  });

  it("`isMinor: false` en el cuerpo NO convence al servidor: el mismo 422", async () => {
    const hoy = await hoyDelClub();
    const antes = await filasEn(PISTA);

    const respuesta = await pedir(
      cuerpoBase({
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: restarAnios(hoy, 15),
        isMinor: false,
      }),
    );

    expect(respuesta.status).toBe(422);
    expect(((await respuesta.json()) as RespuestaJson).code).toBe("faltan_datos_tutor");
    expect(await filasEn(PISTA)).toBe(antes);
  });

  it("tampoco con `is_minor: false` (el nombre de la columna) ni con `guardian_consent_at`", async () => {
    const hoy = await hoyDelClub();
    const antes = await filasEn(PISTA);

    const respuesta = await pedir(
      cuerpoBase({
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: restarAnios(hoy, 15),
        is_minor: false,
        guardian_consent_at: "1999-01-01T00:00:00.000Z",
      }),
    );

    expect(respuesta.status).toBe(422);
    expect(await filasEn(PISTA)).toBe(antes);
  });

  it("un menor con tutor entra y el 201 trae `isMinor` calculado por el servidor", async () => {
    const hoy = await hoyDelClub();

    const respuesta = await pedir(
      cuerpoBase({
        startsAt: "2026-12-02T08:00",
        playerBirthDate: restarAnios(hoy, 15),
        tutor: {
          guardianName: "Marta Lopez",
          guardianEmail: "marta@example.test",
          guardianPhone: "600000000",
          guardianRelation: "madre",
        },
      }),
    );

    expect(respuesta.status).toBe(201);
    const cuerpoJson = (await respuesta.json()) as RespuestaJson;
    expect(cuerpoJson.isMinor).toBe(true);

    await withAdmin(async (db) => {
      const filas = await db.query<{
        is_minor: boolean;
        guardian_name: string;
        guardian_consent_at: string;
        segundos: number;
      }>(
        `select is_minor, guardian_name, to_char(guardian_consent_at, 'YYYY-MM-DD') as guardian_consent_at,
                extract(epoch from (guardian_consent_at - now()))::int as segundos
           from public.bookings where id = $1`,
        [cuerpoJson.id ?? ""],
      );
      const fila = filas.rows[0];
      expect(fila?.is_minor).toBe(true);
      expect(fila?.guardian_name).toBe("Marta Lopez");
      // La fecha del consentimiento la pone la base, no el cuerpo: no es 1999.
      expect(fila?.guardian_consent_at).not.toBe("1999-01-01");
      expect(Math.abs(fila?.segundos ?? 9999)).toBeLessThan(60);
    });
  });
});

describe("T14c E3: la forma del tutor y el caso de que sobre", () => {
  it("un tutor con un campo de menos es 400 del campo que falta, no 422", async () => {
    const hoy = await hoyDelClub();
    const antes = await filasEn(PISTA);

    const respuesta = await pedir(
      cuerpoBase({
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: restarAnios(hoy, 15),
        tutor: { guardianName: "Marta", guardianEmail: "marta@example.test" },
      }),
    );

    expect(respuesta.status).toBe(400);
    expect(((await respuesta.json()) as RespuestaJson).error).toContain("guardianPhone");
    expect(await filasEn(PISTA)).toBe(antes);
  });

  it("un vinculo que no es del enum es 400 y nombra los cuatro que si valen", async () => {
    const hoy = await hoyDelClub();
    const antes = await filasEn(PISTA);

    const respuesta = await pedir(
      cuerpoBase({
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: restarAnios(hoy, 15),
        tutor: {
          guardianName: "Marta",
          guardianEmail: "marta@example.test",
          guardianPhone: "600000000",
          guardianRelation: "abuela",
        },
      }),
    );

    expect(respuesta.status).toBe(400);
    const error = ((await respuesta.json()) as RespuestaJson).error ?? "";
    expect(error).toContain("tutor_legal");
    expect(await filasEn(PISTA)).toBe(antes);
  });

  it("un adulto con tutor completo es 400 `tutor_no_requerido` y no se escribe nada", async () => {
    const antes = await filasEn(PISTA);

    const respuesta = await pedir(
      cuerpoBase({
        startsAt: DIA_SIN_ESCRITURA,
        tutor: {
          guardianName: "Marta",
          guardianEmail: "marta@example.test",
          guardianPhone: "600000000",
          guardianRelation: "madre",
        },
      }),
    );

    expect(respuesta.status).toBe(400);
    expect(((await respuesta.json()) as RespuestaJson).code).toBe("tutor_no_requerido");
    expect(await filasEn(PISTA)).toBe(antes);
  });
});

describe("T14c E3: el umbral sale de la fila del club", () => {
  it("un adulto entra y el 201 dice `isMinor: false` aunque el cuerpo diga `true`", async () => {
    const respuesta = await pedir(
      cuerpoBase({ startsAt: "2026-12-03T08:00", isMinor: true }),
    );

    expect(respuesta.status).toBe(201);
    expect(((await respuesta.json()) as RespuestaJson).isMinor).toBe(false);
  });

  it("un club sin configurar usa el default de la columna: 18", async () => {
    const hoy = await hoyDelClub();
    const antes = await filasEn(PISTA);
    apuntarA(SLUG_DEFECTO);

    // Con 17 no se entra, y sin `min_player_age` en la fila eso solo puede ser el 18.
    const menor = await pedir(
      cuerpoBase({
        startsAt: DIA_SIN_ESCRITURA,
        courtId: PISTA,
        playerBirthDate: restarAnios(hoy, 17),
      }),
    );
    expect(menor.status).toBe(422);

    // Y con 18, si.
    const adulto = await pedir(
      cuerpoBase({ startsAt: "2026-12-04T08:00", playerBirthDate: restarAnios(hoy, 18) }),
    );
    expect(adulto.status).toBe(201);
    expect(((await adulto.json()) as RespuestaJson).isMinor).toBe(false);
    expect(await filasEn(PISTA)).toBe(antes + 1);
  });

  it("un club con umbral 21 pide tutor a quien con 18 no se la pedia", async () => {
    const hoy = await hoyDelClub();
    const antesAlta = await filasEn(PISTA_ALTA);
    apuntarA(SLUG_ALTO);

    // 19 anos: adulto con el umbral de por defecto, menor con el de este club.
    const conDiecinueve = await pedir(
      cuerpoBase({
        courtId: PISTA_ALTA,
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: restarAnios(hoy, 19),
      }),
    );
    expect(conDiecinueve.status).toBe(422);
    expect(await filasEn(PISTA_ALTA)).toBe(antesAlta);

    // Con 19 y su tutor, si: a 19 anos con umbral 21 hay que ser menor, y el mismo cuerpo
    // con el umbral de por defecto (18) habria sido un 400 `tutor_no_requerido`.
    const conTutor = await pedir(
      cuerpoBase({
        courtId: PISTA_ALTA,
        startsAt: "2026-12-08T08:00",
        playerBirthDate: restarAnios(hoy, 19),
        tutor: {
          guardianName: "Marta",
          guardianEmail: "marta@example.test",
          guardianPhone: "600000000",
          guardianRelation: "madre",
        },
      }),
    );
    expect(conTutor.status).toBe(201);
    expect(((await conTutor.json()) as RespuestaJson).isMinor).toBe(true);

    apuntarA(SLUG_DEFECTO);
  });
});

describe("T14c E3: liberar un hold no tira los datos del menor", () => {
  it("la fila conserva fecha y tutor al cancelar (el borrado es de T19)", async () => {
    const hoy = await hoyDelClub();
    const nacimiento = restarAnios(hoy, 15);

    const creado = await pedir(
      cuerpoBase({
        startsAt: "2026-12-09T08:00",
        playerBirthDate: nacimiento,
        tutor: {
          guardianName: "Marta Lopez",
          guardianEmail: "marta@example.test",
          guardianPhone: "600000000",
          guardianRelation: "madre",
        },
      }),
    );
    expect(creado.status).toBe(201);
    const id = ((await creado.json()) as RespuestaJson).id ?? "";

    const liberado = await liberarHold(
      new Request(`http://localhost:3000/api/holds/${id}`, {
        method: "DELETE",
        headers: { cookie: cookieDe(USUARIO) },
      }),
      { params: Promise.resolve({ id }) },
    );
    expect(liberado.status).toBe(200);

    // Cancelar es cambiar `status`. Si un dia esto se convierte en un DELETE de verdad, el
    // RGPD del menor se va con la fila, y por eso el borrado es una tarea aparte (T19) y
    // este test va a fallar ese dia, que es lo que tiene que pasar.
    await withAdmin(async (db) => {
      const filas = await db.query<{
        status: string;
        player_birth_date: string;
        guardian_name: string;
        guardian_consent_at: string;
      }>(
        `select status, to_char(player_birth_date, 'YYYY-MM-DD') as player_birth_date,
                guardian_name, to_char(guardian_consent_at, 'YYYY-MM-DD') as guardian_consent_at
           from public.bookings where id = $1`,
        [id],
      );
      const fila = filas.rows[0];
      expect(fila?.status).toBe("cancelled");
      expect(fila?.player_birth_date).toBe(nacimiento);
      expect(fila?.guardian_name).toBe("Marta Lopez");
      expect(fila?.guardian_consent_at).not.toBeNull();
    });
  });
});
