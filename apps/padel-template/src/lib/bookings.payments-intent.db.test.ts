import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Queryable } from "../test/db-harness.js";
import {
  prepareDatabase,
  releaseDatabaseLease,
  withAdmin,
} from "../test/db-harness.js";

/**
 * T14 E1: coherencia de pagos en `bookings` contra Postgres REAL.
 *
 * La migracion `20260930000000_payments_intent.sql` NO anade columnas (T9 dejo todas):
 * anade las tres reglas que el flujo de cobro necesita y que nadie garantizaba:
 *
 *   1. `bookings_pending_payment_needs_intent` — un booking en pending_payment sin
 *      PaymentIntent no se puede confirmar nunca.
 *   2. `bookings_pending_payment_unpaid` — pending_payment es un cobro EN CURSO; no hay
 *      que poder insertarlo ya pagado.
 *   3. `bookings_confirmed_is_paid` — solo el webhook confirma, y el webhook confirma
 *      pagando. Compatible con T15, que inserta `confirmed` + `paid` de una pieza.
 *   4. `bookings_stripe_payment_intent_uidx` — un PaymentIntent es de UNA reserva; el
 *      indice unico parcial escala por tenant justo como la FK compuesta de T4.
 *
 * Todos los casos corren con `withAdmin`: se mide la RESTRICCION, no la politica. La RLS
 * de `bookings` ya tiene su fichero; aqui lo que falla (o no) es el esquema, y contra el
 * esquema no hay sesion que valga.
 *
 * LOS TENANTS SON TEMPORALES con ids fijos, y no los del harness: siembran su propia
 * pista para poder referenciar por la FK compuesta. Borrarlos en afterAll deja la base
 * como estaba.
 */

/** Persona que hace las reservas de los dos tenants temporales. */
const USER = "00000000-0000-4000-8000-0000000000e0";
/** Primer tenant temporal (donde vivo los duplicados de intent). */
const TENANT_PAY = "00000000-0000-4000-8000-0000000000e1";
/** Segundo tenant temporal (control negativo del indice por tenant). */
const TENANT_PAY_2 = "00000000-0000-4000-8000-0000000000e2";
/** Pista del primer tenant temporal. */
const COURT_PAY = "00000000-0000-4000-8000-0000000000e3";
/** Pista del segundo tenant temporal. */
const COURT_PAY_2 = "00000000-0000-4000-8000-0000000000e4";

interface FilaBooking {
  readonly id: string;
  readonly tenant_id: string;
  readonly court_id: string;
  readonly starts_at: string;
  readonly status?: string;
  readonly hold_expires_at?: string | null;
  readonly stripe_payment_intent_id?: string | null;
  readonly payment_status?: string | null;
}

/** Insert de un booking con solo lo que la restriccion de T14 pone a prueba. */
async function insertarBooking(db: Queryable, fila: FilaBooking): Promise<void> {
  await db.query(
    `insert into public.bookings (
       id, tenant_id, court_id, user_id, starts_at, ends_at,
       status, hold_expires_at, price_cents, price_breakdown,
       player_name, stripe_payment_intent_id, payment_status
     ) values (
       $1, $2, $3, $4, $5, $6,
       $7, $8, 2400, '{}'::jsonb,
       'Ana de Prueba', $9, $10
     )`,
    [
      fila.id,
      fila.tenant_id,
      fila.court_id,
      USER,
      fila.starts_at,
      // 90 minutos despues: una reserva que existe.
      new Date(new Date(fila.starts_at).getTime() + 90 * 60_000).toISOString(),
      fila.status ?? "held",
      fila.hold_expires_at ?? (fila.status === "held" ? "2026-10-02T09:00:00Z" : null),
      fila.stripe_payment_intent_id ?? null,
      fila.payment_status ?? null,
    ],
  );
}

async function seedFixtures(): Promise<void> {
  await withAdmin(async (db) => {
    await db.query(
      `insert into auth.users (id, email) values ($1, $2) on conflict (id) do nothing`,
      [USER, "t14-pago@example.test"],
    );

    for (const [tenant, name, slug, court, courtName] of [
      [TENANT_PAY, "Club Pago A", "club-pago-a", COURT_PAY, "Pista A"],
      [TENANT_PAY_2, "Club Pago B", "club-pago-b", COURT_PAY_2, "Pista B"],
    ] as const) {
      await db.query(
        `insert into public.tenants (id, name, slug) values ($1, $2, $3)
         on conflict (id) do nothing`,
        [tenant, name, slug],
      );
      await db.query(
        `insert into public.courts (id, tenant_id, name, court_type, base_price_cents)
         values ($1, $2, $3, 'cristal', 2400)
         on conflict (id) do nothing`,
        [court, tenant, courtName],
      );
    }
  });
}

afterAll(async () => {
  await withAdmin(async (db) => {
    await db.query(`delete from public.bookings where tenant_id = any($1::uuid[])`, [
      [TENANT_PAY, TENANT_PAY_2],
    ]);
    await db.query(`delete from auth.users where id = $1`, [USER]);
    await db.query(`delete from public.tenants where id = any($1::uuid[])`, [
      [TENANT_PAY, TENANT_PAY_2],
    ]);
  });
  await releaseDatabaseLease();
});

beforeAll(async () => {
  await prepareDatabase();
  await seedFixtures();
});

describe("T14 E1: coherencia de pagos en bookings", () => {
  it("pending_payment sin PaymentIntent es imposible de crear", async () => {
    await expect(
      withAdmin((db) =>
        insertarBooking(db, {
          id: "00000000-0000-4000-8000-0000000000f1",
          tenant_id: TENANT_PAY,
          court_id: COURT_PAY,
          starts_at: "2026-11-02T10:00:00Z",
          status: "pending_payment",
          stripe_payment_intent_id: null,
          payment_status: "unpaid",
        }),
      ),
    ).rejects.toThrow(/bookings_pending_payment_needs_intent/);
  });

  it("pending_payment ya pagado es imposible de crear", async () => {
    await expect(
      withAdmin((db) =>
        insertarBooking(db, {
          id: "00000000-0000-4000-8000-0000000000f2",
          tenant_id: TENANT_PAY,
          court_id: COURT_PAY,
          starts_at: "2026-11-02T12:00:00Z",
          status: "pending_payment",
          stripe_payment_intent_id: "pi_impaga_0002",
          payment_status: "paid",
        }),
      ),
    ).rejects.toThrow(/bookings_pending_payment_unpaid/);
  });

  it("pending_payment sin payment_status (NULL) tambien es imposible", async () => {
    // Este es el agujero de los `check` con `=` y NULL: con `payment_status = 'unpaid'`
    // la fila NULL dejaria el check en NULL y Postgres lo DEJA PASAR. Solo lo caza
    // `is not distinct from`, y la prueba de este caso es la que obliga a escribirlo.
    await expect(
      withAdmin((db) =>
        insertarBooking(db, {
          id: "00000000-0000-4000-8000-0000000000f9",
          tenant_id: TENANT_PAY,
          court_id: COURT_PAY,
          starts_at: "2026-11-02T13:00:00Z",
          status: "pending_payment",
          stripe_payment_intent_id: "pi_impaga_0009",
          payment_status: null,
        }),
      ),
    ).rejects.toThrow(/bookings_pending_payment_unpaid/);
  });

  it("confirmed sin pago es imposible de crear", async () => {
    await expect(
      withAdmin((db) =>
        insertarBooking(db, {
          id: "00000000-0000-4000-8000-0000000000f3",
          tenant_id: TENANT_PAY,
          court_id: COURT_PAY,
          starts_at: "2026-11-02T14:00:00Z",
          status: "confirmed",
          stripe_payment_intent_id: "pi_impaga_0003",
          payment_status: null,
        }),
      ),
    ).rejects.toThrow(/bookings_confirmed_is_paid/);
  });

  it("confirmed y paid si entran, como inserta T15 los partidos abiertos", async () => {
    await expect(
      withAdmin((db) =>
        insertarBooking(db, {
          id: "00000000-0000-4000-8000-0000000000f4",
          tenant_id: TENANT_PAY,
          court_id: COURT_PAY,
          starts_at: "2026-11-02T16:00:00Z",
          status: "confirmed",
          stripe_payment_intent_id: "pi_pagada_0004",
          payment_status: "paid",
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("un mismo PaymentIntent no puede vivir en dos reservas del mismo tenant", async () => {
    await withAdmin(async (db) => {
      await insertarBooking(db, {
        id: "00000000-0000-4000-8000-0000000000f5",
        tenant_id: TENANT_PAY,
        court_id: COURT_PAY,
        starts_at: "2026-11-03T10:00:00Z",
        status: "pending_payment",
        stripe_payment_intent_id: "pi_duplicado",
        payment_status: "unpaid",
      });

      await expect(
        insertarBooking(db, {
          id: "00000000-0000-4000-8000-0000000000f6",
          tenant_id: TENANT_PAY,
          court_id: COURT_PAY,
          starts_at: "2026-11-03T12:00:00Z",
          status: "pending_payment",
          stripe_payment_intent_id: "pi_duplicado",
          payment_status: "unpaid",
        }),
      ).rejects.toThrow(/bookings_stripe_payment_intent_uidx/);
    });
  });

  it("el mismo PaymentIntent en OTRO tenant no choca (el indice es por tenant)", async () => {
    await withAdmin(async (db) => {
      await insertarBooking(db, {
        id: "00000000-0000-4000-8000-0000000000f7",
        tenant_id: TENANT_PAY,
        court_id: COURT_PAY,
        starts_at: "2026-11-04T10:00:00Z",
        status: "pending_payment",
        stripe_payment_intent_id: "pi_compartida",
        payment_status: "unpaid",
      });

      await expect(
        insertarBooking(db, {
          id: "00000000-0000-4000-8000-0000000000f8",
          tenant_id: TENANT_PAY_2,
          court_id: COURT_PAY_2,
          starts_at: "2026-11-04T10:00:00Z",
          status: "pending_payment",
          stripe_payment_intent_id: "pi_compartida",
          payment_status: "unpaid",
        }),
      ).resolves.toBeUndefined();
    });
  });
});