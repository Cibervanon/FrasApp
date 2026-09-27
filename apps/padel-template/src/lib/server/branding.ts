import { brandingSchema, type BrandingConfig } from "@frasapp/config-schema";
import { cache } from "react";

import { tenantQuery } from "./db";
import { resolveTenant, type ResolvedTenant } from "./tenant";

/**
 * La marca del club, leida con el rol del club.
 *
 * -------------------------------------------------------------------------------------
 * POR QUE ESTO NO ESTA EN `tenant.ts`
 *
 * `tenant.ts` resuelve el tenant por `slug` con `baseQuery`, porque para entrar con la
 * conexion del tenant hay que saber antes quien es el tenant: es un huevo y una gallina, y
 * esta es la unica consulta de la app que puede decirse que va sin RLS (con el `where slug`
 * contra un `unique`, que es lo unimo exigible antes de saber quien pregunta).
 *
 * La marca no tiene ese problema: ya sabemos el `id`. Asi que va por `tenantQuery`, con
 * RLS, como cualquier dato de negocio. Separar los dos ficheros deja claro que la
 * excepcion es la resolucion del tenant y no "la capa de servidor en general".
 *
 * -------------------------------------------------------------------------------------
 * POR QUE NO HAY CACHE, Y POR QUE `tenant.ts` SI LA TIENE
 *
 * El slug de un despliegue no cambia mientras el despliegue no cambie de club, asi que
 * cachearlo es gratis. La marca SI cambia en caliente: el gestor la edita desde `/admin`
 * (T12) y espera ver el color nuevo a la siguiente carga, no tras un reinicio.
 *
 * Cachearla aqui seria ese bug: el gestor cambia el color, recarga, y sigue viendo el
 * viejo, y no hay ningun sintoma visible mas que "no funciona". El coste de no cachear es
 * una busqueda por PRIMARY KEY de una fila por request, que es de las consultas mas
 * baratas que hay. Cuando `/admin` exista, el valor de esta decision se vera en si el
 * guardado del color parece instantaneo o con retraso, y este comentario es el que explica
 * por que.
 */

/** Lo que la pantalla necesita para pintarse, y de quien sale cada cosa. */
export interface ResolvedBranding {
  /** El club de la instancia. De `tenants`, que no tiene RLS, via `resolveTenant()`. */
  readonly tenant: ResolvedTenant;
  /**
   * La marca, o `null` si el club todavia no tiene fila en `tenant_branding`.
   *
   * `null` es un estado NORMAL y no un fallo: un club recien dado de alta no tiene logo ni
   * color, y la pantalla sale con los grises de `:root` de `packages/ui`. Lo que no es
   * normal es una fila que existe y es invalida, y eso revienta (ver `resolveBranding`).
   */
  readonly branding: BrandingConfig | null;
}

/**
 * Columnas de `tenant_branding`, una a una y SIN `select *`.
 *
 * El `select *` seria mas corto y traeria dos cosas que no queremos: `updated_at`, que no
 * pinta de nada, y cualquier columna que se anada en una migracion futura, que entraria en
 * el tipo `BrandingConfig` sin que nadie lo mire. La asercion de las ocho claves de
 * `branding.db.test.ts` falla en cuanto se anade una, que es justo cuando hay que
 * decidir si entra en el contrato.
 *
 * EXPORTADA, y no privada, para que el test de RLS pueda usar el texto EXACTO que usa la
 * app. Duplicar la lista de columnas en el test seria una copia que se queda vieja: el
 * test pasaria con una consulta que ya no es la de la pagina, que es justo el fallo que
 * tiene que cazar.
 *
 * El `where tenant_id = $1` es una segunda red, no la primera. La primera es la RLS, y el
 * test de RLS de este mismo fichero demuestra que sin ella esta consulta (con el `where`
 * puesto y el id equivocado) devolveria la fila de otro club.
 */
export const SELECT_BRANDING = `
  select primary_color,
         secondary_color,
         logo_path,
         favicon_path,
         hero_image_path,
         font_family,
         email_from_name,
         email_reply_to
    from public.tenant_branding
   where tenant_id = $1
`;

/**
 * Lee la marca del club de la instancia.
 *
 * `0 filas` y `1 fila invalida` son dos fallos distintos y se tratan distinto, y esa
 * distincion es el motivo de que esta funcion devuelva `BrandingConfig | null` en vez de
 * lanzar siempre:
 *
 *   - `0 filas`: el club no tiene marcaTodavia. Es un club nuevo, o una marca que se va a
 *     crear en `/admin`. Se devuelve `null` y la pantalla sale neutra. Si esto se tratara
 *     como un error, dar de alta un club seria una caida, y el alta de un club es
 *     precisamente el momento en que no hay marca.
 *
 *   - `mas de 1 fila`: imposible, `tenant_id` es la clave primaria. Se dice igualmente, con
 *     el mismo motivo que en `resolveTenant`: un `primary key` que alguien quita un dia no
 *     debe convertirse en un "me quedo con la primera" silencioso.
 *
 *   - `1 fila que no parsea`: la marca esta ROTA. Aqui se lanza, y el error nombra la
 *     columna. Renderizar en neutro seria peor que romper: una pantalla gris es
 *     indistinguible de "este club no tiene marca todavia", asi que el fallo se quedaria
 *     sin ver hasta que el cliente dijera "no se ve el color que pedi". Romper en la
 *     primera peticion es ruidoso y sale con un mensaje que dice que corregir.
 */
export async function resolveBranding(): Promise<ResolvedBranding> {
  const tenant = await resolveTenant();

  const filas = await tenantQuery<Record<string, unknown>>(
    tenant.id,
    SELECT_BRANDING,
    [tenant.id],
  );

  if (filas.length > 1) {
    throw new Error(
      `El tenant ${tenant.id} tiene ${filas.length} filas en public.tenant_branding. ` +
        `\`tenant_branding.tenant_id\` es la clave primaria, asi que o la migracion no esta ` +
        `aplicada o alguien la modifico.`,
    );
  }

  const fila = filas[0];
  if (fila === undefined) {
    return { tenant, branding: null };
  }

  const parseado = brandingSchema.safeParse(fila);
  if (!parseado.success) {
    // El mensaje nombra columna y motivo, porque el que va a tener que arreglar esto es el
    // gestor del club, o la persona que escribio el alta, y ninguno de los dos va a leer un
    // `invalid_type` de Zod sin saber que tabla es.
    const problemas = parseado.error.issues
      .map((issue) => `${issue.path.join(".") || "(raiz)"}: ${issue.message}`)
      .join("; ");

    throw new Error(
      `La marca del tenant ${tenant.id} (slug '${process.env["TENANT_SLUG"]}') no es ` +
        `valida contra \`brandingSchema\`, y no se pinta con valores a medias: ` +
        `${problemas}\n` +
        `La fila esta en public.tenant_branding. Corrige la columna que salga aqui. Si el ` +
        `valor es legitimo y el esquema es el que se equivoca, el arreglo es en ` +
        `\`packages/config-schema\` y no en la base: el esquema es el contrato.`,
    );
  }

  return { tenant, branding: parseado.data };
}

/**
 * La marca, una vez por peticion.
 *
 * `generateMetadata`, el layout y la pagina necesitan lo mismo en el mismo render, y sin
 * esto se harian tres consultas identicas a `tenant_branding` en cada visita. No es un
 * detalle: en un movil con la red mala, tres viajes a la base por pantalla se notan.
 *
 * Y el `cache` de React memoiza DENTRO de una peticion y se tira al acabarla, que es
 * justo lo que hace falta aqui. Ojo con la confusion: este NO es el `cached` de
 * `tenant.ts`, que vive en el proceso. Si esta fuera un `Map` en el modulo, habria que
 * elegir entre rapido y correcto, y habria que elegir rapido, que es el bug que
 * `resolveBranding` evita a proposito: el gestor cambia el color, recarga, y lo sigue
 * viendo viejo. Con el de React no hay nada que elegir.
 */
export const brandingDeLaPeticion = cache(resolveBranding);
