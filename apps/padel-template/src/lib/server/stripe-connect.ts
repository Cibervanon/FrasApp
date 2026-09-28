import Stripe from "stripe";

import { baseQuery, tenantQuery } from "./db";

/**
 * Stripe Connect para T13 (spec t13-stripe-connect.md): cuenta Express, Account
 * Link de onboarding, sincronizacion del estado y comprobacion de gestor.
 *
 * COMO SE TESTEA SIN LLAMAR A LA API DE STRIPE
 * Toda la logica de negocio de este fichero inyecta un `StripeConnectClient`. El
 * cliente real se construye con `crearClienteStripe()` (STRIPE_SECRET_KEY), y los
 * tests inyectan uno falso cuyo contrato es este interfaz. La frontera de este
 * fichero con el mundo real es exactamente la de `stripe.ts`: nadie importa `stripe`
 * fuera de aqui, y asi un test de RLS no depende de que exista una cuenta de test.
 *
 * LO QUE TOCA LA BASE
 * - `tenants.stripe_account_id`: solo soporta el flujo "cuenta existente" de T14.
 * - `tenants.stripe_charges_enabled` / `stripe_payouts_enabled` /
 *   `stripe_onboarding_completed_at`: los actualiza el return y el webhook. El
 *   webhook es la autoridad final (Stripe reintenta hasta que conteste), por eso esta
 *   operacion es idempotente: escribe el MISMO estado cada vez que llega un
 *   `account.updated`.
 * - `tenant_members`: la comprobacion de gestor, que corre por `tenantQuery` y de la
 *   que se encarga la RLS de la tabla.
 *
 * `tenants` no tiene RLS (lo dice `db.ts`), asi que las dos primeras van por
 * `baseQuery`: la confianza no la da un rol, la da quien llame (el gestor pasando por
 * las rutas, o la firma del webhook). La comprobacion de quién llama vive en las
 * rutas, no aqui.
 */

/** La frontera con Stripe. Los tests inyectan un falso con este mismo contrato. */
export interface StripeConnectClient {
  crearCuentaExpress(): Promise<{ id: string }>;
  obtenerAccountLink(
    accountId: string,
    urls: { refresh: string; return: string },
  ): Promise<string>;
  obtenerCuenta(accountId: string): Promise<{
    chargesEnabled: boolean;
    payoutsEnabled: boolean;
  }>;
}

/**
 * La comision de plataforma, anclada.
 *
 * El argumento de venta de la linea de plantillas es que el club cobra integralmente
 * lo que muestra. 0 es la unica constante que hace ese argumento verdadero, y si
 * alguien la sube, el test propio de T13 falla. T14 la importa para el
 * PaymentIntent y no puede divergir. NO se calcula desde `STRIPE_PLATFORM_FEE_PERCENT`
 * (que existe en el env para el pais donde haya comision y aun no se consume).
 */
export const COMISION_PLATAFORMA_CENTS = 0;

/** El cliente real, construido con la key del despliegue. */
export function crearClienteStripe(): StripeConnectClient {
  const secreto = process.env["STRIPE_SECRET_KEY"];
  if (!secreto) {
    throw new Error(
      "Falta STRIPE_SECRET_KEY. Copia .env.example a .env.local y pon la key de " +
        "Stripe (sk_test_ o sk_live_) que corresponda.",
    );
  }
  const stripe = new Stripe(secreto);
  return {
    crearCuentaExpress: async () => {
      const cuenta = await stripe.accounts.create({ type: "express" });
      return { id: cuenta.id };
    },
    obtenerAccountLink: async (accountId, urls) => {
      const enlace = await stripe.accountLinks.create({
        account: accountId,
        type: "account_onboarding",
        refresh_url: urls.refresh,
        return_url: urls.return,
      });
      if (!enlace.url) {
        throw new Error(
          "Stripe devolvio un Account Link sin url. Es una anomalia del SDK, no de " +
            "la peticion.",
        );
      }
      return enlace.url;
    },
    obtenerCuenta: async (accountId) => {
      const cuenta = await stripe.accounts.retrieve(accountId);
      // El tipo de Stripe es `boolean | null | undefined`; lo que no sea `true`
      // explicito no es verdad en el estado de la cuenta.
      return {
        chargesEnabled: cuenta.charges_enabled === true,
        payoutsEnabled: cuenta.payouts_enabled === true,
      };
    },
  };
}

interface FilaTenant {
  readonly stripe_account_id: string | null;
}

/** La cuenta Connect del tenant, o null si aun no la tiene. */
async function leerCuenta(tenantId: string): Promise<string | null> {
  const filas = await baseQuery<FilaTenant>(
    `select stripe_account_id from public.tenants where id = $1`,
    [tenantId],
  );
  return filas[0]?.stripe_account_id ?? null;
}

/**
 * Guarda la cuenta del tenant, pero NUNCA machaca un id ya puesto.
 *
 * El `where stripe_account_id is null` hace que dos clicks que lleguen a la vez no
 * dejen dos ids: el primero escribe, el segundo no toca nada y re-lee el del primero.
 * La cuenta Express que el perdedor acabara de crear queda huerfana en Stripe: es el
 * coste residual de una carrera de verdad, y el criterio "nunca dos cuentas por dos
 * clicks" se defiende en que la base tiene UN solo id y el flujo siempre lo reusa.
 */
async function guardarCuenta(tenantId: string, accountId: string): Promise<string> {
  const guardadas = await baseQuery<FilaTenant>(
    `update public.tenants
        set stripe_account_id = $1
      where id = $2 and stripe_account_id is null
      returning stripe_account_id`,
    [accountId, tenantId],
  );
  const guardada = guardadas[0]?.stripe_account_id;
  if (guardada !== undefined && guardada !== null) return guardada;

  const otra = await leerCuenta(tenantId);
  if (otra !== null) return otra;
  // Inalcanzable salvo que otra conexion borre el id entre el update y la relectura,
  // que no es algo que la aplicacion haga. Se queda con la cuenta recien creada.
  return accountId;
}

/**
 * La cuenta Express del tenant: la reutiliza si existe, la crea si no.
 *
 * La reutilizacion es el criterio "doble-click no crea dos cuentas": el Account Link
 * se pide sobre el id ya guardado, asi que un segundo click no llama a Stripe.
 */
export async function cuentaExpressOIdExistente(
  client: StripeConnectClient,
  tenantId: string,
): Promise<string> {
  const existente = await leerCuenta(tenantId);
  if (existente !== null) return existente;

  const { id } = await client.crearCuentaExpress();
  return guardarCuenta(tenantId, id);
}

/**
 * La cuenta Connect del tenant, o null. SOLO lectura: esta es la que usa el return
 * para decidir si hay algo que sincronizar, y los tests de que un return sin cuenta
 * no crea ninguna.
 */
export async function cuentaConnectDeTenant(tenantId: string): Promise<string | null> {
  return leerCuenta(tenantId);
}

/** El estado Connect de una cuenta, tal y como lo pinta la fila del tenant. */
export interface EstadoConnect {
  readonly chargesEnabled: boolean;
  readonly payoutsEnabled: boolean;
}

/**
 * Baja de Stripe el estado de la cuenta y lo escribe en su tenant.
 *
 * `stripe_onboarding_completed_at` se pone SOLO en la transicion a charges habilitado:
 * una fecha ya puesta no se machaca, ni se repone si la cuenta cae y resube. Eso lo
 * hace el `case` del update, no el codigo: la fuente de verdad de "cuando se completo"
 * es la primera vez que Stripe dijo que podia cobrar.
 */
export async function sincronizarEstadoConnect(
  client: StripeConnectClient,
  accountId: string,
): Promise<EstadoConnect> {
  const estado = await client.obtenerCuenta(accountId);
  await baseQuery(
    `update public.tenants
        set stripe_charges_enabled = $1,
            stripe_payouts_enabled = $2,
            stripe_onboarding_completed_at = case
              when $1 and stripe_onboarding_completed_at is null then now()
              else stripe_onboarding_completed_at
            end
      where stripe_account_id = $3`,
    [estado.chargesEnabled, estado.payoutsEnabled, accountId],
  );
  return estado;
}

/**
 * El estado Connect del tenant: lo que la pantalla 20 pinta.
 *
 * SOLO lectura de `tenants`, sin llamar a Stripe: es lo que el panel necesita para
 * decidir entre "Conectar los cobros de mi club" y "Los cobros estan conectados",
 * y salta el round-trip a la API de Stripe en cada visita.
 */
export async function estadoConnectDelTenant(tenantId: string): Promise<EstadoConnect> {
  const filas = await baseQuery<{ charges: boolean; payouts: boolean }>(
    `select stripe_charges_enabled as charges, stripe_payouts_enabled as payouts
       from public.tenants where id = $1`,
    [tenantId],
  );
  const fila = filas[0];
  return {
    chargesEnabled: fila?.charges ?? false,
    payoutsEnabled: fila?.payouts ?? false,
  };
}

/**
 * Tiene el `sub` una fila de gestor en este tenant?
 *
 * Corre por `tenantQuery` con el `sub` real en los claims: la RLS de `tenant_members`
 * filtra por `tenant_id` del JWT, asi que un gestor de B preguntado por A no ve su
 * fila (test obligatorio de la spec). El `where user_id = $1` solo decide QUIEN de
 * las filas que la politica deja ver; el aislamiento lo pone la politica.
 */
export async function esGestor(tenantId: string, sub: string): Promise<boolean> {
  const filas = await tenantQuery<{ uno: number }>(
    tenantId,
    `select 1 as uno from public.tenant_members where user_id = $1 limit 1`,
    [sub],
    sub,
  );
  return filas.length > 0;
}