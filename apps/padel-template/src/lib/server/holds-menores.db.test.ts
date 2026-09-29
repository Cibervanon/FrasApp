import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { esMenorDeEdad } from "@frasapp/core";

import { crearHold } from "./holds";
import type { CrearHoldInput } from "./holds";
import { closePool } from "./db";
import { prepareDatabase, releaseDatabaseLease, withAdmin } from "../../test/db-harness.js";

/**
 * T14c E2: `crearHold` decide si el jugador es menor ANTES de escribir.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE UN TEST DE LA LIB Y NO DE LA RUTA
 *
 * Lo que se decide aqui es una pregunta de SERVIDOR: "con el umbral de ESTE club, la fecha de
 * este jugador y el dia de HOY en la zona de ESTE club, es menor?". La ruta solo traduce el
 * resultado a un status (eso es E3). Si la decision se probara a traves de la ruta, el 422 del
 * tutor y el 400 de la fecha serian dos veces la misma prueba, y el caso importante
 * --menor sin tutor, CERO filas escritas-- quedaria mezclado con el parseo del cuerpo.
 *
 * ---------------------------------------------------------------------------------------
 * TENANTS PROPIOS, Y DIAS PROPIOS
 *
 * Las filas que se crean se COMMITEAN (es la lib de escritura, con su propio pool): un hold
 * vivo taparia el horario de otro fichero de test. Cada test que crea usa un dia distinto, y
 * `afterAll` borra todo lo que este fichero sembro. Los umbrales (18, 16, 14) viven en
 * tenants distintos y no se tocan con `update`, para que el orden de los tests no importe.
 */

/** Umbral 18 (el de por defecto), 16 y 14: los tres valores que un club puede fijar. */
const TENANT_18 = "00000000-0000-4000-8000-0000000006b0";
const TENANT_16 = "00000000-0000-4000-8000-0000000006b1";
const TENANT_14 = "00000000-0000-4000-8000-0000000006b2";

/**
 * Dos zonas a horas opuestas de UTC, y no una: hace falta una cuyo dia local sea distinto
 * del de UTC para poder distinguir "el dia del club" de "el dia de UTC".
 *
 * Kiritimati va 14 horas POR DELANTE y Niue 11 POR DETRAS. Entre las dos, a CUALQUIER hora
 * del dia, al menos una tiene fecha local distinta de la de UTC: Kiritimati se adelanta a
 * partir de las 10:00 UTC y Niue se atrasa hasta las 11:00 UTC, y no hay hora en la que las
 * dos coincidan con UTC a la vez. Es lo que hace que este test no sea de tramposo: con un
 * solo club, 11 de cada 24 horas pasaria sin comprobar nada.
 */
const TENANT_AL_ORIENTE = "00000000-0000-4000-8000-0000000006b3";
const TENANT_AL_OCCIDENTE = "00000000-0000-4000-8000-0000000006b4";

const ZONA_ORIENTE = "Pacific/Kiritimati";
const ZONA_OCCIDENTE = "Pacific/Niue";
const ZONA_MADRID = "Europe/Madrid";

const PISTA_18 = "00000000-0000-4000-8000-0000000006b5";
const PISTA_16 = "00000000-0000-4000-8000-0000000006b6";
const PISTA_14 = "00000000-0000-4000-8000-0000000006b7";
const PISTA_ORIENTE = "00000000-0000-4000-8000-0000000006b8";
const PISTA_OCCIDENTE = "00000000-0000-4000-8000-0000000006b9";

const USUARIO = "00000000-0000-4000-8000-0000000006ba";

const TENANTES = [TENANT_18, TENANT_16, TENANT_14, TENANT_AL_ORIENTE, TENANT_AL_OCCIDENTE];
const PISTAS = [PISTA_18, PISTA_16, PISTA_14, PISTA_ORIENTE, PISTA_OCCIDENTE];

const PRECIO_BASE = 1200;

/** El dia que comparten los tests que NO crean nada (deben dejar cero filas). */
const DIA_SIN_ESCRITURA = "2026-11-20T08:00";

function placeholders(ids: readonly string[]): string {
  return ids.map((_, index) => `$${index + 1}`).join(", ");
}

/**
 * Resta anos a una fecha `YYYY-MM-DD` con aritmetica de calendario, sin `Date`.
 *
 * Duplica a proposito la regla de `core` en vez de importar su helper privado: un test que
 * importa el codigo que prueba no comprueba el contrato, comprueba la implementacion. Lo que
 * estos tests afirman es la REGLA ("cumplir hoy ya es adulto"), y esa regla tiene que valer
 * el 28 de febrero igual que el 30 de junio.
 */
function restarAnios(fecha: string, anos: number): string {
  const ano = Number(fecha.slice(0, 4)) - anos;
  const mes = fecha.slice(5, 7);
  const dia = fecha.slice(8, 10);
  if (mes === "02" && dia === "29") return `${ano}-02-28`;
  return `${ano}-${mes}-${dia}`;
}

/** Suma o resta dias. Aritmetica UTC a proposito: aqui no hay zona que consultar. */
function moverDias(fecha: string, dias: number): string {
  const partes = fecha.split("-").map(Number);
  const ano = partes[0];
  const mes = partes[1];
  const dia = partes[2];
  if (ano === undefined || mes === undefined || dia === undefined) {
    throw new Error(`Fecha mal formada: ${fecha}`);
  }
  const movido = new Date(Date.UTC(ano, mes - 1, dia + dias));
  const mesMovido = String(movido.getUTCMonth() + 1).padStart(2, "0");
  const diaMovido = String(movido.getUTCDate()).padStart(2, "0");
  return `${movido.getUTCFullYear()}-${mesMovido}-${diaMovido}`;
}

/** El "hoy" del club (en su zona) y el de UTC, tal y como los ve la base. */
async function hoyDelClub(zona: string): Promise<{ readonly club: string; readonly utc: string }> {
  let fechas = { club: "", utc: "" };
  await withAdmin(async (db) => {
    const filas = await db.query<{ club: string; utc: string }>(
      `select to_char(now() at time zone $1, 'YYYY-MM-DD') as club,
              to_char(now() at time zone 'UTC', 'YYYY-MM-DD') as utc`,
      [zona],
    );
    const fila = filas.rows[0];
    if (fila === undefined) throw new Error("La consulta del dia no devolvio fila.");
    fechas = { club: fila.club, utc: fila.utc };
  });
  return fechas;
}

function base(over: Partial<CrearHoldInput> & { courtId: string; startsAt: string }): CrearHoldInput {
  return {
    numPlayers: 4,
    playerName: "Socio",
    playerBirthDate: "1990-01-01",
    ...over,
  };
}

const TUTOR = {
  guardianName: "Marta Lopez",
  guardianEmail: "marta@example.test",
  guardianPhone: "600000000",
  guardianRelation: "madre" as const,
};

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

    await db.query(
      `insert into public.tenants (id, name, slug, timezone, min_player_age) values
         ($1, 'T14c 18', 'club-t14c-18', $8, 18),
         ($2, 'T14c 16', 'club-t14c-16', $8, 16),
         ($3, 'T14c 14', 'club-t14c-14', $8, 14),
         ($4, 'T14c Oriente', 'club-t14c-oriente', $6, 18),
         ($5, 'T14c Occidente', 'club-t14c-occidente', $7, 18)`,
      [
        TENANT_18,
        TENANT_16,
        TENANT_14,
        TENANT_AL_ORIENTE,
        TENANT_AL_OCCIDENTE,
        ZONA_ORIENTE,
        ZONA_OCCIDENTE,
        ZONA_MADRID,
      ],
    );
    await db.query(
      `insert into public.courts
         (id, tenant_id, name, court_type, base_price_cents, sort_order,
          default_duration_min, min_duration_min, max_duration_min)
       values
         ($1, $6, 'Pista 18', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180),
         ($2, $7, 'Pista 16', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180),
         ($3, $8, 'Pista 14', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180),
         ($4, $9, 'Pista Oriente', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180),
         ($5, $10, 'Pista Occidente', 'cristal', ${PRECIO_BASE}, 1, 90, 60, 180)`,
      [
        PISTA_18,
        PISTA_16,
        PISTA_14,
        PISTA_ORIENTE,
        PISTA_OCCIDENTE,
        TENANT_18,
        TENANT_16,
        TENANT_14,
        TENANT_AL_ORIENTE,
        TENANT_AL_OCCIDENTE,
      ],
    );
    await db.query(`insert into auth.users (id, email) values ($1, 'socio-t14c@test')`, [USUARIO]);
  });
});

afterAll(async () => {
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

interface FilaDeHold {
  is_minor: boolean;
  player_birth_date: string | null;
  guardian_name: string | null;
  guardian_email: string | null;
  guardian_phone: string | null;
  guardian_relation: string | null;
  segundos_consentimiento: number | null;
}

/** Lo que el hold dejo escrito en `bookings`, para leerlo y no suponerlo. */
async function filaDe(holdId: string): Promise<FilaDeHold> {
  let fila: FilaDeHold | null = null;
  await withAdmin(async (db) => {
    const filas = await db.query<FilaDeHold>(
      `select is_minor,
              to_char(player_birth_date, 'YYYY-MM-DD') as player_birth_date,
              guardian_name, guardian_email, guardian_phone, guardian_relation,
              extract(epoch from (guardian_consent_at - now()))::int as segundos_consentimiento
         from public.bookings where id = $1`,
      [holdId],
    );
    fila = filas.rows[0] ?? null;
  });
  if (fila === null) throw new Error(`El hold ${holdId} no esta en la base.`);
  return fila;
}

/** Cuantas filas hay en una pista. Para probar el CERO de los 4xx. */
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

/** Atajo para no repetir el `if` de narrowing en cada test. */
function creado(
  resultado: Awaited<ReturnType<typeof crearHold>>,
): { id: string; isMinor: boolean; status: string; endsAt: string; priceCents: number } {
  if (resultado.tipo !== "creado") {
    throw new Error(`Se esperaba un hold creado y salio '${resultado.tipo}'.`);
  }
  return {
    id: resultado.hold.id,
    isMinor: resultado.hold.isMinor,
    status: resultado.hold.status,
    endsAt: resultado.hold.endsAt,
    priceCents: resultado.hold.priceCents,
  };
}

describe("T14c E2: la edad la decide el servidor, con el umbral del club", () => {
  it("un adulto entra sin datos de tutor y la fila los deja a null", async () => {
    const hold = creado(
      await crearHold(
        TENANT_18,
        ZONA_MADRID,
        USUARIO,
        base({ courtId: PISTA_18, startsAt: "2026-11-02T08:00", playerBirthDate: "1990-01-01" }),
      ),
    );
    expect(hold.isMinor).toBe(false);

    const fila = await filaDe(hold.id);
    expect(fila.is_minor).toBe(false);
    expect(fila.player_birth_date).toBe("1990-01-01");
    expect(fila.guardian_name).toBeNull();
    expect(fila.guardian_email).toBeNull();
    expect(fila.guardian_phone).toBeNull();
    expect(fila.guardian_relation).toBeNull();
    expect(fila.segundos_consentimiento).toBeNull();
  });

  it("un menor entra con tutor y el consentimiento es del reloj de la base", async () => {
    const hoy = await hoyDelClub(ZONA_MADRID);
    const nacimiento = restarAnios(hoy.club, 16);

    const hold = creado(
      await crearHold(
        TENANT_18,
        ZONA_MADRID,
        USUARIO,
        base({
          courtId: PISTA_18,
          startsAt: "2026-11-03T08:00",
          playerBirthDate: nacimiento,
          tutor: TUTOR,
        }),
      ),
    );
    expect(hold.isMinor).toBe(true);

    const fila = await filaDe(hold.id);
    expect(fila.is_minor).toBe(true);
    expect(fila.player_birth_date).toBe(nacimiento);
    expect(fila.guardian_name).toBe(TUTOR.guardianName);
    expect(fila.guardian_email).toBe(TUTOR.guardianEmail);
    expect(fila.guardian_phone).toBe(TUTOR.guardianPhone);
    expect(fila.guardian_relation).toBe(TUTOR.guardianRelation);
    // `now()` de la base: ni un reloj de JavaScript ni un dato que venga en el cuerpo.
    expect(Math.abs(fila.segundos_consentimiento ?? 9999)).toBeLessThan(60);
  });

  it("quien cumple hoy el umbral ya es adulto, y manana sigue siendo menor", async () => {
    const hoy = await hoyDelClub(ZONA_MADRID);

    const hoyCumple = creado(
      await crearHold(
        TENANT_18,
        ZONA_MADRID,
        USUARIO,
        base({
          courtId: PISTA_18,
          startsAt: "2026-11-04T08:00",
          playerBirthDate: restarAnios(hoy.club, 18),
        }),
      ),
    );
    expect(hoyCumple.isMinor).toBe(false);

    const mananaCumple = creado(
      await crearHold(
        TENANT_18,
        ZONA_MADRID,
        USUARIO,
        base({
          courtId: PISTA_18,
          startsAt: "2026-11-05T08:00",
          // Cumple 18 MANANA: hoy le falta un dia, y un dia es un dia.
          playerBirthDate: restarAnios(moverDias(hoy.club, 1), 18),
          tutor: TUTOR,
        }),
      ),
    );
    expect(mananaCumple.isMinor).toBe(true);
  });

  it("el umbral es el del club: con 16 y con 14 entra quien con 18 no entraria", async () => {
    const hoy = await hoyDelClub(ZONA_MADRID);

    const conDieciseis = creado(
      await crearHold(
        TENANT_16,
        ZONA_MADRID,
        USUARIO,
        base({
          courtId: PISTA_16,
          startsAt: "2026-11-06T08:00",
          playerBirthDate: restarAnios(hoy.club, 16),
        }),
      ),
    );
    expect(conDieciseis.isMinor).toBe(false);

    const conCatorce = creado(
      await crearHold(
        TENANT_14,
        ZONA_MADRID,
        USUARIO,
        base({
          courtId: PISTA_14,
          startsAt: "2026-11-09T08:00",
          playerBirthDate: restarAnios(hoy.club, 13),
          tutor: TUTOR,
        }),
      ),
    );
    expect(conCatorce.isMinor).toBe(true);
  });

  it("el MISMO jugador es menor en un club de 18 y adulto en uno de 16", async () => {
    const hoy = await hoyDelClub(ZONA_MADRID);
    const nacimiento = restarAnios(hoy.club, 16);

    const enDieciocho = creado(
      await crearHold(
        TENANT_18,
        ZONA_MADRID,
        USUARIO,
        base({
          courtId: PISTA_18,
          startsAt: "2026-11-10T08:00",
          playerBirthDate: nacimiento,
          tutor: TUTOR,
        }),
      ),
    );
    expect(enDieciocho.isMinor).toBe(true);

    const enDieciseis = creado(
      await crearHold(
        TENANT_16,
        ZONA_MADRID,
        USUARIO,
        base({ courtId: PISTA_16, startsAt: "2026-11-11T08:00", playerBirthDate: nacimiento }),
      ),
    );
    expect(enDieciseis.isMinor).toBe(false);
  });

  it("la edad es la de HOY, no la del dia que se reserva", async () => {
    // El 15 de febrero de 2027 cumple 18. En el dia de la reserva es adulto; hoy es menor.
    const hold = creado(
      await crearHold(
        TENANT_18,
        ZONA_MADRID,
        USUARIO,
        base({
          courtId: PISTA_18,
          startsAt: "2027-02-15T08:00",
          playerBirthDate: "2009-02-15",
          tutor: TUTOR,
        }),
      ),
    );
    expect(hold.isMinor).toBe(true);
  });

  it("el dia que se mira es el del club, no el de UTC", async () => {
    const casos = [
      {
        nombre: "oriente",
        zona: ZONA_ORIENTE,
        tenant: TENANT_AL_ORIENTE,
        pista: PISTA_ORIENTE,
        slot: "2026-11-13T08:00",
        fechas: await hoyDelClub(ZONA_ORIENTE),
      },
      {
        nombre: "occidente",
        zona: ZONA_OCCIDENTE,
        tenant: TENANT_AL_OCCIDENTE,
        pista: PISTA_OCCIDENTE,
        slot: "2026-11-16T08:00",
        fechas: await hoyDelClub(ZONA_OCCIDENTE),
      },
    ];

    // Que NO coincidan las dos con UTC a la vez es la unica garantia de que a la hora que
    // se ejecute esto hay un caso con dientes. Con un solo club, la mitad de las horas
    // pasaria sin comprobar nada.
    expect(
      casos.some((caso) => caso.fechas.club === caso.fechas.utc) &&
        casos.every((caso) => caso.fechas.club === caso.fechas.utc),
    ).toBe(false);

    for (const caso of casos) {
      // 18 anos antes de la fecha MAS TARDIA de las dos (comparar ISO es comparar texto).
      //
      // Si el club va POR DELANTE de UTC, ese nacimiento es el dia del cumpleaños SEGUN EL
      // CLUB (adulto) y es un dia antes SEGUN UTC (menor). Si va POR DETRAS, es al reves: un
      // dia antes segun el club (menor) y el cumpleaños segun UTC (adulto). Lo que no puede
      // pasar es que las dos fechas den lo mismo, y por eso el caso tiene dientes: un
      // `now()::date` sin zona daria el resultado contrario en uno de los dos casos.
      const masTardia =
        caso.fechas.club > caso.fechas.utc ? caso.fechas.club : caso.fechas.utc;
      const fecha = restarAnios(masTardia, 18);
      const segunElClub = esMenorDeEdad({
        fechaNacimiento: fecha,
        edadMinima: 18,
        hoy: caso.fechas.club,
      });
      const segunUtc = esMenorDeEdad({ fechaNacimiento: fecha, edadMinima: 18, hoy: caso.fechas.utc });

      const hold = creado(
        await crearHold(
          caso.tenant,
          caso.zona,
          USUARIO,
          base({
            courtId: caso.pista,
            startsAt: caso.slot,
            playerBirthDate: fecha,
            // Solo si el club dice que es menor: mandar tutor de mas es `tutor_no_requerido`.
            ...(segunElClub ? { tutor: TUTOR } : {}),
          }),
        ),
      );
      expect(hold.isMinor, `zona ${caso.nombre}`).toBe(segunElClub);

      // Cuando la fecha local de ESE club difiere de la de UTC, la fecha de UTC daria el
      // resultado contrario. Si aqui las dos coincidieran, este test no distinguiria nada.
      if (caso.fechas.club !== caso.fechas.utc) {
        expect(segunUtc, `la zona ${caso.nombre} deberia distinguir de UTC`).not.toBe(segunElClub);
      }
    }
  });

  it("un hold de menor sigue siendo un hold normal: 90 minutos y el precio base", async () => {
    const hoy = await hoyDelClub(ZONA_MADRID);
    const hold = creado(
      await crearHold(
        TENANT_18,
        ZONA_MADRID,
        USUARIO,
        base({
          courtId: PISTA_18,
          startsAt: "2026-11-12T08:00",
          playerBirthDate: restarAnios(hoy.club, 15),
          tutor: TUTOR,
        }),
      ),
    );
    expect(hold.status).toBe("held");
    expect(hold.endsAt).toBe("2026-11-12T09:30");
    expect(hold.priceCents).toBe(PRECIO_BASE);
  });
});

describe("T14c E2: los 4xx no escriben nada", () => {
  it("un menor sin datos de tutor no crea nada", async () => {
    const hoy = await hoyDelClub(ZONA_MADRID);
    const antes = await filasEn(PISTA_18);

    const resultado = await crearHold(
      TENANT_18,
      ZONA_MADRID,
      USUARIO,
      base({
        courtId: PISTA_18,
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: restarAnios(hoy.club, 14),
      }),
    );

    expect(resultado).toEqual({ tipo: "faltan_datos_tutor" });
    expect(await filasEn(PISTA_18)).toBe(antes);
  });

  it("un menor con los datos de tutor a medias tampoco", async () => {
    const hoy = await hoyDelClub(ZONA_MADRID);
    const antes = await filasEn(PISTA_18);

    const resultado = await crearHold(
      TENANT_18,
      ZONA_MADRID,
      USUARIO,
      base({
        courtId: PISTA_18,
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: restarAnios(hoy.club, 14),
        tutor: { ...TUTOR, guardianPhone: "" },
      }),
    );

    expect(resultado).toEqual({ tipo: "faltan_datos_tutor" });
    expect(await filasEn(PISTA_18)).toBe(antes);
  });

  it("un adulto con datos de tutor no crea nada: el servidor sabe mas que el cuerpo", async () => {
    const antes = await filasEn(PISTA_18);

    const resultado = await crearHold(
      TENANT_18,
      ZONA_MADRID,
      USUARIO,
      base({
        courtId: PISTA_18,
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: "1990-01-01",
        tutor: TUTOR,
      }),
    );

    expect(resultado).toEqual({ tipo: "tutor_no_requerido" });
    expect(await filasEn(PISTA_18)).toBe(antes);
  });

  it("una fecha que no existe en el calendario no crea nada", async () => {
    const antes = await filasEn(PISTA_18);

    const resultado = await crearHold(
      TENANT_18,
      ZONA_MADRID,
      USUARIO,
      base({ courtId: PISTA_18, startsAt: DIA_SIN_ESCRITURA, playerBirthDate: "2015-02-30" }),
    );

    expect(resultado.tipo).toBe("fecha_invalida");
    expect(await filasEn(PISTA_18)).toBe(antes);
  });

  it("una fecha de futuro no crea nada", async () => {
    const hoy = await hoyDelClub(ZONA_MADRID);
    const antes = await filasEn(PISTA_18);

    const resultado = await crearHold(
      TENANT_18,
      ZONA_MADRID,
      USUARIO,
      base({
        courtId: PISTA_18,
        startsAt: DIA_SIN_ESCRITURA,
        playerBirthDate: moverDias(hoy.club, 1),
      }),
    );

    expect(resultado.tipo).toBe("fecha_invalida");
    expect(await filasEn(PISTA_18)).toBe(antes);
  });
});
