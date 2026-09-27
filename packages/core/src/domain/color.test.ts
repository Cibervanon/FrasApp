import { describe, expect, it } from "vitest";

import { readableForeground } from "./color.js";

/**
 * Los numeros de estos tests salen de la formula de WCAG, no de lo que devuelve la
 * funcion. Si se copiaran de la salida de la funcion, el test compararia la funcion
 * consigo misma y pasaria aunque la formula estuviese mal.
 */
describe("readableForeground", () => {
  describe("los colores que se leen con blanco", () => {
    it("el negro", () => {
      expect(readableForeground("#000000")).toBe("#ffffff");
    });

    it("el azul de la marca por defecto, que es un 7.4:1 con blanco", () => {
      // #1d4ed8 -> 7.36:1 con blanco, y 4.6:1 con negro. Con estos numeros, cambiar a
      // negro "para dar mas contraste" empeoraria el boton. El criterio no es "el mas
      // alto", es "el que gana", y aqui gana el blanco.
      expect(readableForeground("#1d4ed8")).toBe("#ffffff");
    });

    it("el verde pista", () => {
      expect(readableForeground("#166534")).toBe("#ffffff");
    });
  });

  describe("los colores que se leen con negro", () => {
    it("el blanco", () => {
      expect(readableForeground("#ffffff")).toBe("#000000");
    });

    it("el amarillo palido, que es el caso que motiva la funcion", () => {
      // #f5e642 -> 1.3:1 con blanco. Un boton con texto blanco encima de este color es
      // un boton que no se ve, y este es un color de pista de playa.
      expect(readableForeground("#f5e642")).toBe("#000000");
    });

    it("el verde cesped claro", () => {
      expect(readableForeground("#a3e635")).toBe("#000000");
    });
  });

  describe("los limites, que son donde una funcion asi se equivoca", () => {
    it("en el gris medio gana el NEGRO, no el blanco", () => {
      // #808080 tiene L = 0.216. Con blanco da 1.05 / (0.216 + 0.05) = 3.95:1, y con
      // negro (0.216 + 0.05) / 0.05 = 5.32:1. Gana el negro por mas de un punto, y este
      // test existe porque el ojo se equivoca aqui: el gris se ve "claro" y la
      // intuicion dice blanco. La funcion no tiene intuicion, tiene numeros.
      expect(readableForeground("#808080")).toBe("#000000");
    });

    it("el gris mas claro de los dos, ya del lado del negro", () => {
      // #767676 tiene L = 0.18116, dos milésimas por encima del punto de empate
      // (0.17913). Con blanco da 4.54:1 y con negro 4.62:1, o sea que gana el negro por
      // ocho centesimas de punto. Es el borde que de verdad importa: con el umbral
      // puesto en 0.18 "por redondear", este color pasaria al lado blanco.
      expect(readableForeground("#767676")).toBe("#000000");
    });

    it("y un 1/255 mas oscuro, ya del lado del blanco", () => {
      // #757575 tiene L = 0.17789: con blanco 4.61:1 y con negro 4.56:1, gana el blanco.
      // Los dos grises estan a un paso el uno del otro porque el punto de empate cae
      // entre los dos, y por eso el test acota la frontera con los numeros en vez de
      // confiar en el comentario: si alguien mueve el umbral, uno de estos dos falla.
      expect(readableForeground("#757575")).toBe("#ffffff");
    });
  });

  describe("los formatos que llegan desde la base", () => {
    it("acepta `#` en mayusculas", () => {
      expect(readableForeground("#FFFFFF")).toBe("#000000");
    });

    it("acepta tres digitos, que en CSS significa lo mismo", () => {
      // `#fff` es blanco. Sin la normalizacion, `parseInt("f", 16)` daria 15 y el canal
      // rojo valdria 15 en vez de 255, o sea casi negro, y el texto saldria blanco sobre
      // un fondo que el gestor pidio blanco.
      expect(readableForeground("#fff")).toBe("#000000");
      expect(readableForeground("#fff")).toBe(readableForeground("#ffffff"));
    });

    it("acepta el color sin la almohadilla", () => {
      expect(readableForeground("000000")).toBe("#ffffff");
    });
  });

  it("devuelve un color que se puede meter en un style sin mas", () => {
    // Los dos candidatos son de la misma forma, sin alpha y en 6 digitos, para que el
    // `style` no reciba un `#fff` al lado de un `#000000`.
    for (const fondo of ["#000000", "#ffffff", "#f5e642", "#1d4ed8"]) {
      expect(readableForeground(fondo)).toMatch(/^#(?:[0-9a-f]{2}){3}$/);
    }
  });
});
