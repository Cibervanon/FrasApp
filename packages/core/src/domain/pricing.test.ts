import { describe, expect, it } from "vitest";

import { resolvePrice } from "./pricing.js";
import type { PricingInput, PricingRule } from "./types.js";

/**
 * La tabla de casos de `resolvePrice`, escrita ANTES que la funcion. Ver
 * `docs/specs/t7-resolve-price.md` para de donde sale cada fila.
 *
 * Los dias de la semana que se usan aqui se comprobaron FUERA de este repo (con
 * `Date`) antes de escribirlos, y el motor los calcula con aritmetica civil. Si estan
 * mal, todos los precios de punta se desplazan un dia y nada mas lo delata: el club
 * cobra la tarifa de un miercoles por un jueves y el socio no se queja porque el importe
 * le cuadra. Por eso hay un bloque de anclas, con 1900 y 2100, que son los dos casos
 * que rompen la aritmetica de anos bisiestos.
 */
const ANCLA_1970 = "1970-01-01"; // jueves -> 4
const ANCLA_2000 = "2000-03-01"; // miercoles -> 3 (2000 SI es bisiesto)
const ANCLA_1900 = "1900-03-01"; // jueves -> 4 (1900 NO es bisiesto)
const ANCLA_2100 = "2100-01-01"; // viernes -> 5 (2100 NO es bisiesto)

/** Domingo. Un domingo a las 10:00 cae dentro de la ventana 8:00-22:00 de la spec. */
const DOMINGO = "2026-09-27T10:00";
/** Lunes. El dia siguiente, para comprobar que el dia anterior no se confunde con este. */
const LUNES = "2026-09-28T10:00";

const PISTA: PricingInput["court"] = {
  id: "pista-cristal-1",
  courtType: "cristal",
  basePriceCents: 2000,
};

/**
 * Precio de las reglas de los tests de dia de la semana. Distinto del
 * `basePriceCents` de la pista a proposito: si los dos valieran lo mismo, un test que
 * espera "aplica la regla" pasaria tambien con "no aplica ninguna", y no probaria
 * nada.
 */
const PUNTAL = 3300;

/**
 * Regla con TODOS los campos de la spec puestos a un valor que hace que aplique a
 * cualquier pista, cualquier dia, a cualquier hora del dia. Cada test cambia solo lo
 * que le importa, y asi el fallo dice que campo esta mal en vez de "algo de la regla".
 *
 * `endTime: "24:00"` es legal: `time` de Postgres admite 24:00, y con el como final la
 * regla cubre el dia entero.
 */
function regla(cambios: Partial<PricingRule> = {}): PricingRule {
  return {
    id: "regla-base",
    name: "Tarifa de prueba",
    scope: "global",
    courtType: null,
    courtId: null,
    dayOfWeek: [],
    startTime: "00:00",
    endTime: "24:00",
    durationMin: 90,
    priceCents: 2000,
    playerMultiplier: false,
    priority: 0,
    validFrom: null,
    validTo: null,
    isActive: true,
    ...cambios,
  };
}

function entrada(cambios: Partial<PricingInput> = {}): PricingInput {
  return {
    court: PISTA,
    rules: [],
    startsAt: DOMINGO,
    durationMin: 90,
    numPlayers: 4,
    ...cambios,
  };
}

describe("resolvePrice: sin regla aplicable, tarifa base de la pista", () => {
  it("sin ninguna regla devuelve el base_price_cents de la pista", () => {
    expect(resolvePrice(entrada())).toEqual({
      totalCents: 2000,
      ruleId: null,
      ruleName: null,
      breakdown: [{ label: "Tarifa base", cents: 2000 }],
    });
  });

  it("nunca devuelve null, ni con el precio a cero", () => {
    // Una pista gratis devuelve 0, que NO es lo mismo que "no hay precio". Un motor
    // que usara `null` para las dos cosas permitiria cobrar 0 donde deberia fallar, y
    // cobrar 0 es un regalo que el socio agradece y el club no.
    const gratis = resolvePrice(
      entrada({ court: { ...PISTA, basePriceCents: 0 } }),
    );
    expect(gratis.totalCents).toBe(0);
    expect(gratis.ruleId).toBeNull();
  });

  it("el desglose del caso sin reglas lo explica, no viene vacio", () => {
    // Un desglose vacio obliga a la UI a inventar el texto "otro motivo" cuando el
    // socio pregunta. Y este es el desglose que se guarda en `bookings` y que hay que
    // poder reexplicar seis meses despues.
    expect(resolvePrice(entrada()).breakdown).toHaveLength(1);
  });
});

describe("resolvePrice: precedencia de scope, de mas especifico a menos", () => {
  it("global gana cuando es la unica que aplica", () => {
    const quote = resolvePrice(entrada({ rules: [regla({ priceCents: 1500 })] }));
    expect(quote.totalCents).toBe(1500);
    expect(quote.ruleId).toBe("regla-base");
  });

  it("court_type gana a global aunque tenga MENOS prioridad", () => {
    // La especificidad va ANTES que la prioridad, no se suman. Si se sumaran, un
    // `priority: 99` en la regla global aplastaria a la tarifa del tipo de pista, que
    // es justo la tarifa que el club escribe para no cobrar lo de cristal en la malla.
    const quote = resolvePrice(
      entrada({
        rules: [
          regla({ id: "global", priceCents: 1000, priority: 99 }),
          regla({
            id: "por-tipo",
            scope: "court_type",
            courtType: "cristal",
            priceCents: 2200,
            priority: 0,
          }),
        ],
      }),
    );
    expect(quote.ruleId).toBe("por-tipo");
    expect(quote.totalCents).toBe(2200);
  });

  it("court gana a court_type y a global", () => {
    const quote = resolvePrice(
      entrada({
        rules: [
          regla({ id: "global", priceCents: 1000, priority: 99 }),
          regla({
            id: "por-tipo",
            scope: "court_type",
            courtType: "cristal",
            priceCents: 2200,
            priority: 50,
          }),
          regla({ id: "por-pista", scope: "court", courtId: PISTA.id, priceCents: 2400 }),
        ],
      }),
    );
    expect(quote.ruleId).toBe("por-pista");
    expect(quote.totalCents).toBe(2400);
  });

  it("una regla de court_type de OTRO tipo de pista no aplica", () => {
    // `malla` no es `cristal`. Sin este caso, una regla de malla acabaria cobrandose
    // en la pista de cristal, que es como un club se encuentra una factura que no
    // reconoce.
    const quote = resolvePrice(
      entrada({
        rules: [regla({ scope: "court_type", courtType: "malla", priceCents: 500 })],
      }),
    );
    expect(quote.ruleId).toBeNull();
    expect(quote.totalCents).toBe(2000);
  });

  it("una regla de court de OTRA pista no aplica", () => {
    const quote = resolvePrice(
      entrada({
        rules: [regla({ scope: "court", courtId: "otra-pista", priceCents: 500 })],
      }),
    );
    expect(quote.ruleId).toBeNull();
    expect(quote.totalCents).toBe(2000);
  });
});

describe("resolvePrice: desempate dentro del mismo scope", () => {
  it("gana la de mayor priority", () => {
    const quote = resolvePrice(
      entrada({
        rules: [
          regla({ id: "baja", priceCents: 1000, priority: 1 }),
          regla({ id: "alta", priceCents: 3000, priority: 2 }),
        ],
      }),
    );
    expect(quote.ruleId).toBe("alta");
  });

  it("a igual priority gana la de valid_from mas reciente", () => {
    const quote = resolvePrice(
      entrada({
        rules: [
          regla({ id: "vieja", priceCents: 1000, validFrom: "2026-01-01" }),
          regla({ id: "nueva", priceCents: 3000, validFrom: "2026-09-01" }),
        ],
      }),
    );
    expect(quote.ruleId).toBe("nueva");
  });

  it("una regla SIN valid_from es la mas antigua, no la mas reciente", () => {
    // Al reves seria el fallo clasico: "sin fecha" se interpretaria como "para
    // siempre y por encima de todo", y una tarifa puntual de septiembre no se
    // aplicaria nunca mientras haya una regla general sin fecha. Aqui gana la nueva.
    const quote = resolvePrice(
      entrada({
        rules: [
          regla({ id: "sin-fecha", priceCents: 1000, validFrom: null }),
          regla({ id: "con-fecha", priceCents: 3000, validFrom: "2026-01-01" }),
        ],
      }),
    );
    expect(quote.ruleId).toBe("con-fecha");
  });

  it("a igual priority y sin fechas gana el id menor, siempre", () => {
    // La spec llega aqui solo con tres criterios y los tres dicen "empate". Sin un
    // cuarto, gana la fila que el plan de ejecucion de la consulta devuelva primera:
    // mismo input, distinto importe, y el unico cambio es la version de Postgres. Este
    // test falla si el `sort` se queda en tres criterios.
    const rules = [
      regla({ id: "regla-b", priceCents: 2000 }),
      regla({ id: "regla-a", priceCents: 5000 }),
    ];
    expect(resolvePrice(entrada({ rules })).ruleId).toBe("regla-a");
    // Y al revés en el array, para que no dependa del orden de llegada.
    expect(resolvePrice(entrada({ rules: [...rules].reverse() })).ruleId).toBe("regla-a");
  });

  it("varias reglas con fechas distintas gana la mas reciente, venga en el orden que venga", () => {
    // El caso real de un club que sube la tarifa: deja reglas de enero, de junio y de
    // septiembre, todas de scope global y sin prioridad. Gana septiembre. Con dos reglas
    // el `sort` de V8 hace una sola comparacion y no llega a mirar el otro sentido, asi
    // que hacen falta tres para que el comparador se use en las dos direcciones: si el
    // `sort` devolviera 1 siempre, esta lista saldria en orden inverso y el test falla.
    const reglas = [
      regla({ id: "sep", validFrom: "2026-09-01", priceCents: 7000 }),
      regla({ id: "ene", validFrom: "2026-01-01", priceCents: 3000 }),
      regla({ id: "jun", validFrom: "2026-06-01", priceCents: 5000 }),
    ];
    for (const orden of [reglas, [...reglas].reverse(), [reglas[1], reglas[2], reglas[0]] as readonly PricingRule[]]) {
      const quote = resolvePrice(entrada({ rules: orden }));
      expect(quote.ruleId).toBe("sep");
      expect(quote.totalCents).toBe(7000);
    }
  });

  it("dos filas con el MISMO id no rompen el orden", () => {
    // La base lo prohibe con su clave primaria, asi que esto no puede llegar desde
    // `pricing_rules`. Puede llegar desde un `join` que duplique filas, y entonces el
    // comparador recibe dos elementos iguales: tiene que devolver 0 y no reventar.
    // Este caso existe tambien para que la rama del `return 0` sea ejecutable, que si
    // no el umbral de cobertura la marca como codigo muerto.
    const gemelas = [
      regla({ id: "mismo", priceCents: 1000 }),
      regla({ id: "mismo", priceCents: 7000 }),
    ];
    const quote = resolvePrice(entrada({ rules: gemelas }));
    expect([1000, 7000]).toContain(quote.totalCents);
  });
});

describe("resolvePrice: day_of_week", () => {
  it("dayOfWeek vacio es todos los dias", () => {
    const todas = regla({ dayOfWeek: [] });
    expect(resolvePrice(entrada({ rules: [todas], startsAt: DOMINGO })).ruleId).toBe(
      "regla-base",
    );
    expect(resolvePrice(entrada({ rules: [todas], startsAt: LUNES })).ruleId).toBe(
      "regla-base",
    );
  });

  it("domingo es 0 y lunes es 1, en dias contiguos", () => {
    // Si el dia se calculara con un desplazamiento de uno, el domingo y el lunes
    // devolverian el mismo dia de la semana y estas dos reglas serian
    // indistinguibles. Con el desplazamiento, la del domingo no aplica el lunes.
    const domingo = regla({ dayOfWeek: [0], priceCents: PUNTAL });
    expect(resolvePrice(entrada({ rules: [domingo], startsAt: DOMINGO })).totalCents).toBe(
      PUNTAL,
    );
    expect(resolvePrice(entrada({ rules: [domingo], startsAt: LUNES })).totalCents).toBe(
      PISTA.basePriceCents,
    );
  });

  it("la semana entera con 0 al 6 cubre domingo y lunes", () => {
    const semana = regla({ dayOfWeek: [0, 1, 2, 3, 4, 5, 6], priceCents: PUNTAL });
    expect(resolvePrice(entrada({ rules: [semana], startsAt: DOMINGO })).totalCents).toBe(
      PUNTAL,
    );
    expect(resolvePrice(entrada({ rules: [semana], startsAt: LUNES })).totalCents).toBe(
      PUNTAL,
    );
  });

  it("sabado es 6, no 5", () => {
    // El array de la spec es 0=domingo, no el ISO de lunes=1. Un club que marque el
    // sabado como 5 se queda sin tarifa de sabado y no se da cuenta, porque el
    // domingo siguiente tampoco la tiene marcada.
    const sabado = regla({ dayOfWeek: [6] });
    expect(
      resolvePrice(entrada({ rules: [sabado], startsAt: "2026-10-03T10:00" })).ruleId,
    ).toBe("regla-base");
    expect(
      resolvePrice(entrada({ rules: [sabado], startsAt: "2026-10-02T10:00" })).totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("anclas del dia de la semana, incluidas las del cambio de siglo", () => {
    // Cada caso es una regla que solo aplica a ESE dia. Si el dia de la semana
    // estuviera mal, el precio sale de la base y el test lo ve.
    const reglaDeEseDia = (fecha: string, dia: number): PricingInput =>
      entrada({ rules: [regla({ dayOfWeek: [dia], priceCents: PUNTAL })], startsAt: `${fecha}T10:00` });

    // 1970-01-01, el dia cero del reloj de Unix, fue un jueves.
    expect(resolvePrice(reglaDeEseDia(ANCLA_1970, 4)).totalCents).toBe(PUNTAL);
    // 2000-03-01: 2000 SI es bisiesto (divisible por 400), fue un miercoles.
    expect(resolvePrice(reglaDeEseDia(ANCLA_2000, 3)).totalCents).toBe(PUNTAL);
    // 1900-03-01: 1900 NO es bisiesto (divisible por 100 pero no por 400), jueves.
    expect(resolvePrice(reglaDeEseDia(ANCLA_1900, 4)).totalCents).toBe(PUNTAL);
    // 2100-01-01: 2100 tampoco, viernes.
    expect(resolvePrice(reglaDeEseDia(ANCLA_2100, 5)).totalCents).toBe(PUNTAL);
    // Y que el mismo numero de dia NO aplique a la fecha de al lado, que es el
    // error de un desplazamiento.
    expect(resolvePrice(reglaDeEseDia(ANCLA_2100, 4)).totalCents).toBe(
      PISTA.basePriceCents,
    );
  });
});

describe("resolvePrice: valid_from y valid_to", () => {
  it("una regla que aun no ha empezado no aplica", () => {
    const futura = regla({ validFrom: "2026-10-01", priceCents: 3000 });
    expect(resolvePrice(entrada({ rules: [futura] })).totalCents).toBe(
      PISTA.basePriceCents,
    );
  });

  it("una regla que ya ha caducado no aplica", () => {
    const pasada = regla({ validTo: "2026-09-01", priceCents: 3000 });
    expect(resolvePrice(entrada({ rules: [pasada] })).totalCents).toBe(
      PISTA.basePriceCents,
    );
  });

  it("valid_from es INCLUSIVO: el primer dia ya aplica", () => {
    // Si fuera exclusivo, la tarifa empezaria un dia tarde y el club no ve el dia
    // perdido, porque el total cuadra igual los dos dias.
    const hoy = regla({ validFrom: "2026-09-27", priceCents: 3000 });
    expect(resolvePrice(entrada({ rules: [hoy] })).totalCents).toBe(3000);
  });

  it("valid_to es INCLUSIVO: el ultimo dia todavia aplica", () => {
    // Un exclusive en la fecha de caducidad daria un dia gratis. El club se entera
    // porque el socio le dice que le cobraron, y le Cree.
    const hastaHoy = regla({ validTo: "2026-09-27", priceCents: 3000 });
    expect(resolvePrice(entrada({ rules: [hastaHoy] })).totalCents).toBe(3000);
  });

  it("ambos extremos abiertos a la vez cubre la ventana entera", () => {
    const ventana = regla({ validFrom: "2026-09-01", validTo: "2026-09-30" });
    expect(resolvePrice(entrada({ rules: [ventana] })).totalCents).toBe(2000);
  });
});

describe("resolvePrice: la franja horaria tiene que CONTENER el slot entero", () => {
  const punta = (inicio: string, fin: string): PricingRule =>
    regla({ startTime: inicio, endTime: fin, priceCents: 3000 });

  it("un slot que empieza en start_time y cabe entero aplica", () => {
    expect(
      resolvePrice(entrada({ rules: [punta("10:00", "12:00")], startsAt: DOMINGO })).totalCents,
    ).toBe(3000);
  });

  it("un slot que empieza JUSTO en end_time no aplica", () => {
    // `[10:00, 12:00)` es medio abierto. Un slot que empieza a las 12:00 pertenece a
    // la franja SIGUIENTE, no a esta. Con `<=` en el final, dos franjas contiguas se
    // pisan y la hora de la frontera se cobra al precio que toque segun el orden de
    // las reglas.
    expect(
      resolvePrice(
        entrada({ rules: [punta("10:00", "12:00")], startsAt: "2026-09-27T12:00" }),
      ).totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("un slot que se sale por el FINAL de la franja no aplica", () => {
    // 90 min a las 20:30 terminan a las 22:00 y la franja punta termina a las 21:00.
    // Con la regla de "basta con empezar dentro", este slot cobran punta siendo medio
    // horario normal, que es la fuga de dinero mas facil de no ver.
    expect(
      resolvePrice(
        entrada({ rules: [punta("18:00", "21:00")], startsAt: "2026-09-27T20:30" }),
      ).totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("un slot que se sale por el PRINCIPIO de la franja no aplica", () => {
    expect(
      resolvePrice(
        entrada({ rules: [punta("10:00", "12:00")], startsAt: "2026-09-27T08:30" }),
      ).totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("un slot que cabe JUSTO entero, milimetro a milimetro, aplica", () => {
    // 10:00-11:30 con un slot de 90 min. El borde de "cabe entero" con un minuto de
    // mas (11:31) ya no aplica, y ese caso es el que sale en el test de al lado.
    expect(
      resolvePrice(entrada({ rules: [punta("10:00", "11:30")], startsAt: DOMINGO })).totalCents,
    ).toBe(3000);
    expect(
      resolvePrice(
        entrada({ rules: [punta("10:00", "11:29")], startsAt: DOMINGO }),
      ).totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("un slot que toca dos franjas cobra la que lo contiene entero, no la que toca", () => {
    // El slot de 10:30 a 12:00 cabe entero en 10:00-14:00 y solo se solapa con
    // 10:00-11:00. Las dos reglas tienen la MISMA especificidad, prioridad y fechas,
    // asi que el unico criterio que puede decidirlas es la contencion. Con la
    // semantica de "basta con empezar dentro" las dos aplicarian y ganaria la que
    // tuviera el id menor, que aqui es la corta: la punta se pierde justo en la hora
    // de la punta.
    const corta = regla({
      id: "corta",
      startTime: "10:00",
      endTime: "11:00",
      priceCents: 3000,
    });
    const larga = regla({
      id: "larga",
      startTime: "10:00",
      endTime: "14:00",
      priceCents: 4000,
    });
    const quote = resolvePrice(
      entrada({ rules: [corta, larga], startsAt: "2026-09-27T10:30" }),
    );
    expect(quote.ruleId).toBe("larga");
    expect(quote.totalCents).toBe(4000);
  });

  it("start_time igual a end_time es una franja de cero minutos y no aplica nunca", () => {
    expect(
      resolvePrice(entrada({ rules: [punta("10:00", "10:00")], startsAt: DOMINGO })).totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("start_time mayor que end_time no aplica nunca, y no revienta", () => {
    // Decision del spec de T7: una franja que cruza medianoche no se interpreta, se
    // ignora, y la base lo prohibe con un `check` en T12. Con el horario 8:00-22:00
    // del club no hay ningun slot que caiga ahi, asi que ignorarla no cambia un
    // importe: solo evita escribir un test para un caso imposible. Y no revienta,
    // porque un dato mal puesto en el panel no puede tirar la disponibilidad de todo
    // el club.
    expect(
      resolvePrice(
        entrada({ rules: [punta("22:00", "02:00")], startsAt: "2026-09-27T23:30" }),
      ).totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("la franja se compara en el minuto del dia, con 24:00 como cierre", () => {
    // 24:00 = 1440 minutos, no 0. Si `endTime: "24:00"` se parsease como medianoche
    // (0 minutos), la regla coversaria un franja de 24 horas hacia atras y no
    // aplicaria a un slot de las 20:00, que es el horario de puntero de cualquier club.
    expect(
      resolvePrice(
        entrada({ rules: [punta("00:00", "24:00")], startsAt: "2026-09-27T20:00" }),
      ).totalCents,
    ).toBe(3000);
  });
});

describe("resolvePrice: la duracion de la regla tiene que coincidir", () => {
  it("una regla de 60 min no cobra una reserva de 90", () => {
    // Decision del spec de T7. Sin este filtro, el codigo de ejemplo de la seccion 10
    // de la spec aplicaria una tarifa de slot corto a uno largo, y el club pierde el
    // 33% de esa hora sin que nadie lo vea en ningun sitio.
    expect(
      resolvePrice(entrada({ rules: [regla({ durationMin: 60, priceCents: 1500 })] }))
        .totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("una regla de 120 min no cobra una reserva de 90", () => {
    expect(
      resolvePrice(entrada({ rules: [regla({ durationMin: 120, priceCents: 3500 })] }))
        .totalCents,
    ).toBe(PISTA.basePriceCents);
  });

  it("una regla de 90 min si cobra una reserva de 90", () => {
    expect(
      resolvePrice(entrada({ rules: [regla({ durationMin: 90, priceCents: 2500 })] }))
        .totalCents,
    ).toBe(2500);
  });
});

describe("resolvePrice: is_active", () => {
  it("una regla desactivada no aplica, por muy especifica que sea", () => {
    // Una regla de `court` desactivada que ganara por especificidad es la forma
    // facil de dejar de cobrar la tarifa de una pista sin querer, y el sintoma es que
    // el precio baja y el club no sabe por que.
    const apagada = regla({
      scope: "court",
      courtId: PISTA.id,
      priceCents: 3000,
      isActive: false,
    });
    expect(resolvePrice(entrada({ rules: [apagada] })).totalCents).toBe(
      PISTA.basePriceCents,
    );
  });
});

describe("resolvePrice: player_multiplier", () => {
  it("con 3 jugadores devuelve precio x 3", () => {
    const porJugador = regla({ priceCents: 1000, playerMultiplier: true });
    const quote = resolvePrice(entrada({ rules: [porJugador], numPlayers: 3 }));
    expect(quote.totalCents).toBe(3000);
  });

  it("con 4 jugadores devuelve precio x 4, y no x 3", () => {
    const porJugador = regla({ priceCents: 1000, playerMultiplier: true });
    expect(resolvePrice(entrada({ rules: [porJugador], numPlayers: 4 })).totalCents).toBe(
      4000,
    );
  });

  it("con 2 jugadores devuelve precio x 2, el minimo de la pista", () => {
    const porJugador = regla({ priceCents: 1000, playerMultiplier: true });
    expect(resolvePrice(entrada({ rules: [porJugador], numPlayers: 2 })).totalCents).toBe(
      2000,
    );
  });

  it("sin multiplicar, 3 jugadores siguen pagando el precio de la regla", () => {
    // El fallo clasico es multiplicar siempre. Aqui el club pone una tarifa por
    // SLOT y el multiplicador se olvida a proposito; si se aplicara siempre, cobraria
    // cuatro veces lo que puso.
    const porSlot = regla({ priceCents: 3000, playerMultiplier: false });
    expect(resolvePrice(entrada({ rules: [porSlot], numPlayers: 4 })).totalCents).toBe(
      3000,
    );
  });

  it("el desglose nombra la regla y el numero de jugadores cuando multiplica", () => {
    const porJugador = regla({
      id: "punta",
      name: "Tarifa punta 18-21h",
      priceCents: 1000,
      playerMultiplier: true,
    });
    const quote = resolvePrice(entrada({ rules: [porJugador], numPlayers: 3 }));
    expect(quote.ruleName).toBe("Tarifa punta 18-21h");
    expect(quote.breakdown[0]).toEqual({ label: "Tarifa punta 18-21h", cents: 3000 });
    // La linea de jugadores lleva 0 a proposito: no es un cobro, es el factor que se
    // ha aplicado. Una UI que la pinte como importe ensena al socio que le cobran
    // 0,00 por los jugadores. El aviso queda en findings.md para T12, que es quien
    // pinta este desglose.
    expect(quote.breakdown[1]).toEqual({ label: "3 jugadores", cents: 0 });
  });

  it("sin multiplicar el desglose tiene una sola linea", () => {
    const porSlot = regla({ name: "Tarifa normal" });
    expect(resolvePrice(entrada({ rules: [porSlot] })).breakdown).toHaveLength(1);
  });

  it("las lineas del desglose suman siempre el total", () => {
    // Esta es la propiedad que hace util el desglose: se guarda en `bookings` y lo que
    // no cuadra no se puede explicar despues. Con multiplicador y sin el.
    const porJugador = regla({ priceCents: 1000, playerMultiplier: true });
    for (const reglas of [[porJugador], [regla({ priceCents: 2500 })]]) {
      const quote = resolvePrice(entrada({ rules: reglas, numPlayers: 3 }));
      const suma = quote.breakdown.reduce((acc: number, linea) => acc + linea.cents, 0);
      expect(suma).toBe(quote.totalCents);
    }
  });
});

describe("resolvePrice: pura", () => {
  it("los mismos datos de entrada dan el mismo precio, siempre", () => {
    const entradaFija = entrada({ rules: [regla({ priceCents: 3000, priority: 1 })] });
    const precios = Array.from({ length: 5 }, () => resolvePrice(entradaFija).totalCents);
    expect(precios).toEqual([3000, 3000, 3000, 3000, 3000]);
  });

  it("no reordena el array de reglas que le pasan", () => {
    // Si ordenara `input.rules` en el sitio, la segunda llamada con el mismo array
    // daria el mismo resultado por casualidad y la primera habria mutado datos del
    // llamante. Un `sort` sin copia es un bug que aparece cuando dos endpoints
    // comparten la lista de reglas.
    const rules = [
      regla({ id: "b", priceCents: 1000, priority: 1 }),
      regla({ id: "a", priceCents: 5000, priority: 9 }),
    ];
    const copia = [...rules];
    resolvePrice(entrada({ rules }));
    expect(rules).toEqual(copia);
  });

  it("el resultado no depende del orden en que llegan las reglas", () => {
    const reglas = [
      regla({ id: "global", priceCents: 1000 }),
      regla({ id: "por-tipo", scope: "court_type", courtType: "cristal", priceCents: 2200 }),
      regla({ id: "por-pista", scope: "court", courtId: PISTA.id, priceCents: 2400 }),
    ];
    const ordenadas = resolvePrice(entrada({ rules: reglas })).ruleId;
    const revueltas = resolvePrice(entrada({ rules: [...reglas].reverse() })).ruleId;
    expect(ordenadas).toBe("por-pista");
    expect(revueltas).toBe(ordenadas);
  });
});

describe("resolvePrice: lo que revienta en vez de devolver un precio", () => {
  it("un startsAt con formato raro", () => {
    expect(() => resolvePrice(entrada({ startsAt: "2026-09-27" }))).toThrow();
    expect(() => resolvePrice(entrada({ startsAt: "27/09/2026 10:00" }))).toThrow();
    expect(() => resolvePrice(entrada({ startsAt: "no-es-una-fecha" }))).toThrow();
    // Sin minutos. "10" no es una hora y ademas es la forma en que se cuela un
    // `startsAt` cuando el cliente manda solo la fecha.
    expect(() => resolvePrice(entrada({ startsAt: "2026-09-27T10" }))).toThrow();
  });

  it("un startsAt con zona horaria, que es lo que sale de la base sin convertir", () => {
    // La decision mas importante del motor. `bookings.starts_at` es `timestamptz`, asi
    // que lo que llega de la base trae `Z`, y las 10:00 con `Z` de un club de Madrid en
    // verano son las 12:00 del club. Si el motor las TOMARA como locales, aplicaria la
    // franja de las 10:00 dos horas tarde, y el error cambiaria con el horario de
    // verano sin que nadie toque nada.
    expect(() =>
      resolvePrice(entrada({ rules: [regla({ startTime: "10:00", endTime: "12:00" })], startsAt: "2026-09-27T10:00:00Z" })),
    ).toThrow(/zona/i);
    expect(() =>
      resolvePrice(entrada({ startsAt: "2026-09-27T10:00+02:00" })),
    ).toThrow(/zona/i);
    // Y el mensaje dice que hacer, no solo que esta mal.
    expect(() =>
      resolvePrice(entrada({ startsAt: "2026-09-27T10:00:00Z" })),
    ).toThrow(/hora local/i);
  });

  it("un startsAt con segundos si vale, porque los segundos no cambian de tarifa", () => {
    // `timestamptz` los trae. Dos instants que se diferencian en segundos son el mismo
    // slot, y un motor que los distinguiera cobraria distinto a las 10:00:00 y a las
    // 10:00:59.
    expect(
      resolvePrice(entrada({ rules: [regla({ priceCents: PUNTAL })], startsAt: "2026-09-27T10:00:59" }))
        .totalCents,
    ).toBe(PUNTAL);
  });

  it("un startsAt con una hora que no existe", () => {
    expect(() => resolvePrice(entrada({ startsAt: "2026-09-27T25:00" }))).toThrow();
    expect(() => resolvePrice(entrada({ startsAt: "2026-09-27T10:60" }))).toThrow();
    // 24:00 es el cierre del dia, no una hora de reloj. Como inicio de un slot es una
    // reserva de 24:00 que no existe.
    expect(() => resolvePrice(entrada({ startsAt: "2026-09-27T24:30" }))).toThrow();
  });

  it("una duracion o un numero de jugadores que no son numeros", () => {
    // `NaN` pasa el `<= 0` (comparar con NaN da false) y llegaria hasta el precio, que
    // seria `NaN`. `NaN` no es menor que 0, asi que el guardia tiene que ser `isFinite`
    // y no solo el signo.
    expect(() => resolvePrice(entrada({ durationMin: Number.NaN }))).toThrow();
    expect(() => resolvePrice(entrada({ numPlayers: Number.NaN }))).toThrow();
    expect(() => resolvePrice(entrada({ numPlayers: Number.POSITIVE_INFINITY }))).toThrow();
  });

  it("una fecha de calendario que no existe", () => {
    // El 30 de febrero. La validacion de formato lo deja pasar (30 <= 31) y el dia de
    // la semana saldria de una fecha que no existe. T12 lo prohibe en la base y la API
    // exige el formato, pero aqui el dato lo pone quien llama y un precio calculado
    // sobre un dia inexistente no es un precio.
    expect(() => resolvePrice(entrada({ startsAt: "2026-02-30T10:00" }))).toThrow();
    expect(() => resolvePrice(entrada({ startsAt: "2026-13-01T10:00" }))).toThrow();
    expect(() => resolvePrice(entrada({ startsAt: "2026-09-00T10:00" }))).toThrow();
  });

  it("el 29 de febrero de un ano bisiesto si vale", () => {
    // 2024 es bisiesto y el 29 de febrero fue un jueves. Si la comprobacion de dias
    // por mes usara la regla simple (todo febrero tiene 28) rechazaria una fecha
    // real, y el dia de la semana de un 29 de febrero nunca se podria usar.
    expect(
      resolvePrice(
        entrada({
          rules: [regla({ dayOfWeek: [4], priceCents: PUNTAL })],
          startsAt: "2024-02-29T10:00",
        }),
      ).totalCents,
    ).toBe(PUNTAL);
  });

  it("el 29 de febrero de 2100 no vale, porque 2100 no es bisiesto", () => {
    // El otro sentido de la regla del bisiesto: divisible por 100 pero no por 400.
    expect(() => resolvePrice(entrada({ startsAt: "2100-02-29T10:00" }))).toThrow();
  });

  it("febrero de los tres tipos de ano: no bisiesto, bisiesto y divisible por 400", () => {
    // Los tres caminos de la regla del bisiesto, con el ultimo dia de cada febrero. Con
    // `year % 4` a pelo, 2000-02-29 se rechazaria y el dia de la semana de las fechas de
    // febrero del 2000 saldria desplazado.
    expect(resolvePrice(entrada({ startsAt: "2023-02-28T10:00" })).totalCents).toBe(
      PISTA.basePriceCents,
    );
    expect(resolvePrice(entrada({ startsAt: "2024-02-29T10:00" })).totalCents).toBe(
      PISTA.basePriceCents,
    );
    expect(resolvePrice(entrada({ startsAt: "2000-02-29T10:00" })).totalCents).toBe(
      PISTA.basePriceCents,
    );
    // Y los tres dias 30 de febrero, que no existen en ninguno de los tres.
    expect(() => resolvePrice(entrada({ startsAt: "2023-02-30T10:00" }))).toThrow();
    expect(() => resolvePrice(entrada({ startsAt: "2000-02-30T10:00" }))).toThrow();
  });

  it("numPlayers = 0", () => {
    // Con multiplicador, 0 jugadores daria un precio de 0 que el club regala. Sin
    // multiplicador, 0 jugadores es una reserva que no significa nada. Las dos cosas
    // son datos que no deberían llegar, y fallar es mas util que devolver 0.
    expect(() => resolvePrice(entrada({ numPlayers: 0 }))).toThrow();
    expect(() => resolvePrice(entrada({ numPlayers: -1 }))).toThrow();
  });

  it("durationMin = 0", () => {
    // Un slot de 0 minutos cabe en cualquier franja y haria que una regla de punta
    // aplicase a una "reserva" de 0 minutos.
    expect(() => resolvePrice(entrada({ durationMin: 0 }))).toThrow();
  });

  it("una regla con la hora mal escrita", () => {
    expect(() => resolvePrice(entrada({ rules: [regla({ startTime: "8:00" })] }))).toThrow();
    expect(() => resolvePrice(entrada({ rules: [regla({ endTime: "22h" })] }))).toThrow();
    expect(() => resolvePrice(entrada({ rules: [regla({ startTime: "8" })] }))).toThrow();
  });

  it("una regla con una hora que no existe, como las 25:00", () => {
    // 24:00 si vale (Postgres lo admite y es el cierre del dia). 25:00 no.
    expect(
      resolvePrice(entrada({ rules: [regla({ endTime: "24:00", priceCents: 3000 })] }))
        .totalCents,
    ).toBe(3000);
    expect(() =>
      resolvePrice(entrada({ rules: [regla({ endTime: "25:00" })] })),
    ).toThrow();
    expect(() =>
      resolvePrice(entrada({ rules: [regla({ endTime: "10:60" })] })),
    ).toThrow();
  });

  it("el mensaje nombra el dato que esta mal", () => {
    // Un error sin decir cual de los tres campos falla obliga a abrir el debugger
    // para un fallo de datos. El mensaje dice el valor recibido.
    expect(() => resolvePrice(entrada({ startsAt: "ayer" }))).toThrow(/ayer/);
  });
});
