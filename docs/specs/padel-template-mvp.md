# Spec: Plantilla PWA Club de Padel — MVP

> **Estado:** borrador para revision. Nada implementado.
> **Slug tecnico:** `padel-template` · **Vertical:** club de padel · **Linea:** plantilla de codigo
> **Repositorio:** `Cibervanon/FrasApp` · **Fecha:** 2026-09-26

---

## 0. Documento 4 — recibido y resuelto

**Estado: BLOQUEANTE CERRADO (2026-09-26).**

El Documento 4 se ha recuperado. Resuelve la unica ambiguedad que quedaba: el esquema de
`courts`, `pricing_rules`, `bookings` y `open_matches`.

**Mi propuesta de esquema SUSTITUYE a la del Documento 4 en tres puntos**, por decision
del usuario tras revisar la solucion tecnica:

| Punto | Decision | Sustituye a |
|---|---|---|
| Hold de 3 min | Lectura filtrada + limpieza perezosa en la transaccion + `pg_cron` de red de seguridad | El esbozo del Documento 4, que no resolvia la restriccion `IMMUTABLE` del predicado de `EXCLUDE` |
| Invitaciones | Trigger de BD que exige booking `confirmed` y `paid` | La regla sola que enunciaba el Documento 4, sin mecanismo |
| Partido abierto | Crea su propio `booking` (`status='confirmed'`, `price_cents = price_per_player_cents * total_slots`), **un solo cobro por pista** | La decision de producto queda confirmada (OQ-3) |

**Ademas se aprueban dos tablas que no estaban en el Documento 4 original:**
`court_blocks` (sin ella no se puede expressar "pista 2 cerrada por mantenimiento") y
`audit_log` (append-only, hace trazable y auditable el borrado RGPD).

**Lo que el Documento 4 no traia y ya esta correctamente reflejado:** la restriccion
VERI\*FACTU. La app no genera facturas ni datos fiscales; el pago se refleja en Stripe y la
factura la emite el club con su gestoria.

> **Nota sobre VERI\*FACTU — no la trates como cerrada.**
> Las fases de la normativa siguen moviendose. Ultima referencia manejada: **1/1/2027** y
> **1/7/2027** segun el sujeto obligado. **No des por cerrada ninguna fecha sin
> confirmar con un asesor fiscal** en el momento de construir el modulo de facturacion.
> Ese modulo esta **fuera del MVP** (seccion 13) y no se pre-disenara aqui.

---

## 1. Objetivo

Plantilla PWA multi-tenant que permite a un club de padel vender y confirmar reservas
de pistas con precio dinamico y pago con tarjeta, sin que el club toque codigo.

**Usuario final:** Socio del club (adulto, no tecnico, smartphone). Gestor del club
(adulto, no tecnico, escritorio o tablet).

**Exito =** un socio puede, desde el movil, ver disponibilidad real, reservar una pista,
pagar con tarjeta y invitar a sus companeros, y el gestor puede cambiar precios, pistas,
marca y noticias sin intervencion tecnica.

**No es objetivo del MVP:** monedero prepago, clases/clinicas, torneos, POS. (Ver seccion 11.)

---

## 2. Supuestos que estoy haciendo — CONFIRMADOS

1. **Un club = un tenant.** Cada instalacion es una instancia Supabase aislada. La tabla
   `tenant_id` existe aun asi y la RLS se aplica completa: es defensa en profundidad y
   permite migrar a instancia compartida sin reescribir el esquema.
2. **Pago unico, sin suscripciones de pago al socio.** Stripe cobra por reserva. Sin
   Logic Billing en el flujo del socio. *(La cuota de mantenimiento que me pagas a mi si
   va por Stripe Billing, segun Documento 2, pero es un producto distinto y **fuera del
   MVP**: ver seccion 13.)*
3. **Sin facturacion fiscal en la app.** Restriccion confirmada (VERI\*FACTU, Documento 4
   s.4). La app **no** genera facturas, no almacena NIF del club, no desglosa IVA con
   efectos fiscales. El pago se refleja en Stripe; la factura la emite el club con su
   gestoria. Ver la nota de fechas en la seccion 0.
4. **Los slots son de duracion fija de 90 min.** Sin selector de duracion libre en el MVP:
   es complejidad de UI y de motor de precios que no ha pedido nadie. Si el club necesita
   60/120 min, se define con una `pricing_rules` de esa duracion, no con un selector.
5. **CONFIRMADO: Stripe Connect con cuentas Express.** El dinero del alquiler de pista va
   **directo a la cuenta bancaria del club**; la app nunca custodia fondos. Esto quita
   responsabilidad de custodia y encaja con el modelo de instancia aislada por cliente.
   La cuota de mantenimiento va aparte por Stripe Billing (Documento 2), fuera del MVP.
6. **Las invitaciones se entregan por email y por link.** Sin SMS.
7. **Reactivo de disponibilidad via Supabase Realtime**, no websockets propios.
8. **Navegadores moviles modernos** (iOS Safari 16+, Chrome Android 110+). Sin IE11.
9. **Los participantes de un partido abierto pueden ser socios registrados o invitados por
   email** (no todo el mundo tiene cuenta). Esto anade una tabla de invitados.
10. **El idioma del MVP es espanol (es-ES), con copy en `tenant_content` para que el club
    pueda ajustar textos.** No hay multi-idioma en el MVP.
11. **CONFIRMADO: email transaccional con Resend y dominio unico compartido** (OQ-10,
    OQ-11, OQ-12). No SMTP por tenant: un dueño de club no sabe configurar un servidor
    SMTP, y esa friccion lo mataria en la primera semana. Una sola cuenta de Resend, un
    solo dominio tecnico nuestro, y el **nombre** del remitente ajustado por tenant via
    `tenant_branding.email_from_name`. Ver seccion 16.
12. **Un unico rol `gestor` por tenant en el MVP.** Niveles de permiso (recepcionista vs.
    dueno) son feature de fase 2 y no se bloquean ahora.

→ Supuestos 1-12 revisados y confirmados. Las decisiones variables (OQ-1 a OQ-10) estan
cerradas en la seccion 15.

---

## 3. Mapa de capacidades (Phase 0 — aprobar antes de implementar)

Este brief empaqueta varias capacidades verificables por separado. Se construyen en este
orden; cada una tiene su propio criterio de "hecho".

| id | Modulo | Responsabilidad | Depende de |
|---|---|---|---|
| `tenancy` | Tenancy y branding | `tenant_id`, RLS, `tenant_branding`/`tenant_features`/`tenant_content`, panel de marca | — |
| `catalog` | Catalogo de pistas | `courts`, cierres y mantenimiento, disponibilidad base | `tenancy` |
| `pricing` | Precio dinamico | `pricing_rules`, motor de resolucion determinista | `catalog` |
| `booking` | Reservas y solapes | `bookings`, EXCLUDE gist, hold de 3 min, ciclo de estados | `pricing` |
| `payments` | Pago con tarjeta | Stripe PaymentIntent, webhook, cancelacion y reembolso | `booking` |
| `openmatch` | Partidos abiertos | `open_matches`, plazas, niveles, unirse y salir | `booking` |
| `invites` | Invitaciones | Crear y enviar invitaciones **solo post-pago** | `openmatch` |
| `news` | Noticias y comunicados | CRUD + publicacion, visible en PWA | `tenancy` |
| `gdpr` | Privacidad y borrado | Exportar y borrar datos del socio desde el panel | `booking`, `invites` |

**Orden de construccion:** `tenancy` -> `catalog` -> `pricing` -> `booking` -> `payments`
-> `openmatch` -> `invites` -> `news`, con `gdpr` cerrando el ciclo.

**Dos puntos donde las dependencias se cruzan y por tanto se fusionan:**

- `booking` y `payments` comparten la transaccion de confirmacion. El webhook de Stripe
  confirma la reserva; si separo los modulos, la reserva queda en un estado ambiguo
  ("pagada pero no confirmada"). **Se implementan juntos.**
- `gdpr` toca datos de `booking`, `openmatch` e `invites`. Se implementa al final, pero
  **el esquema desde el dia 1** guarda `user_id` explicito y evita borrado en cascada
 Anonimo, para que el borrado sea selectivo y auditable.

**Aprobame este mapa** (o los limites de estos dos modulos fusionados) antes de que
escriba el plan.

---

## 4. Modelo de datos — APROBADO (sustituye al Documento 4 s.2, ver seccion 0)

**Con convenciones obligatorias:**

- `tenant_id uuid NOT NULL` en **todas** las tablas, parte de la clave primaria.
- `created_at timestamptz NOT NULL DEFAULT now()`.
- Dinero en **`integer` de centimos**, campo `<nombre>_cents`. **Nunca `float`, nunca `numeric`
  para dinero**. Moneda fija `eur` por tenant. **`price_cents` es siempre IVA incluido**
  (OQ-6 confirmado).
- Toda tabla de negocio lleva `deleted_at timestamptz` para baja logica donde el borrado
  fisico romperia el historico.
- RLS activada con `FORCE ROW LEVEL SECURITY`, politica por operacion, `tenant_id` tomada
  de `auth.jwt()`.
- **Ninguna clave foranea a `auth.users` por email.** Siempre por `id`. Si el socio cambia
  su email, el resto del esquema sobrevive.

### 4.1 Tablas de tenancy

```sql
-- Identidad del club. No es una tabla de negocio: no lleva RLS de tenant.
tenants (
  id uuid pk, name text not null, slug text not null unique,
  currency text not null default 'eur',
  timezone text not null default 'Europe/Madrid',
  locale text not null default 'es-ES',

  -- Stripe Connect (OQ-2 confirmado, cuentas Express).
  -- El dinero del alquiler va DIRECTO a la cuenta bancaria del club.
  -- La app NUNCA custodia fondos.
  stripe_account_id text unique,          -- 'acct_...' de la cuenta Express del club
  stripe_charges_enabled boolean not null default false,
  stripe_payouts_enabled boolean not null default false,
  stripe_onboarding_completed_at timestamptz,

  -- Regla de menores (OQ-8 confirmado). 18 por defecto, configurable por tenant
  -- con este valor de fabrica SEGURO. Nunca 0 ni null.
  min_player_age int not null default 18 check (min_player_age between 14 and 21),

  created_at, updated_at
)
```

**`stripe_charges_enabled` es un feature gate real, no decorativo.** Si es `false`, el
club **no puede recibir reservas de pago**: el boton de pago no aparece y
`POST /api/payments/intent` devuelve 503 con un mensaje accionable para el gestor
("tu club aun no ha terminado de configurar los cobros"). Esto evita que un socio llegue
al paso de pago y se encuentre con un error de Stripe.

**El onboarding de Connect es parte del MVP.** Sin el, el club no cobra. Flujo: el gestor
entra en `/admin/pagos`, pulsa "conectar cobros", se le abre el onboarding de Stripe
Express, vuelve con `?setup=complete`, y un webhook `account.updated` actualiza
`stripe_charges_enabled` / `stripe_payouts_enabled`. **No se implementa panel de pagos en
`/admin` mas adelante: es bloqueante del MVP.**

```sql
tenant_branding (tenant_id pk+fk, primary_color, secondary_color, logo_path,
                 favicon_path, hero_image_path, font_family,
                 -- Remitente de email ajustado por tenant (OQ-10 confirmado).
                 -- Un solo proveedor compartido, un solo dominio: el club no
                 -- configura SMTP. Solo customize el "De:" que ve el socio.
                 email_from_name text,
                 email_reply_to text,
                 updated_at)

tenant_features (tenant_id, feature_key, enabled, config jsonb,
                 pk(tenant_id, feature_key))

tenant_content (tenant_id, content_key, value jsonb, pk(tenant_id, content_key))
```

**`tenant_content` lleva la politica de cancelacion (OQ-5 confirmado) y el aviso legal
(OQ-9 confirmado).** No van hardcodeados en el core: el club puede cambiarlos, y el copy de
la pantalla de confirmacion los lee de ahi.

```json
// tenant_content['cancellation_policy']
{
  "tiers": [
    { "hours_before": 24, "refund_percent": 100, "label": "Cancelacion gratuita hasta 24h antes" },
    { "hours_before": 12, "refund_percent": 50,  "label": "Entre 24h y 12h antes se devuelve el 50%" },
    { "hours_before": 0,  "refund_percent": 0,   "label": "Con menos de 12h no hay devolucion" }
  ],
  "policy_text": "...",
  "notice_text": "..."
}
```

Los tres tramos del ejemplo son el **valor por defecto sugerido** al club (patron
documentado en la investigacion UX: ventana similar a ClassPass). Son editables. El motor
de reembolso **lee estos tramos**, nunca un importe fijo en codigo.

**Invariante del motor de reembolso:** los tramos se ordenan por `hours_before`
descendente y se aplica el **primero que cumplas**. Con 25h de antelacion aplica el tramo
de 24h (100%); con 20h, el de 12h (50%); con 5h, el de 0h (0%). Caso limite exacto
(24h exactas) -> 100%. Se testea como tabla de casos.

`feature_key` es un enum de texto, no un booleano suelto, para que anadir una feature no
requiera migracion:

```
calendar, booking, payments, open_matches, news, gdpr_export, push_notifications
```

Cada feature del MVP **debe** tener su fila en `tenant_features`. Sin excepcion (regla 3).

### 4.2 `courts`

```sql
courts (
  id uuid pk, tenant_id uuid not null,
  name text not null,                    -- "Pista 3"
  court_type text not null,              -- 'cristal' | 'malla' | 'mixto'
  surface text,                          -- 'cesped' | 'lomo' | 'hormigon'
  indoor boolean not null default false,
  num_players int not null default 4 check (num_players between 2 and 4),
  default_duration_min int not null default 90,
  min_duration_min int not null default 60,
  max_duration_min int not null default 180,
  base_price_cents int not null check (base_price_cents >= 0),
  sort_order int not null default 0,
  is_active boolean not null default true,
  image_path text,
  created_at, updated_at, deleted_at,
  unique (tenant_id, name) where deleted_at is null
)
```

**Anadido que el brief no lista y que la disponibilidad exige:** sin esto no se puede
expresar "pista 2 cerrada por mantenimiento".

```sql
court_blocks (
  id uuid pk, tenant_id uuid not null,
  court_id uuid not null references courts(id) on delete cascade,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  reason text not null,                  -- 'mantenimiento' | 'privado' | 'evento' | 'cierre'
  created_by uuid, created_at,
  check (ends_at > starts_at)
)
```

`court_blocks` se aplica como overlay en la disponibilidad y **no** genera reservas.

### 4.3 `pricing_rules`

```sql
pricing_rules (
  id uuid pk, tenant_id uuid not null,
  name text not null,                    -- "Tarifa punta 18-21h" (visible en admin)
  scope text not null,                   -- 'global' | 'court_type' | 'court'
  court_type text,                       -- requerido si scope='court_type'
  court_id uuid,                         -- requerido si scope='court'
  day_of_week int[] not null,            -- 0=domingo .. 6=sabado. {} = todos
  start_time time not null,              -- hora LOCAL del club
  end_time time not null,
  duration_min int not null default 90,  -- la regla define la duracion del slot
  price_cents int not null check (price_cents >= 0),
  player_multiplier boolean not null default false,  -- cobrar x num_players
  priority int not null default 0,       -- desempate explicito
  valid_from date, valid_to date,
  is_active boolean not null default true,
  created_at, updated_at
)
```

**Sobre `duration_min` (OQ-4, confirmado):** el valor de fabrica es **90 min fijos** y la
UI **no** ofrece selector de duracion. `duration_min` existe para que el club defina una
regla a 60 o 120 min si lo necesita, no para que elija en cada reserva. Si el MVP se cierra
con todas las reglas a 90, la columna se queda y no se toca.

**`price_cents` es siempre IVA INCLUIDO (OQ-6, confirmado).** En Espana el precio mostrado
al consumidor final es el precio final. La UI **no** desglosa IVA: no hace falta, porque
la app no genera factura fiscal. La columna se interpreta directamente como
`importe_total_con_IVA`.

`check` de coherencia de scope:

```sql
check (
  (scope = 'global'   and court_id is null and court_type is null) or
  (scope = 'court_type' and court_id is null and court_type is not null) or
  (scope = 'court'    and court_id is not null)
)
```

### 4.4 `bookings` — la tabla critica

```sql
bookings (
  id uuid pk, tenant_id uuid not null,
  court_id uuid not null references courts(id),
  user_id uuid not null references auth.users(id),   -- titular de la reserva
  starts_at timestamptz not null,
  ends_at   timestamptz not null,
  status text not null default 'held',
     -- 'held' | 'pending_payment' | 'confirmed' | 'cancelled'
     -- | 'completed' | 'no_show' | 'expired'
  hold_expires_at timestamptz,            -- obligatorio si status='held'
  price_cents int not null,              -- SNAPSHOT, nunca recalcular
  price_breakdown jsonb not null,        -- trazabilidad de la regla aplicada
  currency text not null default 'eur',
  num_players int not null default 4,
  player_name text not null,

  -- RGPD / menores
  is_minor boolean not null default false,
  guardian_name text,
  guardian_email text,
  guardian_phone text,
  guardian_consent_at timestamptz,
  --^^ Si is_minor = true, los 4 campos de tutor son OBLIGATORIOS.
  --   Sin datos de salud. El MVP no modela salud ni notas medicas.

  notes text,                            -- libre, sin datos sensibles

  -- Stripe Connect (OQ-2). El cargo se crea con transfer_data.destination apuntando
  -- a la cuenta Express DEL CLUB: el importe va directo a su cuenta bancaria.
  -- No hay cuenta en custodia en la plataforma.
  --
  -- application_fee_cents (OQ-13): 0 al lanzamiento. El argumento de venta frente a
  -- Playtomic es "sin comision, como reservadeportes.com"; cobrar por transaccion
  -- contradiria el propio argumento de venta. Se queda la columna por si se pacta un
  -- modelo distinto con un cliente concreto. SIEMPRE 0 por defecto.
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_transfer_id text,               -- transferencia al club, si aplica
  stripe_application_fee_cents int not null default 0,
  payment_status text,                   -- 'unpaid' | 'paid' | 'refunded'
  amount_refunded_cents int not null default 0,
  -- Snapshot del tramo de cancelacion aplicado. Para responder "me devolvieron X"
  -- sin recalcular contra una politica que el club pudo cambiar despues.
  refund_tier_hours_before int,
  refund_percent_applied int,

  -- Partido abierto al que pertenece esta reserva, si aplica (OQ-3 confirmado).
  open_match_id uuid,

  -- Edades y consentimiento (OQ-8). El umbral sale de tenants.min_player_age
  -- (18 por defecto) y la fecha de nacimiento se compara en servidor.
  player_birth_date date,
  guardian_relation text,                -- 'madre'|'padre'|'tutor_legal'|'otro'

  cancellation_reason text,
  cancelled_at timestamptz,
  confirmed_at timestamptz,
  created_at, updated_at,
  check (ends_at > starts_at),
  check (amount_refunded_cents >= 0 and amount_refunded_cents <= price_cents)
)
```

**Sobre el menor (OQ-8, confirmado).** `is_minor` **no se acepta desde el cliente**: se
recalcula en servidor comparando `player_birth_date` con
`tenants.min_player_age`. Si el cliente envia `is_minor = false` con una fecha que
indique menor, el servidor lo corrige a `true` y exige tutor. Un check de BD
`if is_minor then (guardian_name, guardian_email, guardian_phone, guardian_consent_at)
is not null` cierra el circuito. El valor de fabrica `18` es seguro; el club puede bajar
a 16 si su federacion lo pide, pero **nunca a 0 ni a null**.

#### 4.4.1 Restriccion de no-solape (el corazon del sistema)

```sql
create extension if not exists btree_gist;

alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    tenant_id with =,
    court_id with =,
    tstzrange(starts_at, ends_at) with &&
  )
  where (status in ('held', 'pending_payment', 'confirmed'));
```

`btree_gist` es obligatorio: sin el, Postgres no puede indexar las columnas escalares
(`uuid`) dentro de un `EXCLUDE` compuesto. Es el error mas comun al montar esto.

**Trampa de Postgres que decide el diseno (importante):** el predicado del `EXCLUDE` debe
ser **IMMUTABLE**, y `now()` es **STABLE**. Por tanto esta variante, que seria la
obvia, ** Postgres la rechaza**:

```sql
-- INVALIDO. Postgres: "functions in index predicate must be marked IMMUTABLE"
  where (status in (...) and (hold_expires_at is null or hold_expires_at > now()))
```

**Solucion adoptada — dos piezas:**

1. **Lectura:** la consulta de disponibilidad filtra siempre
   `status in ('held','pending_payment','confirmed') and (hold_expires_at is null or hold_expires_at > now())`.
   Un hold caducado **no ocupa** la pantalla de disponibilidad.
2. **Escritura — limpieza perezosa dentro de la transaccion.** Antes de cada intento de
   reserva, y dentro de la misma transaccion que el `INSERT`, se ejecuta:

   ```sql
   update bookings set status = 'expired'
   where tenant_id = $1 and court_id = $2
     and status = 'held' and hold_expires_at <= now();
   ```

   Esto libera el slot de inmediato para el resto de transacciones y hace que el
   `EXCLUDE` evalue solo filas vigentes. Es un `UPDATE` acotado por indice.
3. **Red de seguridad:** un `pg_cron` cada minuto marca `expired` los holds caducados que
   nadie volvio a tocar. No es la via principal, solo limpieza.

El `EXCLUDE` sigue siendo **inmediato** (no `DEFERRABLE`): queremos error en el `INSERT`,
no en el `COMMIT`, para poder devolver un 409 con slots alternativos al usuario.

**Un segundo `EXCLUDE` mas la actualizacion de estado:** pasar un booking de `cancelled` a
`confirmed` si re-evalua la restriccion. Es el comportamiento correcto, no un bug.

### 4.5 `open_matches` y participantes

```sql
open_matches (
  id uuid pk, tenant_id uuid not null,
  court_id uuid not null references courts(id),
  created_by uuid not null references auth.users(id),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  level_min numeric(3,1) not null,      -- 1.0 - 5.0
  level_max numeric(3,1) not null,
  total_slots int not null,              -- 3, exhausta la pista
  price_per_player_cents int not null,   -- 0 = incluido en la reserva
  status text not null default 'open',  -- 'open'|'full'|'cancelled'|'completed'
  notes text, created_at, updated_at,
  check (total_slots between 3 and 4),
  check (ends_at > starts_at),
  check (level_min <= level_max)
)

open_match_participants (
  id uuid pk, tenant_id uuid not null,
  match_id uuid not null references open_matches(id) on delete cascade,
  user_id uuid references auth.users(id),   -- NULL si invitado sin cuenta
  display_name text not null,
  email text,
  level numeric(3,1),
  status text not null default 'joined',    -- 'joined'|'left'
  joined_at timestamptz not null default now(),
  unique (match_id, user_id) where status = 'joined'
)
```

**Un partido abierto reserva su propia pista en `bookings` — CONFIRMADO (OQ-3).**
Si no, la pista esta ocupada para el calendario pero no para el motor de precios, y
aparece un conflicto al pagar. Al crear un partido abierto se inserta, **en la misma
transaccion**, un `bookings` con `user_id = created_by`, `status='confirmed'`,
`payment_status='paid'`, `price_cents = price_per_player_cents * total_slots`, y
`open_match_id` que lo referencia.

**Un solo cobro por pista.** El reparto entre los 4 jugadores es un problema del club
(efectivo, Bizum entre ellos), no de la app. Anadir cobro por jugador supondria una capa
de conciliacion de pagos que no aporta valor al MVP.

**Consecuencia que hay que asumir explicitamente:** el creador de un partido abierto es
quien paga la pista entera por adelantado, y la app **no** le reembolsa por jugadores que
seoqueden sin plaza. Si un club necesita cobrar por jugador, es un modulo distinto y
fuera del MVP.

### 4.6 `invitations`

```sql
invitations (
  id uuid pk, tenant_id uuid not null,
  match_id uuid not null references open_matches(id) on delete cascade,
  booking_id uuid references bookings(id) on delete cascade,
  inviter_user_id uuid not null references auth.users(id),
  invitee_email text not null,
  token text not null unique,            -- opaco, aleatorio, >= 32 chars
  status text not null default 'pending', -- 'pending'|'accepted'|'declined'|'expired'
  sent_at timestamptz, accepted_at timestamptz, expires_at timestamptz not null,
  created_at,
  -- INVARIANTE: no puede existir una invitacion cuyo booking no este 'confirmed'.
  constraint invitations_require_confirmed_booking
    check (booking_id is not null)
)
```

La invariante "solo se invita tras el pago" **no** puede vivir en un `check`: el booking
cambia de estado despues de insertarse la invitacion. Se implementa con **un trigger**:

```sql
create function invitations_require_paid_booking() returns trigger as $$
begin
  if not exists (
    select 1 from bookings b
    where b.id = new.booking_id
      and b.tenant_id = new.tenant_id
      and b.status = 'confirmed'
      and b.payment_status = 'paid'
  ) then
    raise exception 'invitations_require_confirmed_booking'
      using errcode = 'check_violation';
  end if;
  return new;
end; $$ language plpgsql;

create trigger trg_invitations_paid
  before insert or update on invitations
  for each row execute function invitations_require_paid_booking();
```

Tambien bloquea por RLS: la `INSERT` exige `bookings.status='confirmed'` via una funcion
`SECURITY DEFINER` de solo lectura, para que un usuario no pueda leer bookings ajenos
usando la policy como oraculo.

### 4.7 `news_posts`

```sql
news_posts (
  id uuid pk, tenant_id uuid not null,
  title text not null, slug text not null, excerpt text, body text not null,
  cover_image_path text, author_id uuid,
  status text not null default 'draft',   -- 'draft'|'published'|'archived'
  published_at timestamptz,
  created_at, updated_at,
  unique (tenant_id, slug)
)
```

### 4.8 `gdpr`

```sql
data_export_requests (
  id uuid pk, tenant_id uuid not null, user_id uuid not null,
  status text not null default 'queued',  -- 'queued'|'processing'|'ready'|'expired'
  storage_path text, requested_at, completed_at, expires_at
)

-- Registro de auditoria de acciones sensibles. Append-only, sin delete.
audit_log (
  id bigserial pk, tenant_id uuid not null, actor_id uuid,
  action text not null, target_table text, target_id uuid,
  metadata jsonb, created_at timestamptz not null default now()
)
```

### 4.9 Preparacion para el futuro (esquema, NO implementado)

Marcado explicitamente como **fuera del MVP**. Solo se documenta aqui para que el
esquema no haya que re-diseñar cuando entren:

| Feature futura | Impacto en el esquema actual |
|---|---|
| Monedero prepago | `bookings` necesitara `paid_from_credit_cents` + tabla `wallets`, `wallet_transactions`. El `price_cents` snapshot ya lo permite. |
| Clases / clinicas | Tablas nuevas `class_templates`, `class_sessions` con el mismo patron `court_id + tstzrange`. Reutilizable el `EXCLUDE` con otro nombre de restriccion. |
| Torneos | `tournaments` + `tournament_bracket`; partido de torneo = `open_matches` con `tournament_id`. |
| POS | `pos_sales` + `pos_lines`; requiere integracion fiscal que hoy esta **excluida** por tu restriccion. |

Ninguna de estas tiene migracion en el MVP. Si alguma aparece en el codigo, es un fallo
de scope.

---

## 5. Endpoints

Todos bajo `/api`. Autenticacion por sesion Supabase (cookie). `tenant_id` **nunca** se
toma del cuerpo de la peticion: se resuelve en servidor desde el host y el JWT. Un
`tenant_id` enviado por el cliente se ignora (no es un parametro aceptado).

### 5.1 Disponibilidad y reservas

| Metodo | Ruta | Auth | Proposito |
|---|---|---|---|
| `GET` | `/api/courts` | publica | Pistas activas del club |
| `GET` | `/api/availability?court_id&date` | publica | Slots + precio de un dia. Filtra holds caducados |
| `GET` | `/api/availability/stream` | publica | Suscripcion Realtime a cambios de disponibilidad |
| `POST` | `/api/holds` | autenticado | Crea hold de 3 min. Devuelve 409 si hay conflicto |
| `DELETE` | `/api/holds/[id]` | autenticado | Libera el hold propio |
| `POST` | `/api/bookings` | autenticado | Confirma: hold -> pending_payment + PaymentIntent |
| `GET` | `/api/bookings/[id]` | duenho | Detalle de reserva propia |
| `GET` | `/api/bookings?scope=mine` | autenticado | Historial del socio |
| `POST` | `/api/bookings/[id]/cancel` | duenho | Cancela y dispara reembolso segun politica |

### 5.2 Pagos

| Metodo | Ruta | Auth | Proposito |
|---|---|---|---|
| `POST` | `/api/payments/intent` | autenticado | Crea/recupera PaymentIntent. **Precio calculado en servidor** |
| `POST` | `/api/stripe/webhook` | firma Stripe | `payment_intent.succeeded` -> `confirmed`; `failed` -> cancela; `account.updated` -> flags de Connect |
| `POST` | `/api/stripe/connect/onboard` | gestor | Crea la cuenta Express y devuelve el Account Link |
| `GET` | `/api/stripe/connect/return` | gestor | Callback de onboarding: `?setup=complete` |
| `POST` | `/api/bookings/[id]/refund` | duenho o gestor | Reembolso segun politica de `tenant_content` |

**Flujo de cobro con Connect (OQ-2 confirmado).**

1. El `PaymentIntent` se crea con `transfer_data.destination = tenants.stripe_account_id`
   y `application_fee_amount` si hay comision. **El importe va a la cuenta del club, no a
   la plataforma.** La app no custodia fondos en ningun momento, ni siquiera
   transitoriamente.
2. Si `tenants.stripe_charges_enabled = false`, el endpoint devuelve **503** con codigo
   `tenant_payments_not_ready` y la UI muestra al gestor que debe conectar los cobros. No
   se intenta crear el PaymentIntent: fallaria con un error de Stripe ilegible.
3. **El webhook es la unica fuente de verdad del pago.** El navegador no confirma
   reservas. Idempotencia por `event.id` guardado en `audit_log`.
4. `account.updated` mantiene `stripe_charges_enabled` / `stripe_payouts_enabled` al día.
   Si el club pierde la capacidad de cobro, el panel lo avisa en el dashboard antes de que
   un socio falle al pagar.

### 5.3 Partidos abiertos e invitaciones

| Metodo | Ruta | Auth | Proposito |
|---|---|---|---|
| `GET` | `/api/matches?from&to` | publica | Partidos abiertos con plazas libres |
| `POST` | `/api/matches` | autenticado | Crea partido **y** su `booking` en una transaccion |
| `POST` | `/api/matches/[id]/join` | autenticado | Se une si hay plaza y cumple nivel |
| `POST` | `/api/matches/[id]/leave` | autenticado | Libera plaza |
| `POST` | `/api/matches/[id]/invitations` | creador, post-pago | Envia invitaciones (dispara el trigger) |
| `GET` | `/invitations/[token]` | publica (token) | Acepta / rechaza |

### 5.4 Noticias

| Metodo | Ruta | Auth | Proposito |
|---|---|---|---|
| `GET` | `/api/news` | publica | Publicadas |
| `POST` | `/api/admin/news` | gestor | Crear |
| `PATCH` | `/api/admin/news/[id]` | gestor | Editar / publicar |

### 5.5 Panel de gestor (todas requieren flag activo)

| Metodo | Ruta | Auth | Feature flag |
|---|---|---|---|
| `GET` | `/api/admin/dashboard` | gestor | — |
| `POST/PATCH` | `/api/admin/courts` | gestor | `booking` |
| `POST` | `/api/admin/courts/[id]/blocks` | gestor | `booking` |
| `GET/POST` | `/api/admin/pricing-rules` | gestor | `booking` |
| `GET/PATCH` | `/api/admin/branding` | gestor | `tenancy` |
| `GET/PATCH` | `/api/admin/features` | gestor | `tenancy` |
| `GET/PATCH` | `/api/admin/content` | gestor | `tenancy` |
| `GET` | `/api/admin/bookings` | gestor | `booking` |

### 5.6 RGPD

| Metodo | Ruta | Auth | Proposito |
|---|---|---|---|
| `POST` | `/api/gdpr/export` | autenticado | Encola exportacion | `gdpr_export` |
| `GET` | `/api/gdpr/export/[id]` | duenho | Descarga JSON del export |
| `DELETE` | `/api/gdpr/account` | autenticado | **Borrado de datos accesible desde el panel** | `gdpr_export` |

El borrado se inicia **desde la cuenta del socio** y tambien **desde el panel del gestor**
(para socios que lo piden en persona). Ambos escriben en `audit_log` antes de borrar.

---

## 6. Pantallas

Todas mobile-first. Copy de `tenant_content`. Sin un solo literal de marca en el codigo.

### 6.1 Socio

| # | Ruta | Pantalla |
|---|---|---|
| 1 | `/` | Inicio: marca del club, proximos partidos, noticias, CTA reservar |
| 2 | `/pistas` | Lista de pistas con tipo, interior/exterior, precio base |
| 3 | `/pistas/[id]` | Disponibilidad del dia: rejilla de slots con precio y estado |
| 4 | `/reserva/confirmar` | **Pantalla critica** (ver 6.2) |
| 5 | `/reservas` | Mis reservas: proximas y pasadas, con cancelar |
| 6 | `/partidos` | Partidos abiertos con plazas y nivel |
| 7 | `/partidos/[id]` | Detalle, unirse, invitar |
| 8 | `/noticias`, `/noticias/[slug]` | Comunicados |
| 9 | `/cuenta` | Datos, privacidad, **borrar mis datos** |
| 10 | `/login` | Acceso magic-link / OTP |

### 6.2 `/reserva/confirmar` — restriccion tua, es un requisito duro

**El precio, la politica de cancelacion y el aviso de responsabilidad deben verse
completos en un unico bloque, sin scroll, en movil, ANTES del boton de pago. No
repartido en pasos.**

Diseno: una sola `card` de contenido, ancho completo, `position: sticky` para el pie con
el boton. El scroll de pagina esta **prohibido** en esta ruta
(`overflow: hidden` en el contenedor, scroll interno solo si el bloque no cabe entero).

Orden vertical fijo:
1. Pista, fecha, hora, duracion (90 min, dato no control), jugadores.
2. **Precio total con IVA incluido**, desglosado si la regla lo produce, con el nombre de
   la tarifa aplicada. **Sin desglose de IVA**: no lo hacemos falta porque la app no
   genera factura (OQ-6 + restriccion VERI\*FACTU).
3. **Politica de cancelacion** en lenguaje claro, leida de `tenant_content`: cuando se
   puede cancelar sin coste, cuando se pierde el importe. Sin jerga. Por defecto:
   gratis hasta 24h antes, 50% entre 24h y 12h, sin devolucion por debajo de 12h
   (OQ-5). El club puede cambiarlo.
4. **Aviso de responsabilidad**, solo si el jugador declarado es menor: campo de tutor ya
   cumplimentado y un check obligatorio "Soy la persona responsable y acepto". Si no es
   menor, el aviso no ocupa espacio.
5. Boton de pago. Texto con importe: "Pagar 24,00 EUR". Si el club no tiene los cobros
   conectados, el boton no aparece y en su lugar hay un aviso de que el club esta
   configurando los pagos (nunca un error de Stripe crudo).

**Criterio de aceptacion medible:** en viewport **375 x 667** (iPhone SE, el mas pequeno
que soportamos), los bloques 1-5 son **visibles completos sin scroll** cuando el nombre
del club tiene <= 24 caracteres y la politica de cancelacion tiene <= 200 caracteres.
Con textos mas largos, el bloque de texto hace scroll interno; el boton nunca queda
oculto. Se verifica con un test de layout, no a ojo.

### 6.3 Gestor — audiencia no tecnica (regla 5)

Copy en espanol colloquial. **Cero** jerga de base de datos en pantalla. Nada de UUID,
"registro", "endpoint", "configuracion de esquema", "forzar" o "debug".

| # | Ruta | Pantalla | Copy esperado |
|---|---|---|---|
| 11 | `/admin` | Panel: ingresos del mes, reservas de hoy, avisos | "Cuanto has facturado este mes" |
| 12 | `/admin/pistas` | Alta/edicion de pistas | "Anadir una pista" |
| 13 | `/admin/pistas/[id]/bloqueos` | Bloqueos de mantenimiento | "Marcar la pista como no disponible" |
| 14 | `/admin/precios` | Editor de tarifas, con vista previa del resultado | "Los sabados por la tarde cuestan mas" |
| 15 | `/admin/marca` | Colores y logo con **preview en vivo** | "El color de tu club" |
| 16 | `/admin/noticias` | Editor y publicar | "Avisar a los socios" |
| 17 | `/admin/reservas` | Listado y detalle, con filtro por fecha | "Todas las reservas" |
| 18 | `/admin/socios/[id]` | Ficha del socio, con **borrar sus datos** | "Borrar los datos de este socio" |
| 19 | `/admin/ajustes` | Funciones activadas/desactivadas, una frase de que hace cada una | "Cobrar con tarjeta" |
| 20 | `/admin/pagos` | **Conectar cobros** (onboarding de Stripe Connect) + estado | "Conectar los cobros de mi club" |

**`/admin/pagos` es bloqueante del MVP, no una mejora futura.** Sin conectar la cuenta
Express el club no cobra. Copy: si `charges_enabled = false`, el boton es
"Conectar los cobros de mi club" y al pulsarlo se abre el onboarding de Stripe y se
vuelve a esta pagina con el estado ya actualizado. Si `true`, muestra "Los cobros estan
conectados" y un resumen de las ultimas reservas pagadas.

**La pantalla 6.2 no ofrece selector de duracion** (OQ-4 confirmado): 90 min fijos en el
MVP, el bloque muestra la duracion como dato, no como control.

**Regla de oro del panel:** cada toggle de `19` dice en una frase que pasa si se apaga.
Apagar `payments` con reservas de pago vivo se **bloquea** con explicacion, no se permite
dejar la app en un estado inconsistente.

---

## 7. Criterios de aceptacion

### 7.1 Tenancy y RLS

- [ ] Toda tabla de negocio tiene `tenant_id NOT NULL` y RLS con `FORCE ROW LEVEL SECURITY`.
- [ ] Cada operacion (select/insert/update/delete) tiene politica. Un `EXPLAIN` con un
      JWT de tenant A no devuelve ninguna fila de tenant B, en ninguna tabla.
- [ ] `tenant_features` tiene una fila por feature del MVP en la seed.
- [ ] Desactivar `payments` oculta el boton de pago **y** devuelve 403 en
      `/api/payments/intent`.
- [ ] Ninguna cadena de literal de marca (nombre, color, telefono, direccion) aparece en
      `packages/ui` ni en componentes. Test automatico que falla si aparece un hex o un
      nombre de club en codigo.
- [ ] Un `tenant_id` enviado en el cuerpo o en la query de cualquier endpoint se ignora.

### 7.2 Catalogo y disponibilidad

- [ ] `GET /api/availability` devuelve slots de 90 min no solapados, con precio resuelto.
- [ ] Un `court_block` en una franja oculta esos slots para todo el dia.
- [ ] Dos pestanas abiertas viendo la misma pista reciben el cambio por Realtime en < 2 s.
- [ ] Un hold caducado no aparece como ocupado ni bloquea un nuevo hold.

### 7.3 Precio dinamico

- [ ] La resolucion es **determinista y pura**: mismos datos de entrada -> mismo precio.
      Funcion pura en `packages/core`, sin acceso a red ni a `Date.now()`.
- [ ] Precedencia documentada y verificada en test:
      `court` > `court_type` > `global`; dentro del mismo scope, mayor `priority` gana;
      empate -> la de `valid_from` mas reciente.
- [ ] Sin regla aplicable cae a `courts.base_price_cents`. Nunca devuelve `NULL`.
- [ ] Todos los precios en la UI vienen del servidor. El cliente **no** puede enviar precio.
- [ ] Casos de test: solape de reglas, regla fuera de `valid_from/to`, franja que cruza
      medianoche, `player_multiplier` con 3 jugadores, dos reglas de igual prioridad.

### 7.4 Reservas y solapes — TDD obligatorio

- [ ] **Test que intenta solapar dos reservas en la misma pista y recibe 409.** Este test
      falla si se borra el `EXCLUDE`. Es la proteccion principal.
- [ ] `POST /api/holds` crea hold de 3 min exactos. A los 3 min + 1 s, el slot vuelve a
      estar libre y `GET /api/availability` no lo muestra ocupado.
- [ ] Un hold caducado se limpia al intentar reservar (limpieza perezosa) sin esperar al
      cron. Test que fuerza `hold_expires_at` al pasado y comprueba que el siguiente
      `POST` tiene exito.
- [ ] Dos `POST /api/holds` concurrentes sobre el mismo slot: **exactamente uno** gana.
- [ ] Un booking no puede solaparse con si mismo (misma pista, solape de horas).
- [ ] Un `court_block` sobre una reserva existente no la destruye: aparece aviso al gestor.
- [ ] Estados validos: solo `held -> pending_payment -> confirmed | cancelled | expired`.
      Transiciones invalidas devuelven 409.
- [ ] `price_cents` es inmutable una vez creado el booking. Un cambio de `pricing_rules`
      posterior **no** altera reservas existentes. Test explicito.

### 7.5 Menores y RGPD

- [ ] **El umbral de edad sale de `tenants.min_player_age` (18 por defecto) y se compara
      en servidor.** Un cliente que envie `is_minor = false` con una fecha de nacimiento
      que indique menor: el servidor lo corrige a `true` y exige tutor. Test explicito de
      este caso, porque es el que se puede saltar desde el cliente.
- [ ] Si `is_minor = true`, `guardian_name`, `guardian_email`, `guardian_phone` y
      `guardian_consent_at` son obligatorios. `check` en BD, no solo validacion de UI.
- [ ] El valor de fabrica `min_player_age` es **18** y el `check` impide bajar de 14. Nunca
      0 ni null. Un tenant nuevo nace con 18 sin que nadie lo configure.
- [ ] El aviso de responsabilidad aparece en `/reserva/confirmar` antes del boton de pago
      si y solo si el jugador es menor.
- [ ] El esquema **no** tiene ninguna columna de salud, medicacion, lesion ni notas
      medicas. Test que falla si aparece una columna asi.
- [ ] `DELETE /api/gdpr/account` borra o anonimiza datos del socio y es accesible **desde
      el panel de gestor**, no solo desde su cuenta.
- [ ] Toda accion sensible queda en `audit_log` antes de ejecutarse.
- [ ] `data_export_requests` produce un export que contiene las reservas del socio.
- [ ] El email de confirmacion sale por **Resend** (OQ-11) con remitente de
      `tenant_branding.email_from_name` y `Reply-To` de `tenant_branding.email_reply_to`.
      **Dominio tecnico unico y compartido** entre todos los tenants (OQ-12). El club no
      configura DNS, SPF, DKIM ni SMTP. Test: el `From` tecnico de un email de un tenant
      **nunca** es el dominio de otro, y la unica variable por tenant en la cabecera es
      `email_from_name`.

### 7.6 Pagos — Stripe Connect

- [ ] El importe del `PaymentIntent` lo calcula el servidor desde el motor de precios. Un
      importe enviado por el cliente se descarta.
- [ ] **El `PaymentIntent` se crea con `transfer_data.destination` apuntando a la cuenta
      Express DEL CLUB.** El importe no pasa por la plataforma. Test que comprueba que el
      `transfer_data.destination` coincide con `tenants.stripe_account_id`.
- [ ] **`application_fee_cents` es 0 y el `PaymentIntent` NO lleva `application_fee_amount`
      mientras el valor sea 0** (OQ-13). El club no paga comision por transaccion, y eso es
      el argumento de venta. Test explicito: si alguien anade una comision sin tocar la
      spec, el test falla.
- [ ] Si `stripe_charges_enabled = false`: el boton de pago no aparece, y
      `POST /api/payments/intent` devuelve **503 `tenant_payments_not_ready`**, no un
      error crudo de Stripe. La app no intenta crear el PaymentIntent.
- [ ] El onboarding de Connect funciona de punta a punta: el gestor entra en
      `/admin/pagos`, conecta, vuelve con `?setup=complete`, y el panel refleja el estado
      conectado. Sin este camino el club **no cobra** y el MVP no esta completo.
- [ ] `account.updated` actualiza `stripe_charges_enabled` / `stripe_payouts_enabled`.
- [ ] `POST /api/stripe/webhook` rechaza peticiones sin firma valida (401).
- [ ] `payment_intent.succeeded` deja el booking en `confirmed` y `payment_status='paid'`.
- [ ] Reprocesar el mismo `event.id` no duplica efectos (idempotencia).
- [ ] `payment_intent.payment_failed` deja el booking en `cancelled` y libera el slot.
- [ ] El refund se calcula leyendo los tramos de `tenant_content['cancellation_policy']`,
      **nunca con un importe fijo en codigo**. Test de tabla de casos:
      25h -> 100%, 24h exactas -> 100%, 20h -> 50%, 12h exactas -> 50%, 5h -> 0%.
- [ ] El reembolso se **audita**: guarda `refund_tier_hours_before` y
      `refund_percent_applied` en el booking, para poder responder "me devolvieron el 50%
      por la regla de las 12h" aunque el club ya haya cambiado la politica.
- [ ] `amount_refunded_cents` nunca supera `price_cents` (garantizado por `check`).
- [ ] **Ninguna ruta, endpoint, tabla ni texto de la app genera factura, recibo fiscal,
      NIF del club ni desglose de IVA con efectos fiscales.** Test que falla si el termino
      "factura" aparece en copy de pago.

### 7.7 Partidos abiertos e invitaciones

- [ ] Crear un partido abierto inserta tambien su `booking`, o falla entero.
- [ ] No se puede unirse si no hay plazas o si el nivel no cumple el rango.
- [ ] El contador de plazas es correcto con dos uniones concurrentes sobre la ultima plaza.
- [ ] **`POST /api/matches/[id]/invitations` devuelve 4xx si el booking no esta
      `confirmed` y `paid`.** Test que intenta invitar con el booking en `held`.
- [ ] Una reserva de partido abierto **no** genera invitaciones por la via de las reservas
      normales; van por su propia ruta.
- [ ] El token de invitacion es opaco, aleatorio, >= 32 chars, y expira.

### 7.8 PWA y mobile

- [ ] La app es instalable y arranca **standalone** sin conexion mostrando la ultima
      pantalla cacheada.
- [ ] Funciona en iOS Safari y Chrome Androidmoviles actuales.
- [ ] `/reserva/confirmar` cumple el criterio de la seccion 6.2.
- [ ] Captcha de pago: la redireccion 3D Secure **funciona en modo standalone**. Este es
      el riesgo real de pagos en PWA y hay que probarlo explicitamente, no asumirlo.
- [ ] Sin scroll horizontal en 320px de ancho.

### 7.9 Gestor

- [ ] Todas las pantallas de `6.3` se pueden completar sin documentacion.
- [ ] El editor de precios muestra la **vista previa** del resultado de cada regla antes de
      guardar.
- [ ] El panel de marca aplica color y logo en **vivo**, sobre la propia app.
- [ ] Apagar una feature con dependencias activas se bloquea con explicacion en lenguaje
      claro.

---

## 8. comandos

```bash
#Instalacion
pnpm install

# Desarrollo
pnpm dev                        # turbo dev, todas las apps
pnpm dev --filter padel-template

# Build
pnpm build
pnpm build --filter padel-template

# Calidad
pnpm lint
pnpm typecheck
pnpm format

# Tests
pnpm test                       # unit + integration
pnpm test:watch
pnpm test:coverage
pnpm test:e2e                   # Playwright, incluye el test de layout 6.2

# Base de datos
pnpm db:reset                   # supabase db reset, aplica migraciones + seeds
pnpm db:migrate -- --name <nombre>
pnpm db:types                   # regenera tipos desde el esquema

# PWA
pnpm build:pwa                  # build con manifest + service worker Serwist
```

---

## 9. Estructura de proyecto

```
FrasApp/
  packages/
    ui/                  # Componentes presentacionales, SIN marca, SIN logica
    core/                # Dominio: motor de precios, maquina de estados, calculos
    config-schema/       # Contrato Zod de tenant: branding, features, content
  apps/
    padel-template/      # Next.js App Router, la plantilla vendible
      src/
        app/             # rutas (App Router)
        components/      # UI de la app, usa el contrato de config-schema
        lib/             # clientes Supabase, Stripe, server actions
        server/          # logica de negocio que corre en servidor
      supabase/
        migrations/      # SQL: esquema, RLS, triggers, cron
        seed.sql         # tenant de demo, pistas, tarifas, noticias
      e2e/               # Playwright
      public/            # iconos, manifest
  clients/               # uno por cliente real. Vacio en el MVP
  docs/                  # ADRs, decision records
    specs/               # este documento
    adr/                 # un fichero por decision de arquitectura
  tests/                 # cross-package
  task_plan.md
  findings.md
  progress.md
```

**Regla de capas:** `ui` no sabe nada de padel ni de Supabase. `core` no sabe nada de
Next.js ni de React. `padel-template` orquesta. Un test de `core` corre sin browser y sin
red. Si alguna vez `ui` importa de `@supabase/*`, es un fallo de arquitectura.

**Variables de entorno.** Los secretos viven en `.env.local` (nunca commiteado) y las
plantillas en `.env.example`. Ningun secreto en el repo, en ningun caso.

```
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY          # solo servidor. Nunca en el cliente
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
STRIPE_PLATFORM_FEE_PERCENT        # 0 al lanzamiento (OQ-13)
RESEND_API_KEY
EMAIL_FROM_DOMAIN                  # dominio unico nuestro, compartido (OQ-12)
NEXT_PUBLIC_APP_URL
```

---

## 10. Estilo de codigo

TypeScript estricto. `strict: true`, `noUncheckedIndexedAccess: true`. Sin `any`. Sin
`as` sin justificacion escrita.

```ts
// packages/core/pricing/resolve-price.ts
// Funcion PURA: sin Date.now(), sin fetch, sin Supabase. Testeable sin nada mas.
export type PricingInput = {
  readonly court: Pick<Court, 'id' | 'courtType' | 'basePriceCents'>;
  readonly rules: readonly PricingRule[];
  readonly startsAt: LocalDateTime;
  readonly durationMin: number;
  readonly numPlayers: number;
};

export type PriceQuote = {
  readonly totalCents: number;
  readonly ruleId: string | null;
  readonly ruleName: string | null;
  readonly breakdown: readonly PriceLine[];
};

export function resolvePrice(input: PricingInput): PriceQuote {
  const candidates = input.rules
    .filter((rule) => appliesTo(rule, input))
    .sort(bySpecificityThenPriority);

  const winner = candidates[0];
  if (!winner) {
    return {
      totalCents: input.court.basePriceCents,
      ruleId: null,
      ruleName: null,
      breakdown: [{ label: 'Tarifa base', cents: input.court.basePriceCents }],
    };
  }

  const unitCents = winner.playerMultiplier
    ? winner.priceCents * input.numPlayers
    : winner.priceCents;

  return {
    totalCents: unitCents,
    ruleId: winner.id,
    ruleName: winner.name,
    breakdown: [
      { label: winner.name, cents: unitCents },
      ...(winner.playerMultiplier
        ? [{ label: `${input.numPlayers} jugadores`, cents: 0 }]
        : []),
    ],
  };
}
```

**Convenciones:** imports agrupados y ordenados. Nombres en camelCase, componentes en
PascalCase, tablas en `snake_case` en SQL y `camelCase` en TS. Funciones exportadas
explicitas, sin exports por defecto en logica. Comentarios solo para el **por que**, nunca
para el que. Sin emojis ni iconos hardcodeados: todo icono viene de la libreria del
design system.

---

## 11. Estrategia de testing

| Preocupacion | Nivel | Herramienta |
|---|---|---|
| Motor de precios | Unit | Vitest, tabla de casos |
| Maquina de estados de reserva | Unit | Vitest, tabla de transiciones |
| RLS / aislamiento por tenant | Integracion | Vitest + Postgres real, **no mock** |
| `EXCLUDE` y solapes | Integracion | Vitest + Postgres real. Mocks no sirven aqui |
| Trigger de invitaciones | Integracion | Vitest + Postgres real |
| Pagar / webhook | Unit del handler + E2E | Vitest + Playwright con Stripe CLI |
| Layout de confirmacion | E2E | Playwright, viewport 375x667 |
| PWA standalone + 3DS | E2E manual guiado | Playwright + disposable real |

**Cobertura:** 100% en `packages/core` (es logica pura y barata de cubrir). >= 90% en las
capas de servidor. La cobertura no se mide en componentes visuales.

**Regla dura:** todo lo que toque `tenant_id`, RLS, precios o reservas se escribe
**test-first**. La suite corre contra un Postgres real, nunca SQLite ni mocks: una RLS
probada contra un motor que no es Postgres no prueba nada.

---

## 12. Limites

**Siempre:**
- Tests en verde antes de cualquier commit.
- Un commit por tarea cerrada. Nunca dos tareas en un commit.
- `tenant_id` + RLS en cualquier tabla nueva.
- Flag en `tenant_features` para cualquier feature nueva.
- Dinero en centimos `integer`.
- Revisar `task_plan.md` antes de una decision de arquitectura.

**Preguntar antes:**
- Cualquier cambio de esquema o migracion.
- Anadir dependencias.
- Cambiar la politica de precios o de cancelacion.
- Cualquier cosa que afecte a mas de un tenant.
- Habilitar Capacitor o publicar en una tienda.
- Cambiar la cuenta de desarrollador de las builds nativas.

**Nunca:**
- Hardcodear color, logo o nombre del club.
- Dejar una tabla sin RLS "para mas adelante".
- Generar facturas o datos fiscales desde la app.
- Marcar una reserva como pagada desde el cliente.
- Invitar a alguien antes del pago confirmado.
- Instalar con `npm i -g` ni meter secretos en el repo.
- Tocar `apps/[vertical]-template` para arreglar un `clients/*`.

---

## 13. Fuera de alcance del MVP

Monedero prepago · clases y clinicas · torneos · POS y venta en mostrador · tickets o
facturas fiscales (VERI\*FACTU) · multi-idioma · app nativa Capacitor · build en tiendas ·
notificaciones push a mas de un dispositivo · widgets de disponibilidad publicly
embebibles · integracion con sistemas de reservas de terceros.

Ninguna de estas tiene migracion. Si aparece en el codigo, es desviacion de alcance.

---

## 14. Criterios de exito del MVP

1. Un socio nuevo, sin instalar nada, entra por un enlace, reserva una pista, paga y
   recibe confirmacion, en menos de 2 minutos, desde un iPhone de gama media.
2. Dos socios que intenten la misma pista a la vez: uno reserva, el otro recibe un mensaje
   claro con horarios alternativos. **Nunca** una doble reserva.
3. El gestor cambia el precio de las pistas de un viernes por la tarde, ve la vista previa,
   guarda, y el siguiente socio ve el precio nuevo. Sin tocar codigo, sin redesplegar.
4. El gestor cambia el color y el logo, y la app los refleja de inmediato.
5. Un test que intenta solapar dos reservas falla si se elimina la restriccion `EXCLUDE`.
6. Un JWT de un tenant no lee ni escribe nada de otro tenant. Verificado tabla por tabla.
7. El borrado de datos de un socio se completa **desde el panel del gestor**, con entrada
   en auditoria, y el socio deja de tener datos personales recuperables.
8. La app es instalable, arranca sin conexion, y el pago con 3D Secure funciona en modo
   standalone.
9. **El dinero del alquiler de pista llega a la cuenta bancaria del club, no a la
   plataforma.** Verificable en el panel de Stripe Connect: cada cargo tiene su
   transferencia al club. La plataforma no custodia fondos en ningun momento.
10. **Un club nuevo puede cobrar desde cero sin intervencion tecnica**: entra en
    `/admin/pagos`, conecta sus cobros, y el mismo dia un socio puede reservar y pagar.
11. Si un socio cancela con 20h de antelacion, se le devuelve exactamente el 50%, leyendo
    la politica del club. Si cancela con 5h, no se devuelve nada. Y el club puede cambiar
    esa politica sin que cambien las reservas yamade.
12. Un socio con 15 anos no puede completar una reserva sin datos de tutor, aunque manipule
    la peticion desde el navegador.
13. **El club paga exactamente el precio de la pista.** Cero comision por transaccion. El
    argumento de venta "sin comision, como reservadeportes.com" es literalmente cierto en
    el dashboard de Stripe del club.
14. Un club nunca tiene que configurar un servidor de correo: el socio recibe el email con
    el nombre del club como remitente, y el club no ha tocado DNS.

---

## 14.1 Lo que este MVP NO demuestra

Con la decision OQ-2 el MVP **no** cubre la conciliacion contable del club. No hay
informes fiscales, ni de donde sale el dinero mas alla del Stripe, ni liquidacion a
terceros. Eso es un producto aparte (y llega con VERI\*FACTU, con fechas por confirmar con
asesor). La app no pretende ser el sistema de contabilidad de un club.

---

## 15. Decisiones cerradas — TODAS RESUELTAS

**Las 10 preguntas abiertas estan respondidas (2026-09-26). No queda ninguna bloqueante.**

| id | Decision | Consecuencia en la spec |
|---|---|---|
| **OQ-1** | Documento 4 recuperado. Mi esquema **sustituye** al suyo en hold, trigger de invitaciones y partido abierto. `court_blocks` y `audit_log` aprobados. | Seccion 0 y 4 reescritas. Seccion 4 pasa de PROVISIONAL a APROBADO |
| **OQ-2** | **Stripe Connect con cuentas Express.** El dinero va directo a la cuenta del club; la app no custodia fondos. La cuota de mantenimiento va aparte por Stripe Billing (Documento 2), fuera del MVP. | `tenants` gana 4 columnas de Connect. Nuevo `/admin/pagos` con onboarding. `transfer_data.destination` obligatorio. Feature gate `charges_enabled` |
| **OQ-3** | **Una reserva por pista**, no por jugador. El reparto entre los 4 es del club | `bookings.open_match_id`. Confirmada la creacion del booking propio |
| **OQ-4** | **90 min fijos.** Sin selector de duracion en el MVP | `pricing_rules.duration_min` se queda con default 90 y no se usa como selector |
| **OQ-5** | **Por tramos en `tenant_content`.** Defecto sugerido: gratis hasta 24h, 50% entre 24-12h, sin devolucion por debajo de 12h (patron similar a ClassPass) | Estructura `cancellation_policy` con `tiers`. Motor de reembolso puro y testeado |
| **OQ-6** | **Precio con IVA incluido.** No es preferencia: en Espana el precio al consumidor es el final. Sin desglose de IVA en la UI porque no hay factura fiscal | `price_cents` se interpreta con IVA incluido. Test de que no aparece desglose |
| **OQ-7** | **Un unico rol `gestor`** por tenant. Niveles de permiso = fase 2 | Sin tabla de roles en el MVP. Un rol, un permiso |
| **OQ-8** | **18 por defecto, configurable por tenant**, con valor de fabrica seguro. Nunca 0 ni null | `tenants.min_player_age` con `check` entre 14..21. El calculo de `is_minor` es de servidor |
| **OQ-9** | **Decision de producto, no mandato legal.** Va en `tenant_content`, configurable | `notice_text` en `cancellation_policy` |
| **OQ-10** | **Email si, con proveedor compartido** (Resend). No SMTP por tenant: es friccion que un dueno de club no sabria configurar. Remitente ajustado por tenant via `tenant_branding` | `tenant_branding.email_from_name` / `email_reply_to`. Una cuenta, un dominio |
| **OQ-11** | **Resend.** Encaja mejor con Next.js/Supabase: SDK mas simple y buena integracion con React Email si algun dia hacen falta plantillas con componentes. El plan gratuito cubre de sobra el volumen de un MVP con pocos clientes | Secciones 9 y 16 fijan Resend. Sin Postmark |
| **OQ-12** | **Un solo dominio de envio, mio, compartido entre todos los tenants** (ej. `notificaciones@tunegocio.com`). **No un dominio por cliente.** Configurar SPF/DKIM es algo que un dueno de club no puede hacer por si mismo, y pedírselo es exactamente la friccion operativa que ya se descarto en el Documento 2 (onboarding humano, no autoservicio). **El nombre del remitente si cambia por tenant via `tenant_branding`; el dominio tecnico no** | Dominio unico en config. `email_from_name` por tenant. `email_reply_to` puede ser el correo real del club |
| **OQ-13** | **`application_fee_cents = 0` al lanzamiento.** No es solo simplicidad, es **coherencia de negocio**: el argumento de venta frente a Playtomic es "sin comision, como reservadeportes.com", y cobrar por transaccion contradice el propio argumento con el que se vende. El ingreso esta en el setup fee + la cuota mensual, no en tocar cada cobro de pista. **La columna se queda en el esquema** por si en el futuro se pacta un modelo distinto con un cliente concreto | Default 0. Test que verifica que el PaymentIntent no lleva `application_fee_amount` mientras el valor sea 0 |

### 15.1 Lo que queda abierto

**Ninguna bloquea `/plan`.**

| id | Cuestion | Estado |
|---|---|---|
| OQ-14 | Cuotas de mantenimiento (setup fee + cuota mensual) | **Ya resuelto** en el Documento 2. Producto distinto, fuera del MVP. No requiere nada nuevo |
| OQ-15 | Fechas definitivas de VERI\*FACTU (refs: 1/1/2027 y 1/7/2027) | **Correctamente abierta a proposito.** Consultar con asesor fiscal cuando se construya el modulo de facturacion, que esta fuera del MVP. No antes |

---

## 16. Infraestructura de email — Resend, dominio unico

**Decisiones OQ-11 y OQ-12 aplicadas.**

| Aspecto | Decision |
|---|---|
| Proveedor | **Resend** |
| Cuentas | **Una sola**, compartida por todos los tenants |
| Dominio tecnico | **Uno solo, nuestro**, compartido (ej. `notificaciones@tunegocio.com`) |
| Nombre del remitente | **Por tenant**, desde `tenant_branding.email_from_name` |
| Responder a | **Por tenant**, desde `tenant_branding.email_reply_to` (el correo real del club) |
| SMTP por tenant | **Nunca.** No se pide a nadie que configure un servidor de correo |
| Plantillas | React Email. En el MVP, plantillas de texto simple con HTML minimo |
**Lo que ve el socio:** un email cuyo remitente es "Club Padel Norte" y cuyo `Reply-To` es
`info@clubpadelnorte.es`. Tecnicamente sale de nuestro dominio. El club no tiene que
configurar nada, ni DNS, ni SPF, ni DKIM.

**Lo que NO se implementa:** plantillas por tenant, editor visual de emails, envios
programados, reintentos con backoff propio, metricas de entrega mas alla de las que da
Resend. Todo eso es fase 2.

**Test de aislamiento:** el `From` de un email de un tenant **nunca** aparece como remitente
tecnico de otro. La unica variable por tenant en la cabecera es `email_from_name`.

---

*Spec cerrada tecnicamente. Aprobada por el usuario el 2026-09-26. Las 13 decisiones de
producto estan tomadas; solo queda OQ-15, que es una advertencia deliberada sobre
VERI\*FACTU y no bloquea nada.*

*Siguiente paso: `/plan`.*
