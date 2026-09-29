import { describe, expect, it } from "vitest";

import { esMenorDeEdad } from "./edad.js";

/**
 * T14c E1: la comparacion de edad, en PURO y sin Postgres (spec t14c-menores.md, E1).
 *
 * La funcion decide si un jugador es menor para el club, y es la UNICA defensa de la que
 * depende el requisito de tutor: el `check` de la tabla solo verifica lo que esta funcion
 * ya ha decidido. Por eso los limites exactos son parte de la tabla y no un accidente:
 *
 *  - "cumple 18 HOY" es ADULTO. Un limite inclusivo como el de los tramos de reembolso
 *    (`>=`): el dia que cumples, ya puedes.
 *  - "cumple 18 MANANA" es MENOR. El reloj no se adelanta por generosidad.
 *  - La comparacion es de CALENDARIO, no de dias transcurridos: 365 dias no son un ano.
 *
 * Y por eso los casos imposibles LANZAN en vez de devolver `false`: un `false` por una
 * fecha rota seria un menor de 15 anos entrando sin tutor, que es justo el agujero que
 * esta tarea existe para cerrar. Un fallo ruidoso se ve en los tests; un `false` silencioso
 * se ve en un club con un menor sin tutor.
 */

const HOY = "2026-09-29";

describe("esMenorDeEdad: el umbral por defecto (18)", () => {
  it("15 anos -> menor", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2011-03-01", edadMinima: 18, hoy: HOY })).toBe(true);
  });

  it("17 anos y 364 dias -> menor", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2008-10-01", edadMinima: 18, hoy: HOY })).toBe(true);
  });

  it("cumple 18 HOY -> adulto (limite inclusivo)", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2008-09-29", edadMinima: 18, hoy: HOY })).toBe(false);
  });

  it("cumple 18 MANANA -> menor", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2008-09-30", edadMinima: 18, hoy: HOY })).toBe(true);
  });

  it("30 anos -> adulto", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "1996-01-15", edadMinima: 18, hoy: HOY })).toBe(false);
  });
});

describe("esMenorDeEdad: el umbral es el del club, no una constante", () => {
  it("17 anos con umbral 16 -> adulto", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2009-05-20", edadMinima: 16, hoy: HOY })).toBe(false);
  });

  it("16 anos con umbral 16, cumpliendo hoy -> adulto", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2010-09-29", edadMinima: 16, hoy: HOY })).toBe(false);
  });

  it("15 anos con umbral 16 -> menor", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2010-12-01", edadMinima: 16, hoy: HOY })).toBe(true);
  });

  it("13 anos con umbral 14 -> menor (el minimo del check de la columna)", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2013-02-10", edadMinima: 14, hoy: HOY })).toBe(true);
  });

  it("22 anos con umbral 21 -> adulto (el maximo del check de la columna)", () => {
    expect(esMenorDeEdad({ fechaNacimiento: "2004-01-01", edadMinima: 21, hoy: HOY })).toBe(false);
  });
});

describe("esMenorDeEdad: fechas que no existen en el calendario", () => {
  it("rechaza un mes 13", () => {
    expect(() =>
      esMenorDeEdad({ fechaNacimiento: "2015-13-01", edadMinima: 18, hoy: HOY }),
    ).toThrow(/no es una fecha/);
  });

  it("rechaza el 30 de febrero", () => {
    expect(() =>
      esMenorDeEdad({ fechaNacimiento: "2015-02-30", edadMinima: 18, hoy: HOY }),
    ).toThrow(/no es una fecha/);
  });

  it("rechaza un formato sin guiones", () => {
    expect(() =>
      esMenorDeEdad({ fechaNacimiento: "20150301", edadMinima: 18, hoy: HOY }),
    ).toThrow(/no es una fecha/);
  });

  it("rechaza 'ayer'", () => {
    expect(() =>
      esMenorDeEdad({ fechaNacimiento: "ayer", edadMinima: 18, hoy: HOY }),
    ).toThrow(/no es una fecha/);
  });

  it("rechaza una fecha de nacimiento FUTURA (nacido manana)", () => {
    expect(() =>
      esMenorDeEdad({ fechaNacimiento: "2026-09-30", edadMinima: 18, hoy: HOY }),
    ).toThrow(/futura/);
  });

  it("rechaza un 'hoy' mal formado: el servidor no puede decidir sin fecha", () => {
    expect(() =>
      esMenorDeEdad({ fechaNacimiento: "2011-03-01", edadMinima: 18, hoy: "29-09-2026" }),
    ).toThrow(/no es una fecha/);
  });
});

describe("esMenorDeEdad: cumpleaños en dia 29 de febrero", () => {
  it("nacido un 29 de febrero: el 28 de febrero sigue siendo menor", () => {
    // 2026 no es bisiesto: su 18 cumpleaños "cae" el 28 o el 1 de marzo. Este motor usa
    // la convencion de ajustar al 28, asi que hasta ese dia es menor.
    expect(
      esMenorDeEdad({ fechaNacimiento: "2008-02-29", edadMinima: 18, hoy: "2026-02-28" }),
    ).toBe(true);
  });

  it("nacido un 29 de febrero: el 1 de marzo ya es adulto", () => {
    expect(
      esMenorDeEdad({ fechaNacimiento: "2008-02-29", edadMinima: 18, hoy: "2026-03-01" }),
    ).toBe(false);
  });

  it("nacido un 28 de febrero: cumple ese dia exacto (no hay borde que corra)", () => {
    expect(
      esMenorDeEdad({ fechaNacimiento: "2008-02-28", edadMinima: 18, hoy: "2026-02-28" }),
    ).toBe(false);
  });

  it("nacido un 31 de diciembre: el 31 de diciembre de 2026 ya cumple", () => {
    expect(
      esMenorDeEdad({ fechaNacimiento: "2008-12-31", edadMinima: 18, hoy: "2026-12-31" }),
    ).toBe(false);
  });

  it("el 29 de febrero que NO es bisiesto en el ano del cumpleanos: se ajusta al 28", () => {
    // 2024 es bisiesto, pero 2026 (2006 + 18... el corte es 2024 - 18 = 2006) no lo es:
    // el corte se ajusta al 28 de febrero de 2006 y un nacido ese dia ya es adulto.
    expect(
      esMenorDeEdad({ fechaNacimiento: "2006-02-28", edadMinima: 18, hoy: "2024-02-29" }),
    ).toBe(false);
  });

  it("el 29 de febrero bisiesto en el ano del cumpleanos: cumple ese dia exacto", () => {
    // 2024 - 16 = 2008, que SI es bisiesto: el corte se queda en el 29 y un nacido ese
    // dia cumple hoy.
    expect(
      esMenorDeEdad({ fechaNacimiento: "2008-02-29", edadMinima: 16, hoy: "2024-02-29" }),
    ).toBe(false);
  });
});

describe("esMenorDeEdad: el umbral tiene que ser el del esquema", () => {
  it("rechaza un umbral de 13 (por debajo del check de la columna)", () => {
    expect(() => esMenorDeEdad({ fechaNacimiento: "2011-03-01", edadMinima: 13, hoy: HOY })).toThrow(
      /umbral/,
    );
  });

  it("rechaza un umbral de 22 (por encima del check de la columna)", () => {
    expect(() => esMenorDeEdad({ fechaNacimiento: "2011-03-01", edadMinima: 22, hoy: HOY })).toThrow(
      /umbral/,
    );
  });

  it("rechaza un umbral de 0: 'sin edad minima' es exactamente el agujero", () => {
    expect(() => esMenorDeEdad({ fechaNacimiento: "2011-03-01", edadMinima: 0, hoy: HOY })).toThrow(
      /umbral/,
    );
  });

  it("rechaza un umbral no entero: la columna es int, un float aqui es un bug", () => {
    expect(() => esMenorDeEdad({ fechaNacimiento: "2011-03-01", edadMinima: 17.5, hoy: HOY })).toThrow(
      /umbral/,
    );
  });
});
