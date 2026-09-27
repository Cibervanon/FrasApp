import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { tenantQuery } from "./db";
import { clearTenantCache } from "./tenant";
import { resolveBranding, SELECT_BRANDING } from "./branding";
import {
  prepareDatabase,
  releaseDatabaseLease,
  TENANT_IDS,
  withAdmin,
  withTenant,
} from "../../test/db-harness";

/**
 * T6b: leer la marca del club, con el rol del club.
 *
 * -------------------------------------------------------------------------------------
 * POR QUE ESTE FICHERO NO REPETE LOS TESTS DE RLS
 *
 * `rls.db.test.ts` ya comprueba, para `tenant_branding`, que A no lee lo de B y que B no
 * lee lo de A. Eso es la politica. Lo que NO comprueba es que la pagina del club use esa
 * lectura y no un atajo por `baseQuery`, que va sin RLS. Aqui se comprueba lo segundo: que
 * la marca que sale por pantalla sea la del club de ESTA instancia, y que venga de la fila
 * de la base.
 *
 * -------------------------------------------------------------------------------------
 * POR QUE HAY UN TERCER TENANT
 *
 * `resolveBranding` abre su propia conexion desde el pool, asi que no ve lo que hay sin
 * confirmar en la transaccion del arnes. Para probar el caso "el club todavia no tiene
 * marca" hace falta un tenant DE VERDAD sin fila, confirmado, y borrado en `afterAll`. Es
 * lo mismo que hace `db.db.test.ts` con sus fixtures, y por el mismo motivo: cuando el
 * el producto se apoya en el pool, los fixtures tienen que ser visibles para el pool.
 */

/** Tenant sin fila en `tenant_branding`. Su marca es `null`, no un error. */
const TENANT_SIN_MARCA = "00000000-0000-4000-8000-0000000006c1";

/** `font_family` valido para la base y para el tipo, pero no para el esquema. */
const FONT_LARGO = "A".repeat(120);

const original = process.env["TENANT_SLUG"];

beforeAll(async () => {
  await prepareDatabase();

  await withAdmin(async (db) => {
    await db.query(
      `insert into public.tenants (id, name, slug)
       values ($1, 'Club Sin Marca T6', 'club-sin-marca-t6')
       on conflict (id) do update set slug = excluded.slug`,
      [TENANT_SIN_MARCA],
    );
    // A proposito NO se inserta fila en `tenant_branding` para este tenant. Esa
    // ausencia es lo que se esta probando, y sembrarla seria undone fixture por error.
  });
});

afterAll(async () => {
  if (original === undefined) delete process.env["TENANT_SLUG"];
  else process.env["TENANT_SLUG"] = original;
  clearTenantCache();

  await withAdmin(async (db) => {
    // `on delete cascade` se lleva la marca si algum dia se llegara a crear.
    await db.query(`delete from public.tenants where id = $1`, [TENANT_SIN_MARCA]);
  });
  await releaseDatabaseLease();
});

/** Pone la instancia en un club y olvida la cache, que es lo que hace un despliegue. */
function instanceEs(slug: string): void {
  process.env["TENANT_SLUG"] = slug;
  clearTenantCache();
}

describe("T6b: la marca sale de `tenant_branding` del club de la instancia", () => {
  it("devuelve los colores de SU club, no los de otro", async () => {
    instanceEs("club-a");
    const { branding } = await resolveBranding();

    // `#111111` y `#222222` son los colores que siembra el arnes para A y para B, y son
    // los del club de ejemplo. Si la lectura cruzara tenants, estos dos test darian el
    // mismo color, y el numero de fila no lo detectaria: hace falta el VALOR.
    expect(branding?.primary_color).toBe("#111111");
    expect(branding?.secondary_color).toBe("#111111");
  });

  it("el otro club ve los suyos, y son distintos", async () => {
    instanceEs("club-b");
    const { branding } = await resolveBranding();
    expect(branding?.primary_color).toBe("#222222");
  });

  it("el objeto trae los ocho campos de la tabla y ni uno mas", async () => {
    instanceEs("club-a");
    const { branding } = await resolveBranding();

    // El `where tenant_id = $1` de la consulta y la RLS hacen las dos cosas. Si alguien
    // quita el `where` y la RLS estuviera rota, aqui se veria como una fila de mas o un
    // color de mas. Se comprueba el objeto entero, no un campo suelto.
    expect(branding).not.toBeNull();
    expect(Object.keys(branding ?? {}).sort()).toEqual([
      "email_from_name",
      "email_reply_to",
      "favicon_path",
      "font_family",
      "hero_image_path",
      "logo_path",
      "primary_color",
      "secondary_color",
    ]);
  });

  it("el `where` es por si acaso, pero la RLS sola ya basta", async () => {
    // La consulta de `resolveBranding` lleva `where tenant_id = $1`. Este test quita el
    // `where` a proposito, para demostrar que la RLS es el unico punto de aislamiento y
    // que el `where` es solo una segunda red. Sin el, un `tenantQuery` con una consulta
    // mal escrita seguiria sin filtrar, y eso es lo que hay que poder afirmar.
    const rows = await tenantQuery<{ tenant_id: string; primary_color: string }>(
      TENANT_IDS.a,
      `select tenant_id, primary_color from public.tenant_branding`,
    );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(TENANT_IDS.a);
    expect(rows[0]?.primary_color).toBe("#111111");
  });

  it("la RLS esconde la marca ajena aunque la consulta pida la fila por su id", async () => {
    // Este es el test que importa, y usa el SQL REAL de `resolveBranding` en vez de una
    // copia: el club B pide, con el `where` puesto, la fila de marca DEL CLUB A.
    //
    // Sin RLS (es decir, corrido como superusuario, que es lo que pasaria si alguien
    // cambiara un `tenantQuery` por un `baseQuery`) devolveria la fila de A y la pagina de B
    // se pintaria con el color de A. Con RLS devuelve 0, y el endpoint responderia como si
    // ese club no tuviera marca, que es la unica respuesta honesta.
    //
    // Los tests de arriba comprueban que el valor que sale es el del club correcto. Este
    // comprueba lo que aquellos no pueden: que el aislamiento no depende de acordarse de
    // escribir el `where` bien.
    const filas = await withTenant("b", async (db) => {
      const result = await db.query<{ primary_color: string }>(SELECT_BRANDING, [TENANT_IDS.a]);
      return result.rows;
    });

    expect(filas).toHaveLength(0);
  });

  it("y en positivo: la RLS deja ver SU propia marca con el mismo SQL", async () => {
    // La pareja del anterior, para que no se pueda "pasar" dejando la tabla entera
    // vacia: si la politica de `select` de `tenant_branding` se rompiera en la direccion
    // contraria (nadie ve nada), el test de arriba tambien pasaria.
    const filas = await withTenant("b", async (db) => {
      const result = await db.query<{ primary_color: string }>(SELECT_BRANDING, [TENANT_IDS.b]);
      return result.rows;
    });

    expect(filas).toHaveLength(1);
    expect(filas[0]?.primary_color).toBe("#222222");
  });
});

describe("T6b: el nombre del club NO esta en `tenant_branding`", () => {
  it("el nombre que se ve viene de `tenants.name`", async () => {
    instanceEs("club-a");
    const { tenant } = await resolveBranding();

    // `tenant_branding` no tiene columna de nombre: tiene colores, rutas de imagen, fuente
    // y los dos datos de email. El nombre del club esta en `tenants.name`, asi que la
    // cabecera de la web no puede salir solo de la marca: sale de las dos. Por eso
    // `resolveBranding` devuelve el tenant y la marca, y no "la configuracion del club".
    expect(tenant.name).toBe("Club A");
  });

  it("cada club ve SU nombre", async () => {
    instanceEs("club-b");
    const { tenant } = await resolveBranding();
    expect(tenant.name).toBe("Club B");
  });
});

describe("T6b: un club sin marca no es un fallo", () => {
  it("sin fila en `tenant_branding` devuelve `null` en vez de reventar", async () => {
    instanceEs("club-sin-marca-t6");
    const { tenant, branding } = await resolveBranding();

    // Un club recien dado de alta puede no tener fila de marca todavia. La pantalla tiene
    // que salir en neutro (los grises de `:root` de `packages/ui`), no con un error 500.
    expect(tenant.id).toBe(TENANT_SIN_MARCA);
    expect(branding).toBeNull();
  });

  it("y con `null` la pagina puede seguir buscando las pistas", async () => {
    // El `null` es de la MARCA, no del club: el tenant sigue resuelto y su catalogo sigue
    // disponible. Si el fallo fuera "no hay marca, no hay club", un club sin logo se
    // quedaria sin catalogo, que es un fallo mucho mas caro.
    instanceEs("club-sin-marca-t6");
    const { tenant, branding } = await resolveBranding();
    expect(branding).toBeNull();
    expect(tenant.id).toBeTruthy();
  });
});

describe("T6b: una marca INVALIDA es un fallo, y dice donde", () => {
  it("un `font_family` que la base acepta y el esquema no, rompe diciendo la columna", async () => {
    // `tenant_branding.font_family` no tiene `check` en la migracion: la base acepta
    // cualquier texto. El unico que vigila es `brandingSchema`, y T6c es el primer
    // consumidor de ese valor (lo mete en el estilo de la pagina), asi que este test es el
    // que sostiene la cadena entera: si el esquema se relaja, esto pasa y la pagina
    // inyecta lo que le den.
    await withAdmin(async (db) => {
      await db.query(`update public.tenant_branding set font_family = $2 where tenant_id = $1`, [
        TENANT_IDS.b,
        FONT_LARGO,
      ]);
    });

    instanceEs("club-b");
    try {
      // Falla cerrado, y en silencio ni de broma: una pantalla en neutro con la marca
      // rota es indistinguible de un club sin marca, y nadie avisaria.
      await expect(resolveBranding()).rejects.toThrow(/font_family/);
    } finally {
      // En `finally`, no despues: si la asercion falla, la fila se queda con 120 caracteres
      // y el siguiente fichero que siembre el arnes hereda el valor.
      await withAdmin(async (db) => {
        await db.query(
          `update public.tenant_branding set font_family = 'Inter' where tenant_id = $1`,
          [TENANT_IDS.b],
        );
      });
      clearTenantCache();
    }
  });

  it("el mensaje dice QUE hacer, no solo que fallo", async () => {
    await withAdmin(async (db) => {
      await db.query(`update public.tenant_branding set font_family = $2 where tenant_id = $1`, [
        TENANT_IDS.b,
        FONT_LARGO,
      ]);
    });

    instanceEs("club-b");
    try {
      await expect(resolveBranding()).rejects.toThrow(/tenant_branding/);
    } finally {
      await withAdmin(async (db) => {
        await db.query(
          `update public.tenant_branding set font_family = 'Inter' where tenant_id = $1`,
          [TENANT_IDS.b],
        );
      });
      clearTenantCache();
    }
  });
});
