import Link from "next/link";

import { Card } from "@frasapp/ui";

import { brandingDeLaPeticion } from "../lib/server/branding";
import { readAboutClub } from "../lib/server/content";

/**
 * Pantalla 1 del MVP: la portada del club. Spec 5.1.
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE HACE, EN UN PARRAFO
 *
 * Enseña de quien es la web (el nombre del club), lo que el club ha escrito sobre si mismo,
 * y un enlace a las pistas. Nada mas, y esa limitacion es el requisito: la portada de un
 * club no es un panel de control, y cuanto mas stuff tenga mas cosas hay que mantener sin
 * que nadie lo pidiera.
 *
 * Sin precios, sin horarios, sin login. La reserva es T7, y una portada que promete una
 * reserva que no existe es peor que una portada que no la promete.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE NO USA `listCourts()`
 *
 * Porque la portada no lista pistas, y la unica version de esta pagina que muestra pistas
 * seria la que se parece a `/pistas` con un titulo distinto. La funcion de servidor queda
 * para la pantalla que la necesita. Anadirla aqui "porque si" seria traer el catalogo
 * entero (con su consulta y su RLS) a una pagina que no lo pinta, y el dia que las pistas
 * tengan un dato mas habria que tocar las dos pantallas para no divergir.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE `readAboutClub()` Y NO EL CONTENIDO EN EL FICHERO
 *
 * Porque el texto lo escribe el gestor desde su panel, y un texto de club escrito en el
 * codigo es marca hardcodeada por la puerta de atras: el test de literales de T6a pasaria
 * si el nombre del club no aparece, y aun asi cada instancia desplegada estaria mostrando
 * el texto del club de la seed. El color tiene un guard porque un color es un `#`; un
 * parrafo de texto no tiene ninguna forma obvia de fallar asi, y por eso aqui lo que protege
 * es de donde sale el dato, no como se escribe.
 */
export default async function HomePage() {
  const { tenant } = await brandingDeLaPeticion();
  const about = await readAboutClub();

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold text-neutral-900">{tenant.name}</h1>

      {about === null ? null : (
        <Card title="Sobre el club">
          <p className="text-sm text-neutral-600">{about}</p>
        </Card>
      )}

      {/*
        El color sale de una VARIABLE, nunca del valor: el boton no sabe que color ha
        elegido el club, solo que usa el primario. Y el texto usa `--brand-on-primary`, que
        el layout calcula con `readableForeground` a partir del color real. Con `text-white`
        fijo, un club con primario claro tendria un boton blanco sobre blanco.

        No hay icono dentro porque no hay libreria de iconos en las dependencias, y meterla
        por una flecha es mas de lo que pide un boton que ya dice "Ver las pistas".
      */}
      <Link
        href="/pistas"
        className="rounded-lg px-4 py-3 text-center text-sm font-semibold"
        style={{
          backgroundColor: "var(--brand-primary)",
          color: "var(--brand-on-primary)",
        }}
      >
        Ver las pistas
      </Link>
    </main>
  );
}
