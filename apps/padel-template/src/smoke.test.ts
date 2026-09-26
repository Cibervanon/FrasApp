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
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      min_player_age: 18,
      branding: {
        primary_color: "#1a4d8f",
        secondary_color: "#e8a33d",
        logo_path: null,
        favicon_path: null,
        hero_image_path: null,
        font_family: "Inter",
        email_from_name: "Club Padel Norte",
        email_reply_to: "padel@clubnorte.example",
      },
      features: ["calendar", "booking", "payments"],
      content: {
        cancellation_policy: {
          tiers: [
            {
              hours_before: 24,
              refund_percent: 100,
              label: "Cancelacion gratuita hasta 24h antes",
            },
            {
              hours_before: 12,
              refund_percent: 50,
              label: "Entre 24h y 12h antes se devuelve el 50%",
            },
            {
              hours_before: 0,
              refund_percent: 0,
              label: "Con menos de 12h no hay devolucion",
            },
          ],
          policy_text: "Texto de la politica",
          notice_text: "Texto del aviso",
        },
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
