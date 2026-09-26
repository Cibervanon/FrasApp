import { z } from "zod";

/**
 * Contrato de configuracion de un tenant. Zod, porque este objeto cruza la
 * frontera entre la base de datos y la UI: si la BD trae algo mal, quiero que
 * falle aqui y no con un `undefined` en pantalla.
 *
 * Aqui viven los **valores por defecto**, no los de un club concreto. Los
 * valores por defecto de la spec (18 anos, 90 minutos, tramos 24/12h, 3 min
 * de hold) son constantes, no configuracion de tenant, y viven en `core`.
 */

const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "Color hex de 6 digitos, con # inicial");

/** Marca. Sin valores por tenant: se rellena desde tenant_branding. */
export const brandingSchema = z.object({
  primaryColor: hexColor,
  accentColor: hexColor,
  logoUrl: z.string().url().nullable(),
  /** Nombre que aparece como remitente en los emails. */
  senderName: z.string().min(1).max(60),
  replyToEmail: z.string().email(),
});
export type BrandingConfig = z.infer<typeof brandingSchema>;

export const featureKeySchema = z.enum([
  "open_matches",
  "news",
  "guest_bookings",
  "online_payments",
  "advanced_pricing",
]);
export type FeatureKeyConfig = z.infer<typeof featureKeySchema>;

/**
 * Tramo de reembolso. El orden y el no solape los verifica el superRefine del
 * contrato completo, no el tipo: el tipo no puede.
 */
export const refundTierSchema = z.object({
  minHoursBefore: z.number().int().min(0).max(720),
  percent: z.number().int().min(0).max(100),
});
export type RefundTierConfig = z.infer<typeof refundTierSchema>;

export const cancellationPolicySchema = z
  .object({
    tiers: z.array(refundTierSchema).min(1),
  })
  .superRefine((policy, ctx) => {
    // Ordenamos de mas a menos antelacion: 24h, 12h, 0h. En ese orden, el
    // porcentaje debe ser **no creciente**: menos aviso, menos devolucion.
    // Decrecer es lo normal y lo correcto (24h->100%, 12h->50%, 0h->0%).
    // Lo incoherente es lo contrario: que con menos aviso se devuelva mas.
    const sorted = [...policy.tiers].sort(
      (a, b) => b.minHoursBefore - a.minHoursBefore,
    );

    for (let i = 1; i < sorted.length; i += 1) {
      const prev = sorted[i - 1];
      const current = sorted[i];
      if (prev === undefined || current === undefined) {
        continue;
      }
      if (prev.minHoursBefore === current.minHoursBefore) {
        ctx.addIssue({
          code: "custom",
          message: `Dos tramos con el mismo minHoursBefore (${current.minHoursBefore}). El calculo seria ambiguo`,
          path: ["tiers", i],
        });
      }
      if (current.percent > prev.percent) {
        ctx.addIssue({
          code: "custom",
          message: `El tramo de ${current.minHoursBefore}h devuelve MAS (${current.percent}%) que el de ${prev.minHoursBefore}h (${prev.percent}%). Con menos aviso no se devuelve mas: incoherente`,
          path: ["tiers", i],
        });
      }
    }
  });
export type CancellationPolicyConfig = z.infer<typeof cancellationPolicySchema>;

/** Contrato completo de un tenant. */
export const tenantConfigSchema = z.object({
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Slug en minusculas, digitos y guiones"),
  name: z.string().min(1).max(80),
  minPlayerAge: z.number().int().min(14).max(21).default(18),
  branding: brandingSchema,
  features: z.array(featureKeySchema),
  cancellationPolicy: cancellationPolicySchema,
});
export type TenantConfig = z.infer<typeof tenantConfigSchema>;
