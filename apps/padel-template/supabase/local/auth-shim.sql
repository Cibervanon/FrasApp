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
    nullif(current_setting('request.jwt.claims', true), ''),
    nullif(current_setting('request.jwt.claim', true), ''),
    '{}'::jsonb
  )::jsonb
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
