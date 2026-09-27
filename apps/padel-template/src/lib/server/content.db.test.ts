import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { readAboutClub } from "./content";
import { clearTenantCache } from "./tenant";
import {
  prepareDatabase,
  releaseDatabaseLease,
  TENANT_IDS,
  withAdmin,
} from "../../test/db-harness";

/**
 * T6c: el texto que el gestor ha escrito sobre su club.
 *
 * -------------------------------------------------------------------------------------
 * POR QUE ESTE FICHERO EXISTE SIENDO UNA FUNCION DE CUATRO LINEAS
 *
 * Porque tiene TRES salidas y las tres se ven en pantalla, y dos de ellas se parecen
 * demasiado como para distinguirlas a ojo:
 *
 *   - hay fila y es texto: se pinta el parrafo.
 *   - no hay fila: no se pinta nada. Es un club que todavia no ha escrito nada, NORMAL.
 *   - hay fila y NO es texto: tampoco se pinta nada. Y aqui esta el que se confunde con el
 *     anterior, porque "no sale el parrafo" es el mismo sintoma en los dos casos.
 *
 * Sin este test, la rama de "valor que no es texto" seeria codigo que nadie ha ejecutado
 * nunca, y el dia que aparezca un `about_club` que sea un objeto, la pantalla no dira nada
 * raro: simplemente no dira nada, que es justo el fallo que no se nota.
 *
 * -------------------------------------------------------------------------------------
 * POR QUE ESTA EN `tenant_content` Y NO EN UNA TABLA DE "TEXTOS"
 *
 * Porque la spec pone el copy del club en `tenant_content`, que ya tiene RLS y clave
 * compuesta. Una tabla `textos` con `id` y `contenido` seria lo mismo con una tabla mas que
 * migrar, y un sitio mas donde meter una politica que alguien pueda olvidar.
 */

const original = process.env["TENANT_SLUG"];

/** Tenant sin fila en `tenant_content`. Su "sobre el club" es `null`. */
const TENANT_SIN_CONTENIDO = "00000000-0000-4000-8000-0000000006c2";

/** Tenant cuyo `about_club` se fuerza a un `jsonb` que no es un texto. */
const TENANT_CONTENIDO_RARO = "00000000-0000-4000-8000-0000000006c3";

beforeAll(async () => {
  await prepareDatabase();

  await withAdmin(async (db) => {
    await db.query(
      `insert into public.tenants (id, name, slug)
       values
         ($1, 'Club Sin Contenido T6', 'club-sin-contenido-t6'),
         ($2, 'Club Contenido Raro T6', 'club-contenido-raro-t6')
       on conflict (id) do update set slug = excluded.slug`,
      [TENANT_SIN_CONTENIDO, TENANT_CONTENIDO_RARO],
    );

    // Sin fila en `tenant_content` para el primero: esa ausencia es lo que se prueba.

    // Para el segundo, un objeto. `tenant_content_key_allowed` deja `about_club`, asi que
    // la clave pasa; lo que no es texto es el VALOR, que es lo que se esta probando.
    await db.query(
      `insert into public.tenant_content (tenant_id, content_key, value)
       values ($1, 'about_club', '{"parrafos": ["uno", "dos"]}'::jsonb)
       on conflict (tenant_id, content_key) do update set value = excluded.value`,
      [TENANT_CONTENIDO_RARO],
    );
  });
});

afterAll(async () => {
  if (original === undefined) delete process.env["TENANT_SLUG"];
  else process.env["TENANT_SLUG"] = original;
  clearTenantCache();

  await withAdmin(async (db) => {
    // `on delete cascade` se lleva el contenido si algum dia se llegara a crear.
    await db.query(`delete from public.tenants where id = any($1)`, [
      [TENANT_SIN_CONTENIDO, TENANT_CONTENIDO_RARO],
    ]);
  });
  await releaseDatabaseLease();
});

/** Pone la instancia en un club y olvida la cache, que es lo que hace un despliegue. */
function instanceEs(slug: string): void {
  process.env["TENANT_SLUG"] = slug;
  clearTenantCache();
}

describe("T6c: el texto del club", () => {
  it("devuelve lo que el gestor escribio, sin recortarlo ni tocarlo", async () => {
    // El arnes siembra `about_club = "club"` para `club-a` y `club-b`. El texto sale tal
    // cual, sin `trim` ni mayusculas ni nada: es copy del gestor y encima suyo no hay nada
    // que decidir.
    instanceEs("club-a");
    await expect(readAboutClub()).resolves.toBe("club");
  });

  it("un club que no ha escrito nada da null, que es un estado NORMAL", async () => {
    // Esto NO es un error. Un club recien dado de alta no tiene `about_club`, la pantalla
    // se pinta sin el parrafo, y todo correcto. La alternativa (tirar) seria no hacer nada.
    instanceEs("club-sin-contenido-t6");
    await expect(readAboutClub()).resolves.toBeNull();
  });

  it("una fila que no es texto da null, y no el string '[object Object]'", async () => {
    // `typeof` en vez de un cast. Sin esta comprobacion, un `about_club` guardado como
    // objeto por el gestor apareceria en la portada como "[object Object]", que es de los
    // fallos que se ven en produccion y no se pueden explicar.
    instanceEs("club-contenido-raro-t6");
    await expect(readAboutClub()).resolves.toBeNull();
  });

  it("cada club ve SU texto, no el del otro", async () => {
    // El aislamiento de `tenant_content` ya lo comprueba `rls.db.test.ts`. Lo que se
    // comprueba aqui es que ESTA consulta pase por la via con RLS y no por `baseQuery`:
    // si alguien la cambiara por `baseQuery`, los dos valores serian identicos porque las
    // dos filas dicen "club", y este test pasaria sin querer. Por eso se escribe un valor
    // distinto en `club-b` y se mira que A no lo vea.
    await withAdmin(async (db) => {
      await db.query(
        `update public.tenant_content set value = '"texto de B"'::jsonb
          where tenant_id = $1 and content_key = 'about_club'`,
        [TENANT_IDS.b],
      );
    });

    try {
      instanceEs("club-a");
      await expect(readAboutClub()).resolves.toBe("club");

      instanceEs("club-b");
      await expect(readAboutClub()).resolves.toBe("texto de B");
    } finally {
      await withAdmin(async (db) => {
        await db.query(
          `update public.tenant_content set value = '"club"'::jsonb
            where tenant_id = $1 and content_key = 'about_club'`,
          [TENANT_IDS.b],
        );
      });
    }
  });
});
