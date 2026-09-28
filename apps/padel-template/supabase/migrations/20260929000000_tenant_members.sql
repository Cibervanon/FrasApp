-- =============================================================================
-- 20260929000000: tenant_members
--
-- Quien es el gestor de un tenant (spec t13-stripe-connect.md, OQ-7). Un solo rol
-- permitido (`'gestor'`), sin niveles de permiso: la spec madre dijo "sin tabla de
-- roles en el MVP", y esta tabla NO es una tabla de roles, es el enlace de
-- pertenencia "esta persona gestiona este club" con UN unico valor posible.
--
-- Por que es tabla de NEGOCIO y por eso lleva `tenant_id` + RLS completa (regla 2):
-- una fila dice quien manda en UN club, y el servidor debe poder preguntar "el sub
-- de esta sesion tiene fila de gestor en el tenant del JWT" SIN poder leer la lista
-- de gestores de otro club. El aislamiento lo da la misma `current_tenant_id()`
-- del JWT, como en tenant_branding.
--
-- `auth.users` solo por `id` (convencion 4): en local vive el shim, en produccion
-- GoTrue. La FK exige que el gestor sea una persona de verdad.
-- =============================================================================

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id   uuid not null references auth.users(id) on delete cascade,
  role      text not null,
  created_at timestamptz not null default now(),

  primary key (tenant_id, user_id),

  -- Un solo rol en el MVP. Cualquier otro valor (socio, recepcionista, dueno) es
  -- fase 2 y se decidira ahi, no con un uncheck.
  constraint tenant_members_role_gestor check (role = 'gestor')
);

create index tenant_members_user_idx
  on public.tenant_members (user_id);

comment on table public.tenant_members is
  'Persona que gestiona un club. Un unico rol (gestor) en el MVP; sin niveles de permiso.';

comment on constraint tenant_members_role_gestor on public.tenant_members is
  'Solo existe el rol gestor en el MVP (OQ-7). Un socio no es miembro aqui: es un usuario de reservas.';

-- -----------------------------------------------------------------------------
-- RLS. Mismo patron que tenant_branding: politica POR OPERACION, `tenant_id` la de
-- `auth.jwt()`, y `with check` explicito en insert/update para que la politica no
-- permita escribir filas de otro tenant.
-- -----------------------------------------------------------------------------

alter table public.tenant_members enable row level security;
alter table public.tenant_members force row level security;

create policy tenant_members_select on public.tenant_members
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy tenant_members_insert on public.tenant_members
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy tenant_members_update on public.tenant_members
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy tenant_members_delete on public.tenant_members
  for delete to authenticated
  using (tenant_id = public.current_tenant_id());