import { CourtList } from "@frasapp/ui";

import { brandingDeLaPeticion } from "../../lib/server/branding";
import { listCourts } from "../../lib/server/courts";

/**
 * Pantalla 2 del MVP: el catalogo de pistas del club. Spec 5.1.
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE HACE, EN UN PARRAFO
 *
 * Lista las pistas activas del club, con el nombre, de que tipo es, de que esta hecha y si
 * esta cubierta. Y nada mas: sin precios, sin horarios y sin boton de reservar.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE NO HAY NADA DE RESERVA AQUI
 *
 * Porque la reserva es T7, y este boton habria que quitarlo entero cuando llegue. Un
 * "Reservar" que no hace nada, o que manda a una pantalla que no existe, es peor que no
 * ponerlo: el socio toca, no pasa nada, y no vuelve a tocar. Prefiero que `/pistas` sea una
 * lista honesta de las pistas que hay.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE `listCourts()` Y NO UN `fetch` A `/api/courts`
 *
 * La respuesta es la misma que devuelve la ruta, y sale de la misma funcion, asi que la
 * duplicacion seria de las que divergen solas: un dia se anade una columna al catalogo, se
 * anade en la consulta de la ruta, y esta pantalla se queda con la version vieja con un
 * `undefined` en una tarjeta y sin ningun error.
 *
 * Y el salto HTTP tampoco traeria nada: `next start` tiene que estar escuchando para que la
 * pagina se pueda pintar, y en un despliegue eso es un round trip al mismo proceso. La
 * ruta sigue existiendo para lo que la consume de verdad (T7, y el club que quiera
 * integrarla), y la pagina lee de la funcion.
 * ---------------------------------------------------------------------------------------
 */
export default async function PistasPage() {
  const [{ tenant }, pistas] = await Promise.all([
    brandingDeLaPeticion(),
    listCourts(),
  ]);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold text-neutral-900">Pistas de {tenant.name}</h1>
      <CourtList courts={pistas} />
    </main>
  );
}
