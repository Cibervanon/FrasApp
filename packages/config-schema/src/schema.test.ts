import { describe, expect, it } from "vitest";

import {
  MVP_FEATURE_KEYS,
  cancellationPolicySchema,
  featureKeySchema,
  tenantConfigSchema,
} from "./schema.js";

const validBranding = {
  primary_color: "#1a4d8f",
  secondary_color: "#e8a33d",
  logo_path: null,
  favicon_path: null,
  hero_image_path: null,
  font_family: "Inter",
  email_from_name: "Club Padel Norte",
  email_reply_to: "padel@clubnorte.example",
};

const validPolicy = {
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
    { hours_before: 0, refund_percent: 0, label: "Con menos de 12h no hay devolucion" },
  ],
  policy_text: "Texto de la politica",
  notice_text: "Texto del aviso",
};

describe("config-schema: feature_key", () => {
  it("acepta exactamente las 7 features del MVP de la spec", () => {
    // Si la spec anade o quita una feature, este test obliga a actualizar la
    // seed de T1 en el mismo commit. Regla 3: sin excepcion.
    expect([...MVP_FEATURE_KEYS]).toEqual([
      "calendar",
      "booking",
      "payments",
      "open_matches",
      "news",
      "gdpr_export",
      "push_notifications",
    ]);
  });

  it("MVP_FEATURE_KEYS no tiene duplicados", () => {
    expect(new Set(MVP_FEATURE_KEYS).size).toBe(MVP_FEATURE_KEYS.length);
  });

  it("rechaza una feature que no existe en la spec", () => {
    const result = featureKeySchema.safeParse("guest_bookings");
    expect(result.success).toBe(false);
  });

  it("rechaza una feature inventada por el cliente", () => {
    const result = featureKeySchema.safeParse("discount_coupons");
    expect(result.success).toBe(false);
  });
});

describe("config-schema: contrato de tenant", () => {
  it("acepta un tenant valido con la forma de la BD", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      min_player_age: 18,
      branding: validBranding,
      features: ["booking", "payments"],
      content: { cancellation_policy: validPolicy },
    });

    expect(result.success).toBe(true);
  });

  it("aplica los defaults de la spec a min_player_age, currency, timezone y locale", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      branding: validBranding,
      features: [],
      content: {},
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.min_player_age).toBe(18);
      expect(result.data.currency).toBe("eur");
      expect(result.data.timezone).toBe("Europe/Madrid");
      expect(result.data.locale).toBe("es-ES");
    }
  });

  /**
   * Antes esto era `expect(result.success).toBe(false)`, que pasa igual si el esquema
   * rechaza el color por el nombre del club, por el slug o porque lo rechaza TODO.
   * Un test de rechazo que no mira el motivo no sabe que color esta probando.
   *
   * Por eso se mira `issue.path`: tiene que señalar el campo del color, y solo ese.
   */
  function colorError(primaryColor: unknown): string[] {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      branding: { ...validBranding, primary_color: primaryColor },
      features: [],
      content: {},
    });
    if (result.success) return [];
    return result.error.issues.map((issue) => issue.path.join("."));
  }

  it("rechaza un color que no es hex de 6 digitos, y solo por el color", () => {
    const paths = colorError("rojo");
    expect(paths.length).toBeGreaterThan(0);
    // `branding.primary_color` y nada mas: si tambien se quejara del nombre, este
    // test estaria pasando por el motivo equivocado.
    expect(paths.every((path) => path === "branding.primary_color")).toBe(true);
  });

  it("rechaza las formas de color que un gestor teclea sin querer", () => {
    // Cada uno de estos llega de verdad: alguien pega el color de un diseno, o lo
    // copia de una herramienta que da `#fff` en vez de `#ffffff`.
    for (const bad of ["#fff", "1a4d8f", "#1a4d8", "#1a4d8ff", "rgb(26,77,143)", "#gggggg", ""]) {
      expect(colorError(bad), `deberia rechazar ${JSON.stringify(bad)}`).not.toEqual([]);
    }
  });

  it("acepta un hex de 6 digitos en mayusculas y minusculas", () => {
    // A veces el color viene de un Figma en mayusculas. Rechazarlo seria testar el
    // capricho del regex, no la regla.
    expect(colorError("#1A4D8F")).toEqual([]);
    expect(colorError("#1a4d8f")).toEqual([]);
  });

  /**
   * `font_family` va al estilo de la pagina, asi que el mismo truco que el color: mirar el
   * `path` del fallo, para no pasar por el motivo equivocado. Un `z.string()` acepta
   * cualquier cosa, y este helper es el que dice si la lista blanca aguanta.
   */
  function fontError(fontFamily: unknown): string[] {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      branding: { ...validBranding, font_family: fontFamily },
      features: [],
      content: {},
    });
    if (result.success) return [];
    return result.error.issues.map((issue) => issue.path.join("."));
  }

  it("rechaza un `font_family` que no puede ser un nombre de fuente", () => {
    // Cada uno de estos cabe en el tope de 80 caracteres, que es lo que el esquema pedia
    // antes: el problema no era la longitud, era que no habia ninguna lista.
    const invalidos: ReadonlyArray<readonly [string, string]> = [
      ["punto y coma", "Inter; display: none"],
      ["cierre de bloque", "Inter } body {"],
      ["apertura de bloque", "Inter {color: red"],
      ["url()", "Inter, url(https://ejemplo.test/f.woff)"],
      ["comentario", "Inter /*"],
      ["comentario cerrado", "Inter */ body {display:none} /*"],
      ["dos puntos", "Inter: red"],
      ["barra invertida", "Inter\\3B color:red"],
      ["comilla simple sin cerrar", "Inter'"],
      ["llave de javascript", "Inter${alert(1)}"],
    ];

    for (const [motivo, valor] of invalidos) {
      const paths = fontError(valor);
      expect(
        paths.length,
        `${motivo}: deberia rechazar ${JSON.stringify(valor)}`,
      ).toBeGreaterThan(0);
      // Solo `font_family`: si el rechazo viniera por otra columna, el test pasaria sin
      // haber probado lo que dice probar.
      expect(
        paths.every((path) => path === "branding.font_family"),
        `${motivo}: fallo por ${paths.join(", ")}`,
      ).toBe(true);
    }
  });

  it("acepta las pilas de fuentes que se ponen de verdad", () => {
    // Si la lista blanca fuera demasiado estrecha, el efecto seria que el gestor escribe
    // "Inter, system-ui, sans-serif", no se guarda, y no se queja nadie porque el error es
    // un 500. Estos son los valores legitimos que hay que dejar pasar.
    const validos = [
      "Inter",
      "Inter, system-ui, sans-serif",
      "'Helvetica Neue', Arial, sans-serif",
      '"Segoe UI", Roboto, sans-serif',
      "Source-Sans-3",
    ];

    for (const valor of validos) {
      expect(fontError(valor), `deberia aceptar ${JSON.stringify(valor)}`).toEqual([]);
    }
  });

  it("sigue rechazando un `font_family` vacio o larguisimo", () => {
    // La lista blanca no sustituye a los otros dos limites: una cadena de 80 espacios es
    // valida para la regex y no es ninguna fuente.
    expect(fontError("")).not.toEqual([]);
    expect(fontError("A".repeat(81))).not.toEqual([]);
  });

  it("rechaza min_player_age fuera del rango 14-21", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      min_player_age: 12,
      branding: validBranding,
      features: [],
      content: {},
    });

    expect(result.success).toBe(false);
  });

  it("rechaza un email_reply_to que no es email", () => {
    const result = tenantConfigSchema.safeParse({
      id: "3f9a1c62-0b7d-4c8e-9a11-5d2e7b4c1a90",
      name: "Club Padel Norte",
      slug: "club-norte",
      branding: { ...validBranding, email_reply_to: "no-es-un-email" },
      features: [],
      content: {},
    });

    expect(result.success).toBe(false);
  });
});

describe("config-schema: politica de cancelacion", () => {
  it("rechaza dos tramos con el mismo hours_before", () => {
    const result = cancellationPolicySchema.safeParse({
      ...validPolicy,
      tiers: [
        { hours_before: 24, refund_percent: 100, label: "a" },
        { hours_before: 24, refund_percent: 50, label: "b" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rechaza que con menos aviso se devuelva mas", () => {
    const result = cancellationPolicySchema.safeParse({
      ...validPolicy,
      tiers: [
        { hours_before: 24, refund_percent: 50, label: "a" },
        { hours_before: 12, refund_percent: 100, label: "b" },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("acepta la escalera por defecto de la spec", () => {
    // 24h->100%, 12h->50%, 0h->0%. Menos aviso, menos devolucion: coherente.
    const result = cancellationPolicySchema.safeParse(validPolicy);
    expect(result.success).toBe(true);
  });

  it("exige label en cada tramo, porque lo ve el socio", () => {
    const result = cancellationPolicySchema.safeParse({
      ...validPolicy,
      tiers: [{ hours_before: 0, refund_percent: 0 }],
    });

    expect(result.success).toBe(false);
  });

  it("acepta un tramo del 100% hasta el final", () => {
    const result = cancellationPolicySchema.safeParse({
      ...validPolicy,
      tiers: [{ hours_before: 0, refund_percent: 100, label: "Siempre reembolsable" }],
    });

    expect(result.success).toBe(true);
  });
});
