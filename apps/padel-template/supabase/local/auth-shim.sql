-- Shim de `auth` para desarrollo local con PostgreSQL nativo (Windows).
--
-- POR QUE EXISTE
-- En produccion, Supabase ya monta el esquema `auth` y estas tres funciones
-- (las crea GoTrue, no son nuestras). En local no tenemos Supabase, asi que hay
-- que recrearlas o las 12 politicas RLS de la migracion 001 no compilan.
--
-- ESTO NO ES UN MOCK Y NO DEBE COMPORTARSE COMO UNO
-- Un shim de test que devolviera un tenant fijo haria que el RLS pasara
-- siempre: la politica se estaria probando contra un `tenant_id` que el shim
-- decide, no contra el JWT. Eso es exactamente el falso verde que hay que
-- evitar en seguridad. Este shim NO decide nada: se limita a leer el mismo
-- setting que lee Supabase.
--
-- LA REGLA QUE NO SE PUEDE ROMPER
-- El shim tiene que ser identico o MAS ESTRICTO que Supabase, nunca mas
-- permisivo. Si aqui `auth.jwt()` devolviera algo mas ancho que en produccion,
-- el test de RLS pasaria aqui y en produccion dejaria ver datos de otro club.
-- Por eso se leen los mismos settings que Supabase y se aplica `nullif` en
-- todas partes: si el claim no existe, se devuelve NULL, y una politica con
-- `tenant_id = NULL` no devuelve filas. Fail-closed.
--
-- COMO SE USA EN LOS TESTS
-- El test de RLS no mete el JWT en una tabla: hace
--   set_config('request.jwt.claims', $1, true)
-- que es literalmente lo que hace el gateway de Supabase al pasar la peticion.
-- Asi que el camino que se prueba aqui es el mismo que en produccion.
--
-- EN PRODUCCION ESTE FICHERO NO SE APLICA
-- Lo ejecuta `pnpm db:reset` antes de las migraciones, solo en local. Las
-- migraciones de `supabase/migrations/` NO lo incluyen, a proposito: en
-- produccion esas funciones ya existen y crearlas aqui daria "already exists".

create schema if not exists auth;

-- Los ROLES que espera el resto del SQL
-- Las politicas de la migracion 001 son "TO authenticated" y el test hace
-- "set local role authenticated", asi que sin esto la migracion ni siquiera
-- aplica: "no existe el rol authenticated". Supabase los crea al montar el
-- proyecto; un PostgreSQL normal no, hay que recrearlos.
--
-- NOLOGIN porque no son usuarios: son identidades de aplicacion. El que entra es
-- `postgres` (o el `authenticator` de Supabase) y luego cambia de rol con SET
-- ROLE, que es lo que hace el gateway al recibir una peticion con el JWT.
--
-- POR QUE ESTO ES UN `do $$` Y NO UN `create role` A SECO
-- Los roles son de CLUSTER, no de base de datos. `drop database` que hace
-- `pnpm db:reset` borra la base entera pero deja los roles vivos, asi que a la
-- segunda ejecucion un `create role anon` revienta con "el rol ya existe" y el
-- reset se queda a medias. Hay que consultar `pg_roles` y crear o ajustar segun
-- lo que haya.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;

  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  else
    -- Por si alguien lo creo sin bypassrls en un intento anterior.
    alter role service_role bypassrls;
  end if;
end
$$;

grant usage on schema public to anon, authenticated, service_role;

-- Y sobre el esquema `auth`, que es donde viven `jwt()`, `uid()` y `role()`.
-- Sin esto las politicas dan "permiso denegado al esquema auth" al evaluarse, y
-- lo peligroso es que un INSERT asi se rechaza por un error de permisos en vez
-- de por la politica: el test veria "rechazado" y pasaria sin haber probado RLS.
grant usage on schema auth to anon, authenticated, service_role;

-- Permisos por defecto, igual que en Supabase. Al declararlos aqui, cada tabla
-- que cree la migracion los hereda sola; si el shim viviera despues de las
-- migraciones habria que concederlos tabla por tabla y el proxima forgot.
-- OJO: solo aplican a objetos que cree el MISMO rol que ejecuta este ALTER, y las
-- migraciones tambien las ejecuta `postgres`, asi que encajan.
alter default privileges in schema public
  grant select on tables to anon, authenticated;
alter default privileges in schema public
  grant insert, update, delete on tables to authenticated;
alter default privileges in schema public
  grant all on tables to service_role;

comment on role anon is 'Shim local. En produccion la crea Supabase.';
comment on role authenticated is 'Shim local. En produccion la crea Supabase.';
comment on role service_role is
  'Shim local. Unico rol con BYPASSRLS: webhook de Stripe y cron. Ver cabecera.';

-- El JWT completo. De aqui sale `tenant_id`.
-- `request.jwt.claim` es el setting legacy de un solo claim; `request.jwt.claims`
-- es el payload entero en JSON. Supabase usa este ultimo. Se leen ambos para no
-- romper si alguien replica un entorno viejo.
create or replace function auth.jwt()
returns jsonb
language sql
stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb,
    nullif(current_setting('request.jwt.claim', true), '')::jsonb,
    '{}'::jsonb
  )
$$;

comment on function auth.jwt() is
  'Shim local. En produccion la crea GoTrue. Ver cabecera del fichero.';

-- El `sub` del JWT: el id del usuario en `auth.users`.
create or replace function auth.uid()
returns uuid
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.sub', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ),
    ''
  )::uuid
$$;

comment on function auth.uid() is
  'Shim local. En produccion la crea GoTrue. Ver cabecera del fichero.';

-- `authenticated` | `anon` | `service_role`.
-- Las politicas lo usan para distinguir a un usuario de un webhook de Stripe.
create or replace function auth.role()
returns text
language sql
stable
as $$
  select nullif(
    coalesce(
      nullif(current_setting('request.jwt.claim.role', true), ''),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
    ),
    ''
  )::text
$$;

comment on function auth.role() is
  'Shim local. En produccion la crea GoTrue. Ver cabecera del fichero.';

-- El RLS se provee con `set local role authenticated`, no con un claim, asi que
-- esta tabla no se usa. Se deja solo para que un `GRANT` futuro de la app
-- reviente aqui en lugar de en produccion con un error de relacion inexistente.
create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique
);

comment on table auth.users is
  'Placeholder local. En produccion la gestiona GoTrue. No se usa en el MVP.';
