-- =============================================================================
-- 001: Tenancy
--
-- `tenants` es la tabla de IDENTIDAD: una fila por club. No lleva RLS de tenant
-- porque no es una tabla de negocio: es la que dice quien es cada tenant.
-- Las otras tres si, con `tenant_id` tomada de `auth.jwt()`.
--
-- Convenciones obligatorias de la seccion 4 de la spec:
--   - `tenant_id uuid NOT NULL` en toda tabla de negocio, parte de la PK
--   - `created_at timestamptz NOT NULL DEFAULT now()`
--   - dinero en `integer` de centimos, nunca float ni numeric
--   - RLS con `FORCE ROW LEVEL SECURITY`, politica por operacion
--   - ninguna FK a `auth.users` por email, siempre por id
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Helper: tenant_id del JWT.
--
-- `auth.jwt()` devuelve el JWT entero. Leer el claim a mano en cada politica
-- repetiria el mismo cast 6 veces (3 tablas x 2 operaciones) y cualquier typo
-- seria un agujero silencioso: la politica devolveria 0 filas en vez de fallar.
--
-- La funcion es STABLE para que Postgres pueda cachearla dentro de una consulta,
-- pero NO IMMUTABLE: depende de la sesion.
-- -----------------------------------------------------------------------------
create or replace function public.current_tenant_id()
returns uuid
language sql
stable
as $$
  select nullif(
    (select auth.jwt() ->> 'tenant_id'),
    ''
  )::uuid
$$;

comment on function public.current_tenant_id() is
  'tenant_id del JWT actual. Null si el JWT no lo trae o no es un uuid.';

-- -----------------------------------------------------------------------------
-- tenants: identidad del club. SIN RLS de tenant.
-- -----------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  currency text not null default 'eur',
  timezone text not null default 'Europe/Madrid',
  locale text not null default 'es-ES',

  -- Stripe Connect (OQ-2): cuentas Express. El dinero del alquiler va DIRECTO
  -- a la cuenta bancaria del club. La app NUNCA custodia fondos.
  stripe_account_id text unique,
  stripe_charges_enabled boolean not null default false,
  stripe_payouts_enabled boolean not null default false,
  stripe_onboarding_completed_at timestamptz,

  -- Regla de menores (OQ-8): 18 por defecto, configurable por tenant con este
  -- valor de fabrica SEGURO. Nunca 0 ni null.
  min_player_age int not null default 18
    check (min_player_age between 14 and 21),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint tenants_slug_format check (slug ~ '^[a-z0-9-]{2,40}$')
);

comment on column public.tenants.stripe_charges_enabled is
  'Feature gate real. Si es false, el club no puede recibir reservas de pago: el boton de pago no aparece y /api/payments/intent devuelve 503.';

comment on column public.tenants.min_player_age is
  'Edad minima del jugador. El servidor recalcula is_minor contra este valor; nunca acepta is_minor del cliente (OQ-8).';

-- -----------------------------------------------------------------------------
-- tenant_branding: la marca. Regla 1: nada de esto se hardcodea en componentes.
-- -----------------------------------------------------------------------------
create table public.tenant_branding (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  primary_color text not null,
  secondary_color text not null,
  logo_path text,
  favicon_path text,
  hero_image_path text,
  font_family text not null default 'Inter',
  -- Remitente de email ajustado por tenant (OQ-10): un solo proveedor y un solo
  -- dominio, el club no configura SMTP. Solo customize el "De:" que ve el socio.
  email_from_name text not null,
  email_reply_to text not null,
  updated_at timestamptz not null default now(),

  constraint tenant_branding_primary_color_hex
    check (primary_color ~ '^#[0-9a-fA-F]{6}$'),
  constraint tenant_branding_secondary_color_hex
    check (secondary_color ~ '^#[0-9a-fA-F]{6}$'),
  constraint tenant_branding_reply_to_email
    check (email_reply_to ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- Una ruta de Storage, no una URL: relativas al bucket para que cambiar de
  -- dominio no rompa nada. Sin espacios ni esquema.
  constraint tenant_branding_logo_path_format
    check (logo_path is null or logo_path ~ '^[A-Za-z0-9/_.-]+$'),
  constraint tenant_branding_favicon_path_format
    check (favicon_path is null or favicon_path ~ '^[A-Za-z0-9/_.-]+$'),
  constraint tenant_branding_hero_path_format
    check (hero_image_path is null or hero_image_path ~ '^[A-Za-z0-9/_.-]+$')
);

-- -----------------------------------------------------------------------------
-- tenant_features: regla 3, toda feature tiene su fila.
--
-- `feature_key` es texto, no un booleano suelto, para que anadir una feature no
-- requiera migracion.
-- -----------------------------------------------------------------------------
create table public.tenant_features (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  feature_key text not null,
  enabled boolean not null default false,
  config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),

  primary key (tenant_id, feature_key),

  -- Las 7 keys del MVP. Anadir una feature es anadir una fila a esta lista Y
  -- su fila en la seed: nunca un booleano suelto fuera del enum.
  constraint tenant_features_key_allowed check (
    feature_key in (
      'calendar',
      'booking',
      'payments',
      'open_matches',
      'news',
      'gdpr_export',
      'push_notifications'
    )
  )
);

create index tenant_features_enabled_idx
  on public.tenant_features (tenant_id, feature_key)
  where enabled;

-- -----------------------------------------------------------------------------
-- tenant_content: copy y configuracion que el club cambia.
--
-- Lleva la politica de cancelacion (OQ-5) y el aviso legal (OQ-9). El motor de
-- reembolso LEE estos tramos, nunca un importe fijo en codigo.
-- -----------------------------------------------------------------------------
create table public.tenant_content (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  content_key text not null,
  value jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  primary key (tenant_id, content_key),

  constraint tenant_content_key_allowed check (
    content_key in (
      'cancellation_policy',
      'terms_notice',
      'about_club'
    )
  )
);

-- =============================================================================
-- RLS
--
-- `FORCE ROW LEVEL SECURITY` para que las politas apliquen tambien al dueño de
-- la tabla (postgres, service_role). Sin FORCE, un `service_role` se saltaria
-- todo: exactamente el camino que usa el webhook de Stripe.
--
-- Politica POR OPERACION en las 3 tablas de negocio. Una politica `USING` sin
-- `WITH CHECK` permitiria INSERTAR filas de otro tenant: por eso los INSERT
-- llevan `WITH CHECK` explicito.
-- =============================================================================

alter table public.tenant_branding enable row level security;
alter table public.tenant_branding force row level security;

alter table public.tenant_features enable row level security;
alter table public.tenant_features force row level security;

alter table public.tenant_content enable row level security;
alter table public.tenant_content force row level security;

-- --- tenant_branding ---------------------------------------------------------
-- PK tenant_id, una fila por tenant: no puede haber dos marcas del mismo club.
create policy tenant_branding_select on public.tenant_branding
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy tenant_branding_insert on public.tenant_branding
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy tenant_branding_update on public.tenant_branding
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_branding_delete on public.tenant_branding
  for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- --- tenant_features ---------------------------------------------------------
create policy tenant_features_select on public.tenant_features
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy tenant_features_insert on public.tenant_features
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy tenant_features_update on public.tenant_features
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_features_delete on public.tenant_features
  for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- --- tenant_content ----------------------------------------------------------
create policy tenant_content_select on public.tenant_content
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy tenant_content_insert on public.tenant_content
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy tenant_content_update on public.tenant_content
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_content_delete on public.tenant_content
  for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- -----------------------------------------------------------------------------
-- updated_at automatico
--
-- En la BD y no en la app: si el update lo hace el servidor, un script manual o
-- el panel de Supabase dejarian la columna equivocada sin avisar.
-- -----------------------------------------------------------------------------
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger tenants_set_updated_at
  before update on public.tenants
  for each row execute function public.set_updated_at();

create trigger tenant_branding_set_updated_at
  before update on public.tenant_branding
  for each row execute function public.set_updated_at();

create trigger tenant_content_set_updated_at
  before update on public.tenant_content
  for each row execute function public.set_updated_at();
