import { tenantQuery } from "./db";
import { resolveTenantId } from "./tenant";

/**
 * El copy que escribe el gestor. Una fila de `tenant_content` por clave.
 *
 * ---------------------------------------------------------------------------------------
 * POR QUE NO HAY UN `getContent(clave)` Y YA
 *
 * Porque con eso, `value` llega a la pantalla como `unknown` y cada pantalla se inventa su
 * forma de leerlo. `about_club` es un texto, `cancellation_policy` es un objeto con tres
 * tramos y un porcentaje, y un dia habra una clave con una foto. Un solo `getContent` que
 * devuelve `unknown` hace que cada consumidor valide por su cuenta, y el que se olvide ve
 * `undefined` en pantalla.
 *
 * Asi que cada clave que se consume tiene su funcion, con su tipo, y comparte esta misma
 * consulta. Cuando aparezca una clave nueva, se escribe una funcion mas y el compilador
 * obliga a quien la use a manejar el caso de que no exista.
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE NO HACE: NO ES UN CACHE
 *
 * Lee cada vez. Igual que la marca, y por el mismo motivo: el texto lo edita el gestor y
 * tiene que verse en la siguiente peticion.
 */

/**
 * El texto de "sobre el club" de la pantalla de inicio.
 *
 * Devuelve `null` si la clave no existe, y `null` tambien si existe pero no es texto. La
 * diferencia no se distingue desde fuera a proposito: en los dos casos la pantalla se pinta
 * sin el parrafo, que es lo que se puede hacer sin inventar. Un `tenant_content` corrupto
 * en la fila de `about_club` es cosa de T12, que es donde el gestor puede ver y corregir
 * lo que ha escrito.
 *
 * Ojo con el `typeof`: la columna es `jsonb`, asi que un texto llega como el VALOR del
 * jsonb, no como un objeto. `'"hola"'::jsonb` es la cadena `hola`, y por eso el chequeo es
 * `typeof === "string"` y no "tiene la clave `value`".
 */
export async function readAboutClub(): Promise<string | null> {
  const tenantId = await resolveTenantId();
  const filas = await tenantQuery<{ readonly value: unknown }>(
    tenantId,
    `select value from public.tenant_content where content_key = 'about_club' limit 1`,
  );

  const fila = filas[0];
  if (fila === undefined) return null;
  return typeof fila.value === "string" ? fila.value : null;
}
