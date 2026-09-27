import { describe, expect, it } from "vitest";

import type { AvailabilityInput, Court, TimeRange } from "./types.js";
import { computeAvailability } from "./availability.js";

/**
 * T5b: `computeAvailability` es PURA y se prueba entera sin base de datos.
 *
 * Por que esta logica vive en `core` y no en el handler: es la parte que decide que horas
 * se pueden reservar, y es la que un club va a quejarse cuando este mal. Si viviera en el
 * endpoint, la unica forma de probarla seria levantar el endpoint y la base de datos, y un
 * fallo de 30 segundos no diria que hora es la que esta mal. Aqui se ejecuta en
 * milisegundos, con la entrada a la vista, y se puede ver que el slot de las 18:00 sale
 * porque el bloque de las 17:00 se lo come.
 */

const PISTA: Court = {
  id: "00000000-0000-4000-8000-0000000000c1",
  name: "Pista 1",
  courtType: "cristal",
  surface: "cesped",
  indoor: true,
  numPlayers: 4,
  defaultDurationMin: 90,
  minDurationMin: 60,
  maxDurationMin: 180,
  basePriceCents: 1200,
  sortOrder: 0,
  isActive: true,
  imagePath: null,
  deletedAt: null,
};

/** Dia laborable, 10 slots de 90 min entre las 8:00 y las 22:00. */
const DIA = "2026-03-02";

function entrada(extra: Partial<AvailabilityInput> = {}): AvailabilityInput {
  return { court: PISTA, date: DIA, busy: [], ...extra };
}

/** Un `court_block` o, desde T9, una reserva. */
function bloque(inicio: string, fin: string): TimeRange {
  return { startsAt: inicio, endsAt: fin };
}

/** Las horas de inicio de los slots, en `HH:MM`, para comparar sin ruido de ISO. */
function horas(result: { slots: ReadonlyArray<{ startsAt: string }> }): string[] {
  return result.slots.map((slot) => slot.startsAt.slice(11, 16));
}

describe("T5b: la rejilla de slots", () => {
  it("abre a las 8:00 y cierra a las 22:00, que es el criterio 7.2", () => {
    const result = computeAvailability(entrada());
    expect(horas(result)).toEqual([
      "08:00", "09:30", "11:00", "12:30", "14:00",
      "15:30", "17:00", "18:30", "20:00",
    ]);
  });

  it("cada slot dura lo que dice defaultDurationMin de la pista", () => {
    const result = computeAvailability(entrada());
    const primero = result.slots[0];
    expect(primero?.startsAt).toBe("2026-03-02T08:00");
    expect(primero?.endsAt).toBe("2026-03-02T09:30");
  });

  it("la duracion sale de la pista, no de un 90 fijo", () => {
    // Un club con pistas de 60 min es normal. Si el 90 estuviera en el codigo, este club
    // veria huecos que no puede vender y nadie sabria de donde sale el error.
    const result = computeAvailability(
      entrada({ court: { ...PISTA, defaultDurationMin: 60 } }),
    );
    expect(horas(result)).toEqual([
      "08:00", "09:00", "10:00", "11:00", "12:00", "13:00", "14:00",
      "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00",
    ]);
  });

  it("un slot que no cabe entero antes del cierre NO se ofrece a medias", () => {
    // 20:00-21:30 cabe, y 21:30-23:00 no. Ofrecer un hueco de 20:00 a 22:00 seria
    // prometer 90 minutos y dar 30, que es como un socio acaba reservando una pista
    // para 2 personas cuando ha pagado por 4.
    const result = computeAvailability(entrada());
    const ultimo = result.slots.at(-1);
    expect(ultimo?.startsAt).toBe("2026-03-02T20:00");
    expect(ultimo?.endsAt).toBe("2026-03-02T21:30");
    expect(result.slots).toHaveLength(9);
  });

  it("respeta un horario de apertura propio del club", () => {
    const result = computeAvailability(
      entrada({ openMinuteOfDay: 9 * 60, closeMinuteOfDay: 18 * 60 }),
    );
    expect(horas(result)).toEqual(["09:00", "10:30", "12:00", "13:30", "15:00", "16:30"]);
  });

  it("un dia sin huecos devuelve una lista vacia, no un error", () => {
    // Un club cerrado todo el dia tiene que poder pintar la pantalla sin que reviente.
    const result = computeAvailability(
      entrada({ openMinuteOfDay: 10 * 60, closeMinuteOfDay: 10 * 60 + 30 }),
    );
    expect(result.slots).toEqual([]);
  });
});

describe("T5b: los bloques quitan huecos", () => {
  it("un bloque en medio se come los slots que toca y deja el siguiente", () => {
    // El bloque va de 12:00 a 14:00. Se comen 11:00-12:30 y 12:30-14:00, que son los dos
    // que solapan. El de 14:00-15:30 NO se come: empieza justo cuando acaba el bloque, y
    // un cierre a las 14:00 no impide reservar a las 14:00. Este test se escribio primero
    // esperando que 14:00 tambien desapareciera, y fallo: la implementacion es la que
    // tiene razon. Un club que cierra la pista a las 14:00 quiere el hueco de las 14:00.
    const result = computeAvailability(
      entrada({ busy: [bloque("2026-03-02T12:00", "2026-03-02T14:00")] }),
    );
    expect(horas(result)).toEqual([
      "08:00", "09:30", "14:00", "15:30", "17:00", "18:30", "20:00",
    ]);
  });

  it("un bloque parcial se come el slot entero, no lo parte", () => {
    // 10:00-10:30 toca el slot 09:30-11:00. Partirlo en 09:30-10:00 daria un hueco de
    // 30 minutos que no es un `defaultDurationMin` y que el motor de precios no sabe
    // cuanto cobrar. Se quita el slot entero.
    const result = computeAvailability(
      entrada({ busy: [bloque("2026-03-02T10:00", "2026-03-02T10:30")] }),
    );
    expect(horas(result)).not.toContain("09:30");
    expect(horas(result)).toContain("08:00");
  });

  it("varios bloques se restan todos", () => {
    const result = computeAvailability(
      entrada({
        busy: [
          bloque("2026-03-02T08:00", "2026-03-02T09:30"),
          bloque("2026-03-02T17:00", "2026-03-02T20:00"),
        ],
      }),
    );
    expect(horas(result)).toEqual([
      "09:30", "11:00", "12:30", "14:00", "15:30", "20:00",
    ]);
  });

  it("el bloque que empieza justo al acabar un slot NO lo quita, el de un minuto antes si", () => {
    // El caso que se cuela si la comparacion es `<` en vez de solape real: un bloque que
    // empieza justo cuando el slot acaba NO lo toca. Con `<=` se lo come de mas.
    const justoAlFinal = computeAvailability(
      entrada({ busy: [bloque("2026-03-02T09:30", "2026-03-02T10:00")] }),
    );
    expect(horas(justoAlFinal)).toContain("08:00");

    // Y el que empieza un minuto antes, ese si lo quita.
    const unMinutoAntes = computeAvailability(
      entrada({ busy: [bloque("2026-03-02T09:29", "2026-03-02T10:00")] }),
    );
    expect(horas(unMinutoAntes)).not.toContain("08:00");
  });
});

describe("T5b: lo que hace con datos que no tienen sentido", () => {
  it("una duracion de 0 falla en vez de colgarse en bucle infinito", () => {
    // El fallo clasico de un `while (cursor < end) cursor += duracion`. Con `duracion = 0`
    // el cursor no avanza nunca.
    //
    // Aqui se FALLA y no se devuelve una lista vacia. Este test se escribio primero
    // esperando `[]`, y estaba mal el test: una duracion de 0 no es "un dia sin huecos",
    // es un dato roto, y devolver una lista vacia le diria al club que la pista esta
    // ocupada todo el dia, sin explicacion. Falla ruidosamente, como la fecha.
    expect(() =>
      computeAvailability(entrada({ court: { ...PISTA, defaultDurationMin: 0 } })),
    ).toThrow(/defaultDurationMin = 0/);
  });

  it("una duracion negativa tambien, y no un bucle que corre hacia atras", () => {
    expect(() =>
      computeAvailability(entrada({ court: { ...PISTA, defaultDurationMin: -30 } })),
    ).toThrow(/defaultDurationMin = -30/);
  });

  it("una duracion no numerica se rechaza en vez de propagar un NaN", () => {
    expect(() =>
      computeAvailability(entrada({ court: { ...PISTA, defaultDurationMin: Number.NaN } })),
    ).toThrow(/defaultDurationMin/);
  });

  it("un bloque con las fechas al reves se ignora en vez de comerse el dia entero", () => {
    // Un `ends_at < starts_at` viola el `check` de la base, pero si se colara, tratarlo
    // como "ocupa todo" deja al socio sin ninguna hora y sin explicacion. Aqui IGNORAR si
    // que es lo correcto: un rango que no significa nada no puede quitarle horas a nadie.
    const result = computeAvailability(
      entrada({ busy: [bloque("2026-03-02T18:00", "2026-03-02T09:00")] }),
    );
    expect(result.slots).toHaveLength(9);
  });

  it("un bloque de CERO minutos se ignora", () => {
    // `ends_at = starts_at` es un intervalo vacio: no ocupa nada. Si se tratara como
    // ocupado, un `court_block` creado por error con la misma hora de inicio y fin
    // dejaria un hueco fantasma en la pantalla.
    const result = computeAvailability(
      entrada({ busy: [bloque("2026-03-02T12:00", "2026-03-02T12:00")] }),
    );
    expect(result.slots).toHaveLength(9);
  });

  it("una fecha que no es YYYY-MM-DD falla nombrando LA FECHA QUE RECIBIO", () => {
    // El mensaje se comprueba por el VALOR que metio el cliente, no por una palabra. En
    // T4 salio un `lc_messages` en ingles dentro de un `check` que ya estaba escrito en
    // espanol, por no mirar el mensaje antes de escribir el test. Buscar el valor que
    // fallo no depende del idioma en que se escriba el error.
    expect(() => computeAvailability(entrada({ date: "02/03/2026" }))).toThrow(/02\/03\/2026/);
    expect(() => computeAvailability(entrada({ date: "2026-3-2" }))).toThrow(/2026-3-2/);
  });

  it("un instante de `busy` de otro dia falla en vez de compararse como si fuera hoy", () => {
    // Es el fallo que mas caro sale de los que no se ven: sin el `check` de dia, un
    // `court_block` de ayer con horas `09:00-10:00` se comparaba contra hoy y ocultaba
    // las 09:00 de HOY. El socio ve que no hay huecos a las 9 y no hay motivo en
    // pantalla. Mejor un error que diga que el bloque es de otro dia.
    expect(() =>
      computeAvailability(
        entrada({ busy: [bloque("2026-03-01T09:00", "2026-03-01T10:00")] }),
      ),
    ).toThrow(/2026-03-01/);
  });

  it("un instante de `busy` con formato roto falla en vez de compararse con NaN", () => {
    // Si `minuteOfDay` devolviera `NaN` en vez de fallar, `solapa` devolveria `false`
    // (todo `NaN` es falso) y el bloque pasaria INVISIBLE: la pista apareceria libre
    // justo encima de un cierre. Un dato malformado que se traduce en "no ocupa nada" es
    // el peor resultado posible, y es el que da no comprobar el formato.
    expect(() =>
      computeAvailability(
        entrada({ busy: [{ startsAt: "manana", endsAt: "2026-03-02T10:00" }] }),
      ),
    ).toThrow(/manana/);
  });

  it("es determinista: mismos datos de entrada, mismo resultado", () => {
    // El criterio 7.3 pide determinismo para el PRECIO, y la misma regla se aplica aqui:
    // la disponibilidad la van a comparar dos pestanas abiertas (criterio 7.2) y si dos
    // pintaran distinto, el club ve horas aparecer y desaparecer sin motivo.
    const una = entrada({ busy: [bloque("2026-03-02T12:00", "2026-03-02T14:00")] });
    const otra = entrada({ busy: [bloque("2026-03-02T12:00", "2026-03-02T14:00")] });
    expect(computeAvailability(una)).toEqual(computeAvailability(otra));
  });

  it("no le importa el ORDEN en que llegan los bloques", () => {
    // La consulta de T5d los trayendra ordenados, pero esta funcion no puede depender de
    // eso: si alguien mete el array al reves un dia, los huecos no pueden cambiar. Por eso
    // `normaliza` ordena antes de restar.
    const a = bloque("2026-03-02T17:00", "2026-03-02T20:00");
    const b = bloque("2026-03-02T08:00", "2026-03-02T09:30");
    expect(horas(computeAvailability(entrada({ busy: [a, b] })))).toEqual(
      horas(computeAvailability(entrada({ busy: [b, a] }))),
    );
  });
});
