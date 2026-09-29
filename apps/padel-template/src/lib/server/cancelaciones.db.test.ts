import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { prepareDatabase, releaseDatabaseLease, withAdmin } from "../../test/db-harness.js";
import { cancelarReserva, reembolsarCancelada } from "./cancelaciones";
import { closePool } from "./db";
import type { StripeConnectClient } from "./stripe-connect";

/**
 * T14b E1: la logica de cancelacion con reembolso contra Postgres REAL (spec
 * t14b-cancel-refund.md).
 *
 * Igual que `stripe-connect.db.test.ts`: Stripe NO se llama nunca, se inyecta un
 * cliente falso con el contrato de `StripeConnectClient`. Lo que este fichero prueba
 * es TODO LO QUE TOCA LA BASE:
 *
 *   - `cancelarReserva`: RLS de `bookings` (tercero/no gestor no ve la reserva),
 *     titularidad en codigo, la politica de `tenant_content` en snake_case (o el
 *     fallback a `TRAMOS_POR_DEFECTO` si no hay fila), el motor de `computeRefund`,
 *     el snapshot (tramo + porcentaje) escrito en la cancelacion, la liberacion del
 *     slot (la fila deja de ocupar el `EXCLUDE`), y que el reembolso de Stripe va
 *     DESPUES de commitear la cancelacion: si Stripe falla, la reserva queda
 *     `cancelled` + `paid` + snapshot + 0, y `reembolsarCancelada` reintenta SOLO con
 *     el snapshot, aunque el club haya cambiado la politica entre medias.
 *
 *   - `reembolsarCancelada`: reintento del gestor sobre una cancelada sin reembolsar,
 *     guardas de estado (confirmada/pending/ya reembolsada/no pagada -> 409) y el
 *     caso "0 o sin tramo -> no hay nada que reembolsar".
 *
 * Los tramos exactos de la tabla de casos que dependen de "24h EXACTAS" no se pueden
 * representar con timestamps: entre el INSERT (que usa `now()` de Postgres) y la
 * cancelacion pasa siempre algo de tiempo, y las milisegundos empujan el `hoursBefore`
 * real a 23.9999... Por eso aqui los limites se prueban "justo por encima"
 * (`24h 5min`, `12h 30min`), que es lo que separa un `>=` de un `>` en el motor, y
 * la igualdad EXACTA la prueba `computeRefund` en el test puro de core. La tabla de
 * casos de E1 con los 5 tramos sale de la spec (25h/24h/20h/12h/5h).
 */

const TENANT = "00000000-0000-4000-8000-0000000006c0";
const SLUG = "club-t14b-a";
/** Tenant SIN fila de `cancellation_policy`: debe usar `TRAMOS_POR_DEFECTO`. */
const TENANT_SIN_POLITICA = "00000000-0000-4000-8000-0000000006c6";
const SLUG_SIN_POLITICA = "club-t14b-b";

const DUENO = "00000000-0000-4000-8000-0000000006c1";
const GESTOR = "00000000-0000-4000-8000-0000000006c2";
const TERCERO = "00000000-0000-4000-8000-0000000006c3";
const DUENO_LIBRE = "00000000-0000-4000-8000-0000000006c8";

const PRECIO = 2400;

/** Los mismos 3 tramos del seed (`TRAMOS_POR_DEFECTO`), en el snake_case de la base. */
function politicaPorDefecto() {
  return {
    tiers: [
      { hours_before: 24, refund_percent: 100, label: "Cancelacion gratuita hasta 24h antes" },
      { hours_before: 12, refund_percent: 50, label: "Entre 24h y 12h antes se devuelve el 50%" },
      { hours_before: 0, refund_percent: 0, label: "Con menos de 12h no hay devolucion" },
    ],
    policy_text: "Politica de cancelacion de T14b",
    notice_text: "Aviso legal de T14b",
  };
}

/** Una politica de un solo tramo al 0%: para demostrar que el reintento usa el snapshot. */
function politicaCero() {
  return {
    tiers: [{ hours_before: 0, refund_percent: 0, label: "No hay devolucion" }],
    policy_text: "Politica de cancelacion de T14b (0%)",
    notice_text: "Aviso legal de T14b (0%)",
  };
}

/** `starts_at` dentro de `horas` horas respecto a ahora. */
function dentroDe(horas: number): string {
  return new Date(Date.now() + horas * 3_600_000).toISOString();
}

/**
 * Nombre de la pista propia de un booking, para leerlo en un fallo de la base.
 * Del ULTIMO tramo del id: los de este fichero comparten prefijo, y el nombre es
 * unico por club (`courts_tenant_name_active_uniq`).
 */
function nombreDePista(bookingId: string): string {
  return `Pista ${bookingId.slice(-8)}`;
}

/**
 * Una reserva en el estado pasada directamente, sin pasar por la app.
 *
 * Cada booking se siembra en SU PROPIA pista (el id del booking como id de pista,
 * con `on conflict`): el `EXCLUDE bookings_no_overlap` es por pista, y varias reservas
 * `confirmed` sembradas con la misma ventana (los cinco casos de la tabla de casos
 * se siembran a 25h/24h/20h/12h/5h, y las que no llegan a cancelarse quedan vivas
 * entre tests) se pisarian con un unico id de pista compartido. Una pista por
 * booking hace que los tests sean independientes del orden.
 */
function sembrarReserva(fila: {
  id: string;
  tenantId: string;
  userId: string;
  status: "held" | "pending_payment" | "confirmed" | "cancelled";
  paymentStatus: "unpaid" | "paid" | null;
  intent: string | null;
  inicio: string;
  precio?: number;
}): Promise<void> {
  return withAdmin(async (db) => {
    const fin = new Date(new Date(fila.inicio).getTime() + 90 * 60_000);
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
       values ($1, $2, $3, 'cristal', 1200)
       on conflict (id) do nothing`,
      [fila.id, fila.tenantId, nombreDePista(fila.id)],
    );
    await db.query(
      `insert into public.bookings
         (id, tenant_id, court_id, user_id,
          starts_at, ends_at, status, price_cents, currency, price_breakdown,
          num_players, player_name, stripe_payment_intent_id, payment_status)
       values
         ($1, $2, $3, $4, $5, $6, $7, $8, 'eur',
          '{"regla":"base","total_cents":2400}', 4, 'Socio de T14b',
          $9, $10)`,
      [
        fila.id,
        fila.tenantId,
        fila.id,
        fila.userId,
        fila.inicio,
        fin.toISOString(),
        fila.status,
        fila.precio ?? PRECIO,
        fila.intent,
        fila.paymentStatus,
      ],
    );
  });
}

/** Una reserva ya CANCELADA con su snapshot, como la deja `cancelarReserva`. */
function sembrarCancelada(fila: {
  id: string;
  userId: string;
  intent: string;
  percent: number | null;
  tier: number | null;
  amount: number;
  price?: number;
}): Promise<void> {
  return withAdmin(async (db) => {
    const inicio = new Date(Date.now() + 30 * 3_600_000);
    const fin = new Date(inicio.getTime() + 90 * 60_000);
    await db.query(
      `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
       values ($1, $2, $3, 'cristal', 1200)
       on conflict (id) do nothing`,
      [fila.id, TENANT, nombreDePista(fila.id)],
    );
    await db.query(
      `insert into public.bookings
         (id, tenant_id, court_id, user_id,
          starts_at, ends_at, status, price_cents, currency, price_breakdown,
          num_players, player_name, stripe_payment_intent_id, payment_status,
          amount_refunded_cents, refund_tier_hours_before, refund_percent_applied,
          cancelled_at)
       values
         ($1, $2, $3, $4, $5, $6, 'cancelled', $7, 'eur',
          '{"regla":"base","total_cents":2400}', 4, 'Socio de T14b',
          $8, 'paid', $9, $10, $11, now())`,
      [
        fila.id,
        TENANT,
        fila.id,
        fila.userId,
        inicio.toISOString(),
        fin.toISOString(),
        fila.price ?? PRECIO,
        fila.intent,
        fila.amount,
        fila.tier,
        fila.percent,
      ],
    );
  });
}

function filaDeBooking(id: string) {
  return withAdmin(async (db) => {
    const filas = await db.query<{
      status: string;
      payment_status: string | null;
      amount_refunded_cents: number;
      refund_tier_hours_before: number | null;
      refund_percent_applied: number | null;
      cancelled_at: string | null;
    }>(
      `select status, payment_status, amount_refunded_cents,
              refund_tier_hours_before, refund_percent_applied, cancelled_at
         from public.bookings where id = $1`,
      [id],
    );
    const fila = filas.rows[0];
    if (fila === undefined) {
      throw new Error(
        `La reserva '${id}' no esta en la base. Un test que afirma sobre una fila que no ` +
          `existe pasaria con cualquier valor, asi que esto para el fichero aqui.`,
      );
    }
    return fila;
  });
}

/** La politica de `tenant_content['cancellation_policy']` del tenant, o null. */
function politicaDeTenant(tenantId: string) {
  return withAdmin(async (db) => {
    const filas = await db.query<{ value: unknown }>(
      `select value from public.tenant_content
        where tenant_id = $1 and content_key = 'cancellation_policy'`,
      [tenantId],
    );
    return filas.rows[0]?.value ?? null;
  });
}

function sembrarPolitica(tenantId: string, politica: unknown): Promise<void> {
  return withAdmin(async (db) => {
    await db.query(
      `insert into public.tenant_content (tenant_id, content_key, value)
       values ($1, 'cancellation_policy', $2::jsonb)
       on conflict (tenant_id, content_key) do update set value = excluded.value`,
      [tenantId, JSON.stringify(politica)],
    );
  });
}

function clienteFalso(): { client: StripeConnectClient; crearReembolso: ReturnType<typeof vi.fn> } {
  const crearReembolso = vi.fn(async (input: {
    paymentIntentId: string;
    amountCents: number;
    idempotencyKey: string;
  }) => ({ refundId: `re_${input.idempotencyKey}` }));

  return {
    client: {
      // Inertes: esta suite no llama a nada de T13 ni T14.
      crearCuentaExpress: vi.fn(async () => ({ id: "acct_falso_t14b" })),
      obtenerAccountLink: vi.fn(async () => "https://connect.stripe.com/setup/falso"),
      obtenerCuenta: vi.fn(async () => ({ chargesEnabled: true, payoutsEnabled: true })),
      crearPaymentIntent: vi.fn(async () => ({
        paymentIntentId: "pi_falso_t14b",
        clientSecret: "sk_falso_t14b",
      })),
      recuperarPaymentIntent: vi.fn(async (id: string) => ({
        paymentIntentId: id,
        clientSecret: "sk_falso_t14b",
      })),
      crearReembolso,
    },
    crearReembolso,
  };
}

function bookingT14b(n: number): string {
  const sufijo = (`00000000000${n}`).slice(-12);
  return `00000000-0000-4000-8000-${sufijo}`;
}

afterAll(async () => {
  await withAdmin(async (db) => {
    await db.query(`delete from public.bookings where tenant_id = any($1::uuid[])`, [
      [TENANT, TENANT_SIN_POLITICA],
    ]);
    await db.query(`delete from public.courts where tenant_id = any($1::uuid[])`, [
      [TENANT, TENANT_SIN_POLITICA],
    ]);
    await db.query(`delete from public.tenant_content where tenant_id = any($1::uuid[])`, [
      [TENANT, TENANT_SIN_POLITICA],
    ]);
    await db.query(`delete from public.tenants where id = any($1::uuid[])`, [
      [TENANT, TENANT_SIN_POLITICA],
    ]);
    await db.query(`delete from auth.users where id = any($1::uuid[])`, [
      [DUENO, GESTOR, TERCERO, DUENO_LIBRE],
    ]);
  });
  await closePool();
  await releaseDatabaseLease();
});

beforeAll(async () => {
  await prepareDatabase();
  await withAdmin(async (db) => {
    await db.query(
      `insert into public.tenants (id, name, slug)
       values ($1, 'Club T14b A', $2)
       on conflict (id) do update set name = excluded.name, slug = excluded.slug`,
      [TENANT, SLUG],
    );
    await db.query(
      `insert into public.tenants (id, name, slug)
       values ($1, 'Club T14b B', $2)
       on conflict (id) do update set name = excluded.name, slug = excluded.slug`,
      [TENANT_SIN_POLITICA, SLUG_SIN_POLITICA],
    );
    for (const [id, email] of [
      [DUENO, "t14b-dueno@example.test"],
      [GESTOR, "t14b-gestor@example.test"],
      [TERCERO, "t14b-tercero@example.test"],
      [DUENO_LIBRE, "t14b-dueno-libre@example.test"],
    ] as const) {
      await db.query(
        `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
        [id, email],
      );
    }
    await db.query(
      `insert into public.tenant_members (tenant_id, user_id, role)
       values ($1, $2, 'gestor')
       on conflict (tenant_id, user_id) do nothing`,
      [TENANT, GESTOR],
    );
    await db.query(
      `insert into public.tenant_members (tenant_id, user_id, role)
       values ($1, $2, 'gestor')
       on conflict (tenant_id, user_id) do nothing`,
      [TENANT, DUENO_LIBRE],
    );
  });
  // El club SIN politica no recibe fila de `tenant_content`: es el caso bajo test.
  await sembrarPolitica(TENANT, politicaPorDefecto());
});

describe("T14b E1: cancelarReserva", () => {
  it("25h antes: el dueno cancela y se le devuelve el 100% por su PaymentIntent", async () => {
    const id = bookingT14b(1);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_25h",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, DUENO, id);

    expect(resultado).toEqual({
      tipo: "cancelado",
      reembolso: {
        quote: { refundCents: PRECIO, tierHoursBefore: 24, percentApplied: 100, label: "Cancelacion gratuita hasta 24h antes" },
        refundId: "re_reembolso_" + id,
        pendiente: false,
      },
    });
    expect(crearReembolso).toHaveBeenCalledTimes(1);
    expect(crearReembolso).toHaveBeenCalledWith({
      paymentIntentId: "pi_25h",
      amountCents: PRECIO,
      idempotencyKey: "reembolso_" + id,
    });
    const fila = await filaDeBooking(id);
    expect(fila.status).toBe("cancelled");
    expect(fila.payment_status).toBe("refunded");
    expect(fila.amount_refunded_cents).toBe(PRECIO);
    expect(fila.refund_tier_hours_before).toBe(24);
    expect(fila.refund_percent_applied).toBe(100);
    expect(fila.cancelled_at).not.toBeNull();
  });

  it("24h y 5min: el limite inclusivo (>=) del tramo de 24h devuelve el 100%", async () => {
    const id = bookingT14b(2);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_24h5m",
      inicio: dentroDe(24 + 5 / 60),
    });
    const { client } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, DUENO, id);

    expect(resultado).toEqual(expect.objectContaining({
      tipo: "cancelado",
      reembolso: expect.objectContaining({
        quote: { refundCents: PRECIO, tierHoursBefore: 24, percentApplied: 100, label: "Cancelacion gratuita hasta 24h antes" },
      }),
    }));
  });

  it("20h antes: el 50% (tramo de 12h)", async () => {
    const id = bookingT14b(3);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_20h",
      inicio: dentroDe(20),
    });
    const { client } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, DUENO, id);

    expect(resultado).toEqual(expect.objectContaining({
      tipo: "cancelado",
      reembolso: expect.objectContaining({
        quote: { refundCents: PRECIO / 2, tierHoursBefore: 12, percentApplied: 50, label: "Entre 24h y 12h antes se devuelve el 50%" },
      }),
    }));
  });

  it("12h y 30min: el 50% (limite inclusivo del tramo de 12h)", async () => {
    const id = bookingT14b(4);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_12h30m",
      inicio: dentroDe(12 + 30 / 60),
    });
    const { client } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, DUENO, id);

    expect(resultado).toEqual(expect.objectContaining({
      tipo: "cancelado",
      reembolso: expect.objectContaining({
        quote: { refundCents: PRECIO / 2, tierHoursBefore: 12, percentApplied: 50, label: "Entre 24h y 12h antes se devuelve el 50%" },
      }),
    }));
  });

  it("5h antes: 0% -> no llama a Stripe y el pago sigue 'paid'", async () => {
    const id = bookingT14b(5);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_5h",
      inicio: dentroDe(5),
    });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, DUENO, id);

    expect(resultado).toEqual({
      tipo: "cancelado",
      reembolso: {
        quote: { refundCents: 0, tierHoursBefore: 0, percentApplied: 0, label: "Con menos de 12h no hay devolucion" },
        refundId: null,
        pendiente: false,
      },
    });
    expect(crearReembolso).not.toHaveBeenCalled();
    const fila = await filaDeBooking(id);
    expect(fila.status).toBe("cancelled");
    expect(fila.payment_status).toBe("paid");
    expect(fila.amount_refunded_cents).toBe(0);
    expect(fila.refund_tier_hours_before).toBe(0);
    expect(fila.refund_percent_applied).toBe(0);
  });

  it("el gestor cancela la reserva de otro socio: igual que el dueno", async () => {
    const id = bookingT14b(6);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_gestor",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, GESTOR, id);

    expect(resultado.tipo).toBe("cancelado");
    expect(crearReembolso).toHaveBeenCalledTimes(1);
  });

  it("un tercero (mismo club, sin ser dueño ni gestor) no ve la reserva: 404 y cero Stripe", async () => {
    const id = bookingT14b(7);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_tercero",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, TERCERO, id);

    expect(resultado).toEqual({ tipo: "sin_reserva" });
    expect(crearReembolso).not.toHaveBeenCalled();
    const fila = await filaDeBooking(id);
    expect(fila.status).toBe("confirmed");
  });

  it("una reserva inexistente: sin_reserva, sin llamar a Stripe", async () => {
    const { client, crearReembolso } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, DUENO, bookingT14b(90));

    expect(resultado).toEqual({ tipo: "sin_reserva" });
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("cancelar dos veces: la segunda es transicion_invalida y no vuelve a Stripe", async () => {
    const id = bookingT14b(8);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_doble",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const primera = await cancelarReserva(client, TENANT, DUENO, id);
    expect(primera.tipo).toBe("cancelado");

    const segunda = await cancelarReserva(client, TENANT, DUENO, id);

    expect(segunda).toEqual({ tipo: "transicion_invalida" });
    expect(crearReembolso).toHaveBeenCalledTimes(1);
  });

  it("una reserva ya empezada (starts_at pasada) es un 422 sin tocar Stripe", async () => {
    const id = bookingT14b(9);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_pasada",
      inicio: dentroDe(-1),
    });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, DUENO, id);

    expect(resultado).toEqual({ tipo: "ya_pasada" });
    expect(crearReembolso).not.toHaveBeenCalled();
    const fila = await filaDeBooking(id);
    expect(fila.status).toBe("confirmed");
  });

  it("una pending_payment no se cancela (el pago esta en curso)", async () => {
    const id = bookingT14b(10);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "pending_payment",
      paymentStatus: "unpaid",
      intent: "pi_pendiente",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT, DUENO, id);

    expect(resultado).toEqual({ tipo: "transicion_invalida" });
    expect(crearReembolso).not.toHaveBeenCalled();
    const fila = await filaDeBooking(id);
    expect(fila.status).toBe("pending_payment");
  });

  it("si Stripe falla, la cancelacion queda hecha y el reembolso pendiente", async () => {
    const id = bookingT14b(11);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_falla",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();
    crearReembolso.mockRejectedValueOnce(new Error("stripe caido"));

    const resultado = await cancelarReserva(client, TENANT, DUENO, id);

    expect(resultado).toEqual(expect.objectContaining({
      tipo: "cancelado",
      reembolso: expect.objectContaining({
        quote: expect.objectContaining({ refundCents: PRECIO, percentApplied: 100 }),
        refundId: null,
        pendiente: true,
      }),
    }));
    const fila = await filaDeBooking(id);
    expect(fila.status).toBe("cancelled");
    expect(fila.payment_status).toBe("paid");
    expect(fila.amount_refunded_cents).toBe(0);
    expect(fila.refund_tier_hours_before).toBe(24);
    expect(fila.refund_percent_applied).toBe(100);
  });

  it("un tenant sin politica en la base usa TRAMOS_POR_DEFECTO (20h -> 50%)", async () => {
    const id = bookingT14b(12);
    await sembrarReserva({
      id,
      tenantId: TENANT_SIN_POLITICA,
      userId: DUENO_LIBRE,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_sin_politica",
      inicio: dentroDe(20),
    });
    expect(await politicaDeTenant(TENANT_SIN_POLITICA)).toBeNull();
    const { client, crearReembolso } = clienteFalso();

    const resultado = await cancelarReserva(client, TENANT_SIN_POLITICA, DUENO_LIBRE, id);

    expect(resultado).toEqual(expect.objectContaining({
      tipo: "cancelado",
      reembolso: expect.objectContaining({
        quote: { refundCents: PRECIO / 2, tierHoursBefore: 12, percentApplied: 50, label: "Entre 24h y 12h antes se devuelve el 50%" },
      }),
    }));
    expect(crearReembolso).toHaveBeenCalledTimes(1);
    expect(crearReembolso).toHaveBeenCalledWith(expect.objectContaining({ amountCents: PRECIO / 2 }));
  });
});

describe("T14b E1: reembolsarCancelada (reintento del gestor)", () => {
  it("reembolsa UNA cancelada reembolsable, con el snapshot guardado", async () => {
    const id = bookingT14b(20);
    await sembrarCancelada({ id, userId: DUENO, intent: "pi_reintento", percent: 50, tier: 12, amount: 0 });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await reembolsarCancelada(client, TENANT, DUENO, id);

    expect(resultado).toEqual({
      tipo: "reembolsado",
      reembolso: {
        quote: { refundCents: PRECIO / 2, tierHoursBefore: 12, percentApplied: 50, label: null },
        refundId: "re_reembolso_" + id,
      },
    });
    expect(crearReembolso).toHaveBeenCalledTimes(1);
    expect(crearReembolso).toHaveBeenCalledWith({
      paymentIntentId: "pi_reintento",
      amountCents: PRECIO / 2,
      idempotencyKey: "reembolso_" + id,
    });
    const fila = await filaDeBooking(id);
    expect(fila.payment_status).toBe("refunded");
    expect(fila.amount_refunded_cents).toBe(PRECIO / 2);
  });

  it("el reintento usa EL SNAPSHOT, no la politica actual (el club la cambio a 0%)", async () => {
    const id = bookingT14b(21);
    await sembrarCancelada({ id, userId: DUENO, intent: "pi_snapshot", percent: 100, tier: 24, amount: 0 });
    await sembrarPolitica(TENANT, politicaCero());
    const { client, crearReembolso } = clienteFalso();

    const resultado = await reembolsarCancelada(client, TENANT, DUENO, id);

    expect(resultado).toEqual(expect.objectContaining({
      tipo: "reembolsado",
      reembolso: expect.objectContaining({
        quote: { refundCents: PRECIO, tierHoursBefore: 24, percentApplied: 100, label: null },
      }),
    }));
    expect(crearReembolso).toHaveBeenCalledWith(expect.objectContaining({ amountCents: PRECIO }));
  });

  it("un segundo reembolso sobre la misma reserva es transicion_invalida", async () => {
    const id = bookingT14b(22);
    await sembrarCancelada({ id, userId: DUENO, intent: "pi_otra_vez", percent: 50, tier: 12, amount: 0 });
    const { client, crearReembolso } = clienteFalso();

    const primero = await reembolsarCancelada(client, TENANT, DUENO, id);
    expect(primero.tipo).toBe("reembolsado");

    const segundo = await reembolsarCancelada(client, TENANT, DUENO, id);

    expect(segundo).toEqual({ tipo: "transicion_invalida" });
    expect(crearReembolso).toHaveBeenCalledTimes(1);
  });

  it("sobre una reserva CONFIRMADA (aun por cancelar) es transicion_invalida", async () => {
    const id = bookingT14b(23);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "confirmed",
      paymentStatus: "paid",
      intent: "pi_confirmada",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await reembolsarCancelada(client, TENANT, DUENO, id);

    expect(resultado).toEqual({ tipo: "transicion_invalida" });
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("un tercero no ve una cancelada ajena: sin_reserva", async () => {
    const id = bookingT14b(24);
    await sembrarCancelada({ id, userId: DUENO, intent: "pi_ajena", percent: 50, tier: 12, amount: 0 });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await reembolsarCancelada(client, TENANT, TERCERO, id);

    expect(resultado).toEqual({ tipo: "sin_reserva" });
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("una cancelada NO PAGADA (payment_status unpaid) no se reembolsa", async () => {
    const id = bookingT14b(25);
    await sembrarReserva({
      id,
      tenantId: TENANT,
      userId: DUENO,
      status: "cancelled",
      paymentStatus: "unpaid",
      intent: "pi_no_cobrada",
      inicio: dentroDe(25),
    });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await reembolsarCancelada(client, TENANT, DUENO, id);

    expect(resultado).toEqual({ tipo: "transicion_invalida" });
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("con tramo del 0% guardado no hay nada que reembolsar", async () => {
    const id = bookingT14b(26);
    await sembrarCancelada({ id, userId: DUENO, intent: "pi_cero", percent: 0, tier: 0, amount: 0 });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await reembolsarCancelada(client, TENANT, DUENO, id);

    expect(resultado).toEqual({ tipo: "sin_importe" });
    expect(crearReembolso).not.toHaveBeenCalled();
  });

  it("sin snapshot (percent null, reserva anterior a T14b) no hay nada que reembolsar", async () => {
    const id = bookingT14b(27);
    await sembrarCancelada({ id, userId: DUENO, intent: "pi_sin_snapshot", percent: null, tier: null, amount: 0 });
    const { client, crearReembolso } = clienteFalso();

    const resultado = await reembolsarCancelada(client, TENANT, DUENO, id);

    expect(resultado).toEqual({ tipo: "sin_importe" });
    expect(crearReembolso).not.toHaveBeenCalled();
  });
});