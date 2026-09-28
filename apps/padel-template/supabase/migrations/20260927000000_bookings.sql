-- =============================================================================
-- 003: `bookings`, la tabla critica (spec 4.4, 4.4.1, 7.4)
--
-- Aqui vive el dinero y el solape. Tres cosas deciden el diseno entero:
--
--   1. El `EXCLUDE` compuesto con `btree_gist` impide dos reservas que se solapan en
--      la misma pista, con el predicado de estados VIGENTES. Postgres lo rechaza en
--      el INSERT, sin importar quien escriba: la API, un curl o un psql a pelo.
--   2. El predicado del `EXCLUDE` tiene que ser IMMUTABLE, y `now()` es STABLE, asi
--      que la obvia "y ademas no caducado" se rechaza (seccion 4.4.1). La limpieza
--      de holds caducados vive en dos piezas: la lectura filtra, y la escritura
--      expira dentro de la transaccion (T11) con un cron de red de seguridad.
--   3. `price_cents` es SNAPSHOT: nada lo recalcula despues de crearse. El motor de
--      precio (T7) resuelve ANTES del INSERT, y el importe del booking queda
--      congelado: un cambio de tarifa del club no altera reservas ya creadas.
--
-- Convenciones de la seccion 4, repetidas de la 002 para no subir a buscarlas:
--   - `tenant_id uuid NOT NULL`
--   - dinero en `integer` de centimos, nunca float ni numeric
--   - RLS con `FORCE ROW LEVEL SECURITY`, politica por operacion
--   - FK COMPUESTA al catalogo, igual que `court_blocks`
-- =============================================================================

-- -----------------------------------------------------------------------------
-- btree_gist, OBLIGATORIO para el EXCLUDE compuesto
--
-- Sin el, Postgres no puede indexar las columnas escalares (`uuid`) dentro de un
-- `EXCLUDE USING gist`: es el error mas comun al montar esto. La instala la migracion
-- 000, asi que aqui solo se comprueba con un mensaje que diga que hacer. UN CREATE
-- EXTENSION A SECO daria "already exists" a la segunda ejecucion en entornos donde el
-- DBA la creo con otro schema.
-- -----------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'btree_gist') then
    if exists (select 1 from pg_available_extensions where name = 'btree_gist') then
      create extension if not exists btree_gist;
    else
      raise exception
        'btree_gist no esta disponible en este PostgreSQL. Sin esta extension el EXCLUDE compuesto de bookings no puede indexar uuid, y dos reservas que se solapan NO se rechazarian. En Supabase viene montado; en un PostgreSQL de Windows faltan los ficheros de contrib.';
    end if;
  end if;
end
$$;

-- -----------------------------------------------------------------------------
-- bookings
-- -----------------------------------------------------------------------------
create table public.bookings (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,

  -- FK COMPUESTA, misma decision que en `court_blocks` y por el MISMO motivo, solo
  -- que aqui es peor: es la tabla del dinero. La spec escribe
  -- `court_id references courts(id)`, y eso deja que el tenant A reserve una pista
  -- del tenant B: el cobro iria a la cuenta Express del club equivocado. Probado con
  -- control negativo en `court_blocks` (T4); aqui se repite porque el importe de la
  -- reserva depende de la pista, y una reserva cruzada cobraria a un club la pista de
  -- otro. `courts_tenant_id_key unique (tenant_id, id)` ya existe desde T4.
  court_id uuid not null,

  -- El titular de la reserva. FK a `auth.users(id)` por id, nunca por email
  -- (seccion 4). SIN `on delete cascade` a proposito: cuando T19 borre los datos de
  -- un socio por RGPD, el borrado tiene que decidir que pasa con sus reservas
  -- (anonimizar o eliminar) de forma explicita y auditada, no por una cascada
  -- silenciosa. Con NO ACTION, un usuario con reservas no se puede borrar hasta que
  -- T19 decida, que es el comportamiento seguro.
  user_id uuid not null references auth.users(id),

  starts_at timestamptz not null,
  ends_at timestamptz not null,

  status text not null default 'held',
  -- La spec lo escribe como COMENTARIO al lado de la columna. Se sube a `check` por
  -- el mismo fallo que `court_type` en T4: el predicado del EXCLUDE compara con los
  -- valores EXACTOS, y un 'Held' con mayuscula o un 'held ' con espacio no coincidiria
  -- con ninguno. Consecuencia en silencio: la reserva NO bloquearia la pista y dos
  -- socios pagarian el mismo slot.
  constraint bookings_status_allowed
    check (status in (
      'held', 'pending_payment', 'confirmed', 'cancelled', 'completed', 'no_show', 'expired'
    )),

  -- "obligatorio si status='held'": un hold sin caducidad NO caduca nunca, y el slot
  -- queda bloqueado para siempre hasta que alguien lo borra a mano. El check lo
  -- hace imposible de crear.
  hold_expires_at timestamptz,
  constraint bookings_hold_expires_required
    check (status <> 'held' or hold_expires_at is not null),

  -- SNAPSHOT, nunca recalcular. El motor de precio (T7) resuelve antes del INSERT.
  price_cents int not null,
  -- Trazabilidad de la regla aplicada: el desglose de `PriceQuote` (T7). Necesario
  -- para que el panel del gestor explique por que un slot costaba mas, y para que
  -- una auditoria pueda reproducir el precio sin las reglas de hoy.
  price_breakdown jsonb not null,
  currency text not null default 'eur',

  -- El mismo rango que `courts`: padel son 2 o 4. Un booking de 1 jugador rompe el
  -- motor (el multiplicador de jugadores de T7 exige > 0) y una reserva de 0 no es
  -- una reserva.
  num_players int not null default 4,
  player_name text not null,

  -- RGPD / menores (OQ-8). El umbral sale de `tenants.min_player_age` y `is_minor` se
  -- calcula EN SERVIDOR (T14c): el cliente no lo manda. Los 4 campos de tutor son
  -- obligatorios si y solo si es menor: el `check` de abajo lo cierra como SEGUNDA
  -- capa (defensa en profundidad), porque un check de BD no impide que el servidor
  -- acepte `is_minor = false` manipulado; solo el calculo en servidor lo cierra.
  is_minor boolean not null default false,
  guardian_name text,
  guardian_email text,
  guardian_phone text,
  guardian_consent_at timestamptz,
  constraint bookings_minor_guardian_required
    check (
      not is_minor
      or (guardian_name is not null
          and guardian_email is not null
          and guardian_phone is not null
          and guardian_consent_at is not null)
    ),

  -- Libre, sin datos sensibles. El MVP no modela salud ni notas medicas: la spec lo
  -- prohibe y T19 lleva un test que falla si aparece una columna de salud.
  notes text,

  -- Stripe Connect (OQ-2). El cargo se crea con transfer_data.destination apuntando a
  -- la cuenta Express DEL CLUB. Los ids quedan para conciliar con Stripe; el socio no
  -- los ve nunca.
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_transfer_id text,
  stripe_application_fee_cents int not null default 0,

  -- La spec lo escribe como COMENTARIO. Se sube a `check` por el mismo motivo que
  -- `status`: el trigger de invitaciones (T16) compara con `payment_status = 'paid'`,
  -- y un 'Paid' con mayuscula no coincidiria NUNCA: se podria invitar con una reserva
  -- sin pagar sin que saltase ningun error.
  payment_status text,
  constraint bookings_payment_status_allowed
    check (payment_status is null or payment_status in ('unpaid', 'paid', 'refunded')),

  amount_refunded_cents int not null default 0,

  -- Snapshot del tramo de cancelacion aplicado (T8 -> T14b). Nullables a proposito:
  -- solo se rellenan al cancelar, y una reserva viva no tiene tramo que mostrar.
  -- Para responder "me devolvieron X" sin recalcular contra una politica que el club
  -- pudo cambiar despues.
  refund_tier_hours_before int,
  refund_percent_applied int,

  -- Partido abierto al que pertenece, si aplica (OQ-3). Sin FK todavia: `open_matches`
  -- se crea en T15, y su migracion anade la referencia. Con FK aqui fallaria el
  -- db:reset porque la tabla destino no existe.
  open_match_id uuid,

  -- Edades y consentimiento (OQ-8). La fecha se compara en servidor contra el umbral
  -- del tenant, nunca en el cliente (T14c).
  player_birth_date date,
  guardian_relation text,
  constraint bookings_guardian_relation_allowed
    check (guardian_relation is null or guardian_relation in ('madre', 'padre', 'tutor_legal', 'otro')),

  cancellation_reason text,
  cancelled_at timestamptz,
  confirmed_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  -- La FK compuesta necesita la pareja (tenant_id, id) del lado destino. `id` ya es
  -- unico por la pk, pero la constraint de abajo exige el par; esta linea es la que
  -- la hace posible, igual que en `courts` desde T4.
  constraint bookings_tenant_id_key unique (tenant_id, id),

  -- `>` y no `>=`: una reserva de duracion 0 no ocupa nada y el EXCLUDE la dejaria
  -- pasar sin sentido.
  constraint bookings_ends_after_starts
    check (ends_at > starts_at),

  -- Un precio negativo no es un descuento: es una reserva que paga el club. Igual
  -- que en `courts.base_price_non_negative` (T4).
  constraint bookings_price_non_negative
    check (price_cents >= 0),

  -- El reembolso no puede superar lo pagado: garantiza que T14b no devuelva mas de
  -- lo que el socio pago, ni por un bug ni por manipulacion.
  constraint bookings_refund_amount_range
    check (amount_refunded_cents >= 0 and amount_refunded_cents <= price_cents),

  -- FK COMPUESTA al catalogo: la que impide reservar una pista de otro club. Ver el
  -- comentario de `court_id` arriba.
  constraint bookings_tenant_court_fkey
    foreign key (tenant_id, court_id)
    references public.courts (tenant_id, id)
    on delete cascade,

  -- El nombre del titular no vacio: una reserva sin quien la hizo no se puede
  -- mostrar en "mis reservas" ni invitar.
  constraint bookings_player_name_not_blank
    check (length(btrim(player_name)) > 0)
);

-- -----------------------------------------------------------------------------
-- EXCLUDE: el corazon del sistema (seccion 4.4.1)
--
-- Con predicado de estados VIGENTES y sin `now()`: el predicado tiene que ser
-- IMMUTABLE y `now()` es STABLE, asi que la variante obvia
-- "y ademas (hold_expires_at is null or hold_expires_at > now())" la RECHAZA Postgres
-- con "functions in index predicate must be marked IMMUTABLE". La suite de tests de
-- abajo documenta esa trampa con un intento real.
--
-- La limpieza de caducados vive en dos piezas (seccion 4.4.1):
--   1. Lectura: la consulta de disponibilidad filtra
--      `status in (...) and (hold_expires_at is null or hold_expires_at > now())`.
--      Un hold caducado NO ocupa la pantalla del socio.
--   2. Escritura: la limpieza perezosa de T11 expira los caducados DENTRO de la misma
--      transaccion que el INSERT, con `public.expire_stale_holds(tenant, court)`.
--   3. Red de seguridad: el `pg_cron` de abajo, cada minuto.
-- -----------------------------------------------------------------------------
alter table public.bookings add constraint bookings_no_overlap
  exclude using gist (
    tenant_id with =,
    court_id with =,
    tstzrange(starts_at, ends_at) with &&
  )
  where (status in ('held', 'pending_payment', 'confirmed'));

-- Indice de lectura y de limpieza: la disponibilidad pregunta "reservas VIGENTES de
-- ESTA pista entre ESTAS horas", y la limpieza perezosa hace un UPDATE acotado por
-- este indice. Sin el, ambas serian seq scans de la tabla entera en cada intento de
-- reserva.
create index bookings_tenant_court_status_idx
  on public.bookings (tenant_id, court_id, status, hold_expires_at);

-- -----------------------------------------------------------------------------
-- Limpieza perezosa de holds caducados (seccion 4.4.1, pieza 2)
--
-- La llama T11 antes de cada intento de reserva, dentro de la transaccion, con los
-- dos argumentos; y el cron de red de seguridad la llama SIN argumentos (por eso
-- llevan default null: "todos"). Los dos caminos con una sola funcion, y el
-- comportamiento depende solo de los argumentos.
--
-- USA `hold_expires_at`, NO `starts_at`: un hold caduca 3 minutos despues de
-- crearse, no cuando empieza la reserva. Con `starts_at`, un hold de una reserva de
-- manana seguiria vivo toda la tarde y bloqueando la pista hasta el dia siguiente.
--
-- Devuelve el numero de filas expiradas: es lo que el test de abajo afirma, y lo
-- que un log de limpieza puede registrar para saber si la limpieza esta viva.
-- -----------------------------------------------------------------------------
create or replace function public.expire_stale_holds(
  p_tenant uuid default null,
  p_court uuid default null
)
returns integer
language plpgsql
as $$
declare
  expired_count integer;
begin
  update public.bookings b
     set status = 'expired',
         updated_at = now()
   where b.status = 'held'
     and b.hold_expires_at <= now()
     and (p_tenant is null or b.tenant_id = p_tenant)
     and (p_court is null or b.court_id = p_court);
  get diagnostics expired_count = row_count;
  return expired_count;
end;
$$;

-- -----------------------------------------------------------------------------
-- updated_at automatico, igual que en `courts` (T4)
-- -----------------------------------------------------------------------------
create trigger bookings_set_updated_at
  before update on public.bookings
  for each row execute function public.set_updated_at();

-- -----------------------------------------------------------------------------
-- Red de seguridad: pg_cron cada minuto (seccion 4.4.1, pieza 3)
--
-- NO es la via principal, solo limpieza: los holds que nadie volvio a tocar. La via
-- principal es la limpieza perezosa de T11, que corre en la misma transaccion.
--
-- GUARDADO CON pg_available_extensions, Y NO UN `create extension` A SECO: el
-- PostgreSQL nativo de Windows (17.x) NO trae pg_cron, ni siquiera como extension
-- instalable, y un `create extension` a secso reventaria el `pnpm db:reset` en local
-- sin decir por que. En Supabase (produccion) pg_cron viene montado y el schedule se
-- crea. En local la red de seguridad queda sin programar y la limpieza perezosa de
-- T11 es la unica via: los tests de T10 la cubren, y el cron es red de seguridad
-- para produccion.
-- -----------------------------------------------------------------------------
do $cron$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
    perform cron.schedule(
      'expire-stale-holds',
      '* * * * *',
      $$select public.expire_stale_holds()$$
    );
  else
    raise notice
      'pg_cron no esta disponible en este PostgreSQL (local): la red de seguridad del cron queda sin programar. La limpieza perezosa de T11 es la via principal; en Supabase el schedule se crea con esta misma migracion.';
  end if;
end
$cron$;

-- -----------------------------------------------------------------------------
-- Comentarios
-- -----------------------------------------------------------------------------
comment on table public.bookings is
  'Reservas del club. La tabla del dinero y del solape: EXCLUDE compuesto con predicado de estados vigentes, precio snapshot, reembolso acotado por check.';
comment on column public.bookings.status is
  'held, pending_payment, confirmed, cancelled, completed, no_show, expired. El EXCLUDE solo bloquea held/pending_payment/confirmed.';
comment on column public.bookings.hold_expires_at is
  'Obligatorio si status=held (check). Un hold caduca 3 min despues de crearse, no cuando empieza la reserva.';
comment on column public.bookings.price_cents is
  'SNAPSHOT, nunca recalcular. Centimos IVA incluido (OQ-6).';
comment on column public.bookings.price_breakdown is
  'Desglose del PriceQuote (T7): regla aplicada, multiplicador de jugadores. Trazabilidad para el panel y para auditar.';
comment on column public.bookings.is_minor is
  'Se calcula EN SERVIDOR (T14c) comparando player_birth_date con tenants.min_player_age. El cliente no lo manda.';
comment on column public.bookings.refund_tier_hours_before is
  'Snapshot del tramo de cancelacion aplicado (T8). Null hasta que se cancela.';
comment on column public.bookings.refund_percent_applied is
  'Snapshot del porcentaje aplicado (T8). Null hasta que se cancela.';
comment on column public.bookings.stripe_application_fee_cents is
  'Siempre 0 al lanzamiento (OQ-13): el club no paga comision. Se queda la columna por si se pacta otro modelo.';
comment on function public.expire_stale_holds(uuid, uuid) is
  'Limpieza perezosa: marca expired los holds caducados. Con tenant+court desde la transaccion de T11; sin argumentos desde el cron.';
comment on constraint bookings_no_overlap on public.bookings is
  'Impide dos reservas que se solapan en la misma pista del mismo club, mientras esten held/pending_payment/confirmed.';

-- =============================================================================
-- RLS, identico a `courts` y `court_blocks`
-- =============================================================================
alter table public.bookings enable row level security;
alter table public.bookings force row level security;

create policy bookings_select on public.bookings
  for select to authenticated
  using (tenant_id = public.current_tenant_id());

create policy bookings_insert on public.bookings
  for insert to authenticated
  with check (tenant_id = public.current_tenant_id());

create policy bookings_update on public.bookings
  for update to authenticated
  using (tenant_id = public.current_tenant_id())
  with check (tenant_id = public.current_tenant_id());

create policy bookings_delete on public.bookings
  for delete to authenticated
  using (tenant_id = public.current_tenant_id());
