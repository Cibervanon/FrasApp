-- T14 E1: coherencia de pagos en `bookings` (spec t14-payment-intent.md, seccion
-- "Modelo de datos"). Ninguna columna nueva: T9 dejo todas las de Stripe Connect.
-- Esta migracion anade las reglas que el flujo de cobro necesita y que nadie
-- garantizaba. Sin ellas, el webhook de T14 podria confirmar una reserva sin intent,
-- o un bug podria dejar un pending_payment sin poder confirmarse jamas.

-- Un PaymentIntent es de UNA reserva. El indice es parcial (solo filas con intent) y
-- escala por tenant, igual que la FK compuesta `bookings_tenant_court_fkey` de T9:
-- el mismo intent id en dos tenants no choca porque son dos instancias aisladas.
create unique index bookings_stripe_payment_intent_uidx
  on public.bookings (tenant_id, stripe_payment_intent_id)
  where stripe_payment_intent_id is not null;

-- pending_payment sin PaymentIntent es un cobro que no se puede confirmar nunca: el
-- webhook enlaza por `stripe_payment_intent_id`, y sin el no sabe ni que reserva es.
alter table public.bookings
  add constraint bookings_pending_payment_needs_intent
    check (status <> 'pending_payment' or stripe_payment_intent_id is not null);

-- pending_payment es un cobro EN CURSO: nadie entra en pending_payment ya pagado.
-- El pago solo lo confirma el webhook, y el webhook solo sabe de un intent vivo.
-- `is not distinct from 'unpaid'` y no `= 'unpaid'`: con `=` un payment_status NULL
-- (o un 'paid' que llego antes de tiempo) dejaria el check en NULL y Postgres deja
-- pasar un CHECK NULL. El agujero lo cazo el test rojo de esta misma migracion.
alter table public.bookings
  add constraint bookings_pending_payment_unpaid
    check (status <> 'pending_payment'
           or payment_status is not distinct from 'unpaid');

-- Solo el webhook confirma, y confirma pagando. `bookings_confirmed_is_paid` es la
-- garantia de que un `confirmed` sin `paid` no puede existir en la base, ni por un
-- bug ni por un insert directo. Compatible con T15, que inserta partidos abiertos
-- directamente `confirmed` + `paid` de una pieza. Mismo `is not distinct from`:
-- un `confirmed` con payment_status NULL es exactamente el estado que hay que cazar.
alter table public.bookings
  add constraint bookings_confirmed_is_paid
    check (status <> 'confirmed'
           or payment_status is not distinct from 'paid');

comment on constraint bookings_pending_payment_needs_intent on public.bookings is
  'T14: un booking en pending_payment tiene que tener su PaymentIntent. El webhook enlaza por stripe_payment_intent_id.';
comment on constraint bookings_pending_payment_unpaid on public.bookings is
  'T14: pending_payment es un cobro en curso; entrar ya pagado solo podria romper la idempotencia del webhook.';
comment on constraint bookings_confirmed_is_paid on public.bookings is
  'T14: solo el webhook confirma, y confirma cuando payment_intent.succeeded llega. T15 inserta confirmed+paid de una pieza.';