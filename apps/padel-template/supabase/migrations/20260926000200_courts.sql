-- =============================================================================
-- 002: Catalogo de pistas
--
-- `courts` es lo que se vende, y `court_blocks` el overlay que lo cierra sin generar
-- reservas. Las dos son tablas de negocio: `tenant_id not null`, RLS con
-- `FORCE ROW LEVEL SECURITY` y politica por operacion, igual que en la 001.
--
-- Convenciones de la seccion 4 de la spec, que se repite aqui para que no haya que
-- subir a buscarlas:
--   - `tenant_id uuid NOT NULL`
--   - dinero en `integer` de centimos, nunca float ni numeric
--   - RLS con `FORCE ROW LEVEL SECURITY`, politica por operacion
--
-- `deleted_at` en vez de borrar la fila: el historial de reservas necesita saber a que
-- pista apuntan, y si el borrado fuera fisico la reserva se quedaria colgada. Por eso el
-- `unique` de nombre es PARCIAL, con `where deleted_at is null`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- courts
-- -----------------------------------------------------------------------------
create table public.courts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  name text not null,
  court_type text not null,
  surface text,
  indoor boolean not null default false,

  num_players int not null default 4,
  default_duration_min int not null default 90,
  min_duration_min int not null default 60,
  max_duration_min int not null default 180,

  -- Centimos, IVA incluido (OQ-6): el precio que ve el socio es el precio final.
  base_price_cents int not null,

  sort_order int not null default 0,
  is_active boolean not null default true,
  image_path text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,

  -- Redundante como DATO, y aun asi necesaria: `id` ya es unico. Existe para que
  -- `court_blocks` pueda referenciar (tenant_id, id) y que la FK incluya el tenant.
  -- Ver la nota de la FK de abajo, que es el motivo de que exista esta linea.
  constraint courts_tenant_id_key unique (tenant_id, id),

  -- Las duraciones tienen que ser ORDENADAS. Sin esto, una pista con min 120 y default
  -- 90 se podria crear, y la disponibilidad generaria slots de 90 minutos por debajo
  -- del minimo que el gestor ha puesto: un error que no se ve hasta que una reserva
  -- sale mal.
  constraint courts_duration_ordering
    check (min_duration_min <= default_duration_min and default_duration_min <= max_duration_min),

  -- Aparte del de orden, porque el de orden NO cubre el cero: con min 0, la cadena
  -- 0 <= 90 <= 180 se cumple y la pista aceptaria reservas de 0 minutos.
  constraint courts_duration_positive
    check (min_duration_min > 0),

  constraint courts_num_players_range
    check (num_players between 2 and 4),

  -- Un precio negativo no es un descuento: es una reserva que paga el club.
  constraint courts_base_price_non_negative
    check (base_price_cents >= 0),

  -- La spec escribe estos valores como COMENTARIO al lado de la columna, no como
  -- `check`. Se suben a restriccion por el fallo que provoca dejarlos libres: con
  -- `court_type` libre, una pista 'cristal' y otra 'Cristal' no se parecerian nunca al
  -- cruzar con `pricing_rules.scope = 'court_type'`, y la tarifa del club no se aplicaria
  -- a ninguna de las dos sin que saltase NINGUN error. Se rompe en silencio.
  --
  -- `surface` es la unica de las dos que la spec deja nullable, asi que su `check`
  -- admite null en vez de exigir un valor.
  constraint courts_court_type_allowed
    check (court_type in ('cristal', 'malla', 'mixto')),

  constraint courts_surface_allowed
    check (surface is null or surface in ('cesped', 'lomo', 'hormigon')),

  constraint courts_name_not_blank
    check (length(btrim(name)) > 0),

  -- Una ruta de Storage, no una URL, igual que en `tenant_branding`.
  constraint courts_image_path_format
    check (image_path is null or image_path ~ '^[A-Za-z0-9/_.-]+$')
);

comment on column public.courts.surface is
  'Opcional a proposito: un club sin pista cubierta puede dejarlo vacio en vez de tener que elegir entre los tres valores.';

comment on column public.courts.deleted_at is
  'Borrado logico. Las reservas antiguas siguen apuntando a la fila, y el unique de nombre lo ignora para poder reutilizarlo.';

-- Indice UNIQUE PARCIAL: es lo que permite tener "Pista 2" retirada y volver a crear
-- "Pista 2" sin tener que renombrar la vieja, que es justo lo que un club no quiere
-- hacer. Es `(tenant_id, name)` y no `name` porque sin el tenant dos clubes con una
-- "Pista 1" no podrian coexistir en la misma base.
create unique index courts_tenant_name_active_uniq
  on public.courts (tenant_id, name)
  where deleted_at is null;

-- La disponibilidad filtra por tenant, activas y en orden, siempre. Sin este indice
-- el catalogo publico seria un seq scan de la tabla entera en cada carga.
create index courts_tenant_active_sort_idx
  on public.courts (tenant_id, sort_order, name)
  where is_active and deleted_at is null;

-- -----------------------------------------------------------------------------
-- court_blocks: overlay de disponibilidad. NO genera reservas (seccion 4.2).
--
-- Un cierre de mantenimiento no es un booking: no ocupa un jugador, no se cobra y no
-- entra en el calculo de reembolso. Es una franja que la consulta de disponibilidad
-- salta por encima.
-- -----------------------------------------------------------------------------
create table public.court_blocks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- FK COMPUESTA, y esta es la decision que mas importa de esta migracion.
  --
  -- La spec escribe `court_id uuid not null references courts(id) on delete cascade`, y
  -- eso NO lleva el tenant dentro de la referencia: permite que el tenant A cree un
  -- bloqueo sobre una pista del tenant B. El bloqueo no apareceria en la disponibilidad
  -- de B, pero si en la de A, sobre una pista que no es suya, y el `court_id` que sale
  -- en el panel del gestor es de otro club.
  --
  -- Con (tenant_id, court_id) -> (tenant_id, id) esa combinacion deja de existir en la
  -- base. Se hace en la FK y no en un trigger ni en una comprobacion de la API porque
  -- la base no depende de que nadie se acuerde de validarlo: un INSERT que venga de un
  -- script, de un curl o de un `psql` tampoco se cuela.
  court_id uuid not null,

  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null,
  created_by uuid,
  created_at timestamptz not null default now(),

  constraint court_blocks_tenant_court_fkey
    foreign key (tenant_id, court_id)
    references public.courts (tenant_id, id)
    on delete cascade,

  -- `>` y no `>=`: un bloque de duracion 0 no cierra nada, y aceptarlo solo genera
  -- filas que estorban en el overlay de disponibilidad.
  constraint court_blocks_ends_after_starts
    check (ends_at > starts_at),

  -- Mismo razon que en `courts_court_type_allowed`: la spec lo deja como comentario, y
  -- un `reason` libre no rompe nada visible, pero ensucia el dato que el gestor ve.
  constraint court_blocks_reason_allowed
    check (reason in ('mantenimiento', 'privado', 'evento', 'cierre'))
);

-- La disponibilidad pregunta "bloques de ESTA pista entre ESTAS dos horas". El indice
-- es el que hace que esa pregunta no sea un seq scan.
create index court_blocks_lookup_idx
  on public.court_blocks (tenant_id, court_id, starts_at, ends_at);

comment on table public.court_blocks is
  'Overlay de disponibilidad. NO genera reservas: no ocupa jugador, no se cobra y no entra en el calculo de reembolso.';

-- =============================================================================
-- RLS
-- =============================================================================

alter table public.courts enable row level security;
alter table public.courts force row level security;

alter table public.court_blocks enable row level security;
alter table public.court_blocks force row level security;

-- --- courts ------------------------------------------------------------------
create policy courts_select on public.courts
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

-- El `WITH CHECK` es lo que impide INSERTAR filas de otro tenant. Sin el, una politica
-- `USING` sola dejaria escribir en el tenant ajeno aunque no se pudiera leer.
create policy courts_insert on public.courts
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy courts_update on public.courts
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy courts_delete on public.courts
  for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- --- court_blocks ------------------------------------------------------------
-- Politicas identicas a las de `courts`, y a proposito: un cierre es tan dato del
-- club como una pista. Copiadas en vez de agrupadas porque `USING`/`WITH CHECK` se
-- evaluan por tabla, no por nombre de politica.
create policy court_blocks_select on public.court_blocks
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy court_blocks_insert on public.court_blocks
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy court_blocks_update on public.court_blocks
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy court_blocks_delete on public.court_blocks
  for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- -----------------------------------------------------------------------------
-- updated_at automatico
-- -----------------------------------------------------------------------------
create trigger courts_set_updated_at
  before update on public.courts
  for each row execute function public.set_updated_at();
