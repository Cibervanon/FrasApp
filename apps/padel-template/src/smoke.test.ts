import { describe, expect, it } from "vitest";

import { tenantConfigSchema } from "@frasapp/config-schema";
import type { BookingStatus } from "@frasapp/core";

/**
 * Smoke test de T0 en la app. No prueba UI: **prueba que los tres paquetes se
 * resuelven entre si desde aqui**.
 *
 * Este es el fallo real que T0 puede tener y que un typecheck suelto no
 * detecta: que los `exports` de `package.json` apunten mal y la app no
 * encuentre `@frasapp/core` al ejecutar, aunque `tsc` la resolviera por otra
 * via. Por eso importa que el test **importe** de verdad.
 */
describe("app: consumo de los packages del monorepo", () => {
  it("resuelve @frasapp/config-schema en runtime", () => {
    const result = tenantConfigSchema.safeParse({
      slug: "club-norte",
      name: "Club Padel Norte",
      minPlayerAge: 18,
      branding: {
        primaryColor: "#1a4d8f",
        accentColor: "#e8a33d",
        logoUrl: null,
        senderName: "Club Padel Norte",
        replyToEmail: "padel@clubnorte.example",
      },
      features: ["online_payments"],
      cancellationPolicy: {
        tiers: [
          { minHoursBefore: 24, percent: 100 },
          { minHoursBefore: 12, percent: 50 },
          { minHoursBefore: 0, percent: 0 },
        ],
      },
    });

    expect(result.success).toBe(true);
  });

  it("recibe los tipos de dominio de @frasapp/core", () => {
    // Solo tipos: en runtime no queda nada que comprobar. Es el typecheck el
    // que valida esto. El test documenta que la dependencia existe.
    const status: BookingStatus = "held";
    expect(status).toBe("held");
  });
});
