import type { Metadata, Viewport } from "next";

import { readableForeground } from "@frasapp/core";
import { brandStyle, NEUTRAL_BRAND } from "@frasapp/ui";

import { brandingDeLaPeticion } from "../lib/server/branding";

import "./globals.css";

/**
 * Estas pantallas se pintan en cada peticion, nunca en el build.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE `force-dynamic` Y NO NADA
 *
 * Porque el layout lee el club y su marca de la base, y Next no tiene forma de saberlo:
 * `resolveBranding()` no usa ninguna API dinamica de Next (ni cookies, ni headers, ni
 * searchParams), solo una consulta. Sin esto, Next ve un componente de servidor sin
 * entradas dinamicas y lo prerenderiza, o sea que el HTML de la marca del club se escribe
 * DENTRO del `.next` en cuanto alguien lanza `next build`.
 *
 * Y de ahi salen los dos fallos, en orden de gravedad:
 *
 *   1. `next build` necesita la base de datos. En el despliegue de un club la build se
 *      ejecuta antes de que exista su configuracion, asi que la build falla por una
 *      variable de entorno que no es un error de codigo. En desarrollo local, que es donde
 *      no hay `.env.local`, la build falla siempre.
 *
 *   2. El fallo que de verdad da miedo: si la build SI tiene base (porque el pipeline
 *      comparte la del club de desarrollo), el resultado se guarda y se sirve a todas las
 *      instancias que se desplieguen despues. El club A veria el nombre y los colores del
 *      club B, y no habria ni un error, ni un aviso, ni un 500: solo la marca equivocada.
 *
 * Con tres lineas, ninguna de las dos depende de que alguien se acuerde.
 */
export const dynamic = "force-dynamic";

/**
 * Un `error.tsx` de Next? No hay ninguno a proposito.
 *
 * Si el club no existe o la marca esta corrupta, este layout lanza, y Next busca la
 * pantalla de error mas cercana. Sin `error.tsx` la que encuentra es la de Next, que sale
 * en desarrollo y en produccion no explica nada. Un `error.tsx` aqui, escrito para el
 * gestor del club y no para un programador, es trabajo de T12, cuando sepamos que fallo le
 * toca ver. Inventarlo ahora seria escribir una pantalla para un error que no se ha visto.
 */

/**
 * El club y su marca salen de UNA consulta por peticion.
 *
 * `generateMetadata`, el layout y las pantallas los necesitan, se ejecutan en el mismo
 * render, y sin el `cache` de React de `branding.ts` cada uno haria su propio viaje. Ese
 * `cache` memoiza DENTRO de la peticion y se tira al terminarla, que no es lo mismo que el
 * `cached` de `tenant.ts` (que vive en el proceso), asi que aqui no vuelve el bug de "el
 * gestor cambia el color y lo sigue viendo viejo".
 */

/**
 * La marca del club en el `<head>`: lo que sale en la pestana del movil y lo que se
 * comparte en WhatsApp.
 *
 * `generateMetadata` y no `metadata` porque el titulo es el NOMBRE DEL CLUB, y el nombre
 * vive en la base. Con `metadata` estatico, el titulo seria una constante, y la constante
 * seria o el nombre del club de la seed (que es marca hardcodeada, regla 1) o algo tan
 * generico como "Padel" que no dice de quien es la web.
 *
 * `title` con el nombre delante y el deporte detras, porque es lo que ya se ve en el movil
 * cuando hay seis pestanas del club abiertas. El `template` es para las pantallas que
 * pongan su propio titulo; hoy ninguna lo hace, asi que no se ve, y cuando las haya no
 * habra que repetir el nombre del club en cada una.
 *
 * SIN `description`, y no por olvido: una descripcion por club es copy del gestor, y copy
 * del gestor va en `tenant_content` (regla 1, que es lo mismo que dice de los colores).
 * Cuando exista la clave de contenido, aqui se lee; hasta entonces, mejor sin ella que
 * con una frase inventada que todos los clubes verian igual.
 */
export async function generateMetadata(): Promise<Metadata> {
  const { tenant } = await brandingDeLaPeticion();

  return {
    title: {
      default: `${tenant.name} · Padel`,
      template: `%s · ${tenant.name}`,
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/**
 * El `<html>` lleva la marca del tenant, SIEMPRE.
 *
 * Y no un `style` en el `<body>` o en un `div` contenedor, que es lo que haria falta si
 * la marca la pintara un componente. Va en la raiz por una razon tecnica concreta: las
 * variables `--brand-*` se resuelven por herencia, asi que ponerlas en la raiz las hace
 * disponibles para TODO el documento, y ponerlas en un `div` solo las haria disponibles
 * para lo que cuelgue de ahi. Entre las dos opciones esta la de que el fondo del `body`,
 * que esta en `globals.css` y por tanto fuera de cualquier `div`, no llegue a ver la marca.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE SIEMPRE, Y NO SOLO CUANDO HAY MARCA
 *
 * Porque cuando NO hay fila en `tenant_branding` (un club recien dado de alta) lo que se
 * escribe es `NEUTRAL_BRAND`, el mismo respaldo que esta en el `:root` de `styles.css`. Y
 * son los mismos valores, no parecidos: hay un test en `ui` que falla si dejan de decirlo
 * igual.
 *
 * Lo contrario, un `style={{ ... }}` sin nada cuando no hay marca, tiene dos formas de
 * romperse y las dos se ven en pantalla. Si se pone un objeto con cadenas vacias, el
 * navegador recibe `--brand-primary: ` que es un valor VALIDO y no un valor ausente: el
 * fondo se queda transparente en vez de gris. Y si se omite el `style` entero, esta
 * pantalla depende de que el CSS de `ui` este cargado, o sea de que el orden de los
 * `@import` en `globals.css` siga siendo el que es.
 *
 * Escribiendo siempre el objeto, el valor de la marca depende de una sola cosa (la base) y
 * el CSS es la red, no el camino.
 */
export default async function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const { tenant, branding } = await brandingDeLaPeticion();

  const estilo = brandStyle(
    branding === null
      ? NEUTRAL_BRAND
      : {
          primary: branding.primary_color,
          secondary: branding.secondary_color,
          fontFamily: branding.font_family,
          onPrimary: readableForeground(branding.primary_color),
        },
  );

  return (
    <html lang={tenant.locale} style={estilo}>
      <body className="min-h-dvh bg-neutral-50 text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
