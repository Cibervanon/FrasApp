import { z } from "zod";

/**
 * Contrato de configuracion de un tenant. Zod, porque este objeto cruza la
 * frontera entre la base de datos y la UI: si la BD trae algo mal, quiero que
 * falle aqui y no con un `undefined` en pantalla.
 *
 * **Espejo de la base de datos, en snake_case.** A proposito, no por descuido.
 * Este esquema valida lo que *viene de la BD*, asi que si un parseo falla el
 * error senala una columna real (`primary_color`) y no un campo inventado
 * (`primaryColor`). Una capa de mapeo seria mas agradable en la UI, pero
 * anade un sitio mas donde el esquema puede desincronizarse de la migracion
 * sin que nada lo note. La app convierte a camelCase en el borde de la UI si
 * lo quiere.
 *
 * Los **valores por defecto** de la spec (18 anos, 90 minutos, tramos 24/12h,
 * 3 min de hold) NO viven aqui: son constantes del dominio, no configuracion de
 * tenant, y van en `core`.
 */

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color hex de 6 digitos, con # inicial");

/**
 * Rutas de fichero en Supabase Storage, no URLs. Se guardan relativas al
 * bucket para que cambien de dominio no rompan nada.
 */
const storagePath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9/_.-]+$/, "Ruta de Storage: sin espacios ni esquema");

/**
 * `font_family`: una PILA de fuentes CSS, no texto libre.
 *
 * `tenant_branding.font_family` no tiene `check` en la migracion, asi que la base acepta
 * cualquier texto, y antes de T6 el esquema solo ponia un tope de 80 caracteres. T6c es el
 * primer consumidor del valor (lo aplica al estilo de la pagina), y con un `z.string()` un
 * `Inter; } body { display: none` cabe de sobra en 80 caracteres.
 *
 * Son DOS reglas, y hacen falta las dos. La regex quita los caracteres que tienen SINTAXIS
 * de CSS: `;` cierra una declaracion, `{` y `}` abren y cierran un bloque, `:` y `(` abren
 * una funcion, `/` y `*` abren un comentario, y la barra invertida escapa. Con eso el
 * valor no puede dejar de ser un nombre de fuente por mas que se intente.
 *
 * La segunda regla son las comillas, y existe porque la primera se quedaba corta: un
 * `Inter'` con la comilla sin cerrar pasa una lista de caracteres permitidos, y no es un
 * nombre de fuente. Las comillas son necesarias de verdad (`'Helvetica Neue'` es un nombre
 * legitimo y sin comillas seria dos fuentes), asi que no se quitan: se exigen
 * EMPAREJADAS y del mismo tipo. Con eso un valor con comillas es siempre un nombre citado
 * bien cerrado, que es la unica forma en que un gestor puede usarlas.
 *
 * Lo que hace seguro el conjunto, ademas, es COMO se aplica: por el objeto `style` de
 * React, o sea por CSSOM, donde el navegador asigna una propiedad y no parsea una cadena de
 * declaraciones. Estas dos reglas son la segunda linea, para el dia en que alguien escriba
 * esto dentro de un `<style>` concatenando strings.
 */
function comillasEquilibradas(valor: string): boolean {
  let abierta: "'" | '"' | null = null;
  for (const caracter of valor) {
    if (caracter === "'" || caracter === '"') {
      // Una comilla del otro tipo dentro de una cita es texto, no sintaxis: en
      // `'Helvetica's'` el nombre es valido. Se acepta y se cuenta como contenido.
      if (abierta === null) abierta = caracter;
      else if (abierta === caracter) abierta = null;
      continue;
    }
    // Cualquier cosa que no sea letra, digito, separador o el guion de un identificador
    // dentro de la cita, se deja para la regex de la regla 1.
  }
  return abierta === null;
}

const fontFamily = z
  .string()
  .min(1)
  .max(80)
  .regex(
    /^[A-Za-z0-9 ,'"_-]+$/,
    "Pila de fuentes CSS: solo letras, digitos, espacios, comas, guiones y comillas",
  )
  .refine(comillasEquilibradas, "Las comillas de un nombre de fuente tienen que cerrarse");

/** Espejo de `tenant_branding`. */
export const brandingSchema = z.object({
  primary_color: hexColor,
  secondary_color: hexColor,
  logo_path: storagePath.nullable(),
  favicon_path: storagePath.nullable(),
  hero_image_path: storagePath.nullable(),
  font_family: fontFamily,
  /** Nombre que ve el socio como remitente. El club no configura SMTP (OQ-10). */
  email_from_name: z.string().min(1).max(60),
  email_reply_to: z.string().email(),
});
export type BrandingConfig = z.infer<typeof brandingSchema>;

/**
 * Los 7 `feature_key` de la spec. Es un enum de texto, no un booleano suelto,
 * para anadir una feature no requiera migracion.
 *
 * Cada feature del MVP **debe** tener su fila en `tenant_features`. Sin
 * excepcion (regla 3). Si anades una aqui, anade su fila en la seed T1 y su
 * flag en `tenant_features`.
 */
export const featureKeySchema = z.enum([
  "calendar",
  "booking",
  "payments",
  "open_matches",
  "news",
  "gdpr_export",
  "push_notifications",
]);
export type FeatureKeyConfig = z.infer<typeof featureKeySchema>;

/** Las 7 keys del MVP, en el mismo orden que la seed. */
export const MVP_FEATURE_KEYS = [
  "calendar",
  "booking",
  "payments",
  "open_matches",
  "news",
  "gdpr_export",
  "push_notifications",
] as const satisfies readonly FeatureKeyConfig[];

/**
 * Tramo de reembolso. Espejo del JSON de
 * `tenant_content['cancellation_policy']`.
 *
 * `label` no es decorativo: es el texto que ve el socio en
 * `/reserva/confirmar` y en la pantalla de cancelar, y lo escribe el gestor
 * del club. Sin el, habria que hardcodear el copy en la app, y la regla 1 lo
 * prohibe.
 */
export const refundTierSchema = z.object({
  hours_before: z.number().int().min(0).max(720),
  refund_percent: z.number().int().min(0).max(100),
  label: z.string().min(1).max(200),
});
export type RefundTierConfig = z.infer<typeof refundTierSchema>;

/**
 * Politica de cancelacion. El orden y la coherencia los verifica el
 * superRefine: el tipo no puede.
 */
export const cancellationPolicySchema = z
  .object({
    tiers: z.array(refundTierSchema).min(1),
    policy_text: z.string().min(1).max(2000),
    notice_text: z.string().min(1).max(2000),
  })
  .superRefine((policy, ctx) => {
    // Ordenamos de mas a menos antelacion: 24h, 12h, 0h. En ese orden el
    // porcentaje debe ser **no creciente**: menos aviso, menos devolucion.
    // Decrecer es lo normal (24h->100%, 12h->50%, 0h->0%). Lo incoherente es lo
    // contrario: que con menos aviso se devuelva mas.
    const sorted = [...policy.tiers].sort((a, b) => b.hours_before - a.hours_before);

    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const current = sorted[i];
      if (prev === undefined || current === undefined) {
        continue;
      }
      if (prev.hours_before === current.hours_before) {
        ctx.addIssue({
          code: "custom",
          message: `Dos tramos con el mismo hours_before (${current.hours_before}). El calculo seria ambiguo`,
          path: ["tiers", i],
        });
      }
      if (current.refund_percent > prev.refund_percent) {
        ctx.addIssue({
          code: "custom",
          message: `El tramo de ${current.hours_before}h devuelve MAS (${current.refund_percent}%) que el de ${prev.hours_before}h (${prev.refund_percent}%). Con menos aviso no se devuelve mas: incoherente`,
          path: ["tiers", i],
        });
      }
    }
  });
export type CancellationPolicyConfig = z.infer<typeof cancellationPolicySchema>;

/** Espejo de `tenant_content['cancellation_policy']`. */
export const contentKeySchema = z.enum([
  "cancellation_policy",
  "terms_notice",
  "about_club",
]);
export type ContentKeyConfig = z.infer<typeof contentKeySchema>;

/** Contrato completo de un tenant: lo que la app necesita para renderizar. */
export const tenantConfigSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Slug en minusculas, digitos y guiones"),
  currency: z.string().length(3).default("eur"),
  timezone: z.string().min(1).max(64).default("Europe/Madrid"),
  locale: z.string().min(2).max(16).default("es-ES"),
  /** 14 a 21, default 18. Lo usa el calculo de menores en servidor (OQ-8). */
  min_player_age: z.number().int().min(14).max(21).default(18),
  branding: brandingSchema,
  features: z.array(featureKeySchema),
  content: z.record(contentKeySchema, z.unknown()),
});
export type TenantConfig = z.infer<typeof tenantConfigSchema>;
