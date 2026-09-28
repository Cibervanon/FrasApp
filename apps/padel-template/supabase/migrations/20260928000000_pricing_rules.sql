-- =============================================================================
-- 004: Tarifas de precio
--
-- `pricing_rules` es la tabla que convierte un precio base de pista en una tarifa
-- condicional: por rango de horas, por dia de la semana, por tipo de pista o por
-- pista. La resuelve el motor puro de T7 (`resolvePrice`), que llega aqui DESDE
-- la API con las reglas enteras; esta migracion solo garantiza que lo que entra
-- en la tabla es un dato coherente.
--
-- Convenciones de la seccion 4 de la spec, igual que en las migraciones 002/003:
--   - `tenant_id uuid NOT NULL`
--   - dinero en `integer` de centimos, IVA incluido (OQ-6), nunca float
--   - RLS con `FORCE ROW LEVEL SECURITY`, politica por operacion
-- =============================================================================

-- -----------------------------------------------------------------------------
-- pricing_rules
-- -----------------------------------------------------------------------------
create table public.pricing_rules (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- Visible en el panel del gestor: "Tarifa punta 18-21h".
  name text not null,
  -- 'global' no mira ni pista ni tipo; los otros dos, solo el suyo.
  scope text not null,
  court_type text,
  court_id uuid,

  -- 0 domingo a 6 sabado. `{}` (vacio) = todos los dias.
  day_of_week int[] not null,
  -- Hora LOCAL del club, `HH:MM`. Postgres admite `24:00` como final de dia, y el
  -- motor de T7 lo acepta a proposito (una franja que use `24:00` cubre hasta
  -- medianoche).
  start_time time not null,
  end_time time not null,

  -- La regla define la duracion del slot. Default 90, sin selector en la UI.
  duration_min int not null default 90,
  -- Centimos, IVA incluido, del PRECIO DE LA PISTA. El `player_multiplier` de
  -- abajo es lo que multiplica por jugadores cuando aplica.
  price_cents int not null,
  -- Si es true, `price_cents` se multiplica por el numero de jugadores que trae
  -- la reserva. El precio BASE de la pista nunca se multiplica (spec 7.3).
  player_multiplier boolean not null default false,
  -- Desempate explicito entre reglas del MISMO scope: mayor numero gana.
  priority int not null default 0,

  -- Ventana de validez. `null` = sin limite por ese lado; los dos extremos son
  -- INCLUSIVOS (decidido en el spec de T7).
  valid_from date,
  valid_to date,

  is_active boolean not null default true,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- Redundante como DATO, y aun asi necesaria: `id` ya es unico. Existe para que
  -- la FK compuesta de abajo pueda referenciar (tenant_id, court_id) y anclar la
  -- regla a un club y a una pista del MISMO club. Mismo motivo que
  -- `courts_tenant_id_key` en la migracion de pistas.
  constraint pricing_rules_tenant_court_key unique (tenant_id, court_id),

  -- Coherencia de `scope`: cada alcance exige EXACTAMENTE su columna y nada mas.
  -- Sin esto, una regla `court_type` sin tipo se crearia y no aplicaria a nada
  -- sin que saltase ningun error visible desde el panel.
  constraint pricing_rules_scope_coherent
    check (
      (scope = 'global' and court_type is null and court_id is null)
      or (scope = 'court_type' and court_type is not null and court_id is null)
      or (scope = 'court' and court_type is null and court_id is not null)
    ),

  -- La spec escribe los valores de `scope` como enumeracion del comentario, y se
  -- suben a restriccion por el mismo fallo que en `courts_court_type_allowed`:
  -- un `scope` libre se rompe en silencio.
  constraint pricing_rules_scope_allowed
    check (scope in ('global', 'court_type', 'court')),

  constraint pricing_rules_court_type_allowed
    check (court_type is null or court_type in ('cristal', 'malla', 'mixto')),

  -- Cada dia de la semana tiene que existir. El operador `<@` ("contenido por")
  -- solo deja pasar arrays que sean subconjunto de los dias validos, y un array
  -- vacio esta contenido por cualquier array: `{}` = todos los dias, y es un
  -- valor legal (spec 4.3).
  constraint pricing_rules_day_of_week_range
    check (day_of_week <@ array[0, 1, 2, 3, 4, 5, 6]::int[]),

  -- DECISION del spec de T7: una franja con `start_time > end_time` NO se
  -- interpreta cruzando medianoche. Se prohibe aqui, en la base, para que el
  -- gestor no pueda escribir una regla que el motor descarta en silencio. El
  -- `24:00` de `end_time` sigue siendo valido porque 00:00 <= 24:00.
  constraint pricing_rules_hours_ordered
    check (start_time <= end_time),

  -- Un slot de 0 minutos no es una tarifa, es una trampa de la UI.
  constraint pricing_rules_duration_positive
    check (duration_min > 0),

  -- Un precio negativo no es un descuento: es una reserva que paga el club.
  constraint pricing_rules_price_non_negative
    check (price_cents >= 0),

  constraint pricing_rules_name_not_blank
    check (length(btrim(name)) > 0),

  -- FK COMPUESTA, como la de `court_blocks`: una regla `court` solo puede mirar a
  -- una pista del MISMO club. Con `court_id references courts(id)` a pelo, el
  -- tenant A podria fijar una tarifa sobre una pista del tenant B, que no se
  -- aplicaria en la disponibilidad de B pero si en la de A.
  --
  -- `court_id` es nullable (las reglas global y de tipo no miran ninguna pista), y
  -- una FK no se evalua sobre columnas NULL: solo se exige cuando la regla es
  -- efectivamente de pista, que es el caso que protege.
  constraint pricing_rules_tenant_court_fkey
    foreign key (tenant_id, court_id)
    references public.courts (tenant_id, id)
    on delete cascade
);

comment on table public.pricing_rules is
  'Tarifas de precio por pista, tipo de pista o todo el club. Las resuelve el motor de T7 desde la API.';

comment on column public.pricing_rules.scope is
  'Alcance de la regla. Cuanto mas concreto, mas peso: court gana a court_type y court_type a global, sin mirar la prioridad.';

comment on column public.pricing_rules.day_of_week is
  'Dias en que aplica, 0 domingo a 6 sabado. Vacio = todos los dias.';

comment on column public.pricing_rules.priority is
  'Desempate dentro del MISMO scope: mayor numero gana. Entre scopes distintos no se compara.';

comment on column public.pricing_rules.player_multiplier is
  'Multiplica el precio por el numero de jugadores de la reserva. La tarifa base de la pista nunca se multiplica.';

-- La disponibilidad carga TODAS las reglas del tenant por request. Es una tabla
-- pequena (un club tiene unas decenas de tarifas), y el indice por `tenant_id`
-- es lo que hace que esa carga no sea un seq scan de la tabla entera.
create index pricing_rules_tenant_idx
  on public.pricing_rules (tenant_id);

-- =============================================================================
-- RLS. Mismo patron que las tablas de negocio anteriores: FORCE y politica por
-- operacion, filtrando por `current_tenant_id()`.
-- =============================================================================

alter table public.pricing_rules enable row level security;
alter table public.pricing_rules force row level security;

create policy pricing_rules_select on public.pricing_rules
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy pricing_rules_insert on public.pricing_rules
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy pricing_rules_update on public.pricing_rules
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy pricing_rules_delete on public.pricing_rules
  for delete to authenticated
  using (tenant_id = public.current_tenant_id());

-- -----------------------------------------------------------------------------
-- updated_at automatico, igual que en las migraciones anteriores.
-- -----------------------------------------------------------------------------
create trigger pricing_rules_set_updated_at
  before update on public.pricing_rules
  for each row execute function public.set_updated_at();