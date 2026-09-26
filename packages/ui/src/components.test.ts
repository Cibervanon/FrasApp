import { describe, expect, it } from "vitest";

import { brandVars } from "./components.js";

/**
 * Smoke test de T0. En T0 no hay DOM que renderizar todavia, asi que esto
 * comprueba lo unico que se puede comprobar sin montar: que la capa `ui` no
 * arrastra logica ni configuracion de tenant.
 */
describe("ui: capa presentacional", () => {
  it("expone los colores como variables CSS, no como valores fijos", () => {
    const style = brandVars({ primary: "#123456", accent: "#abcdef" });

    expect(style["--brand-primary"]).toBe("#123456");
    expect(style["--brand-accent"]).toBe("#abcdef");
  });
});
