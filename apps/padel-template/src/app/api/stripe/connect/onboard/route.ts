import { resolveTenantId } from "../../../../../lib/server/tenant";
import { subDeSesion } from "../../../../../lib/server/session";
import {
  crearClienteStripe,
  cuentaExpressOIdExistente,
  esGestor,
  type StripeConnectClient,
} from "../../../../../lib/server/stripe-connect";

/**
 * `POST /api/stripe/connect/onboard` — gestor.
 *
 * Crea (o reutiliza) la cuenta Express del tenant y devuelve el Account Link de
 * onboarding para que el boton de la pantalla 20 lo abra en pestana nueva. Nunca
 * pinta un error de Stripe: se abre la URL o se responde el 500 generico.
 *
 * ---------------------------------------------------------------------------------
 * QUE SE AUTORIZA CON `esGestor` Y POR QUE
 * La cuenta Express se guarda en `tenants` (sin RLS): la unica barrera entre un
 * visitante cualquiera y "crear una cuenta en Stripe para este club" es esta rutas y
 * su comprobacion. Por eso es 401 sin identidad y 403 con identidad de no gestor. La
 * cookie sin firma sigue siendo el hueco de T11; aqui el daño ya no es "atribuirse un
 * hold", y queda en la misma decision pendiente.
 */

export const dynamic = "force-dynamic";

const SIN_CACHE = "no-store";

const COPY_403 = "No tienes permiso para gestionar los cobros de este club.";
const COPY_500 =
  "No se pudieron conectar los cobros. Vuelve a intentarlo en unos minutos.";

function urlBase(): string {
  const base = process.env["NEXT_PUBLIC_APP_URL"];
  if (!base) throw new Error("Falta NEXT_PUBLIC_APP_URL para construir los enlaces de onboarding.");
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

export async function manejarOnboard(
  request: Request,
  client?: StripeConnectClient,
): Promise<Response> {
  try {
    const efectivo = client ?? crearClienteStripe();
    const tenantId = await resolveTenantId();
    const sub = subDeSesion(request);
    if (sub === null) {
      return Response.json(
        { error: "No hay sesion para conectar los cobros." },
        { status: 401, headers: { "cache-control": SIN_CACHE } },
      );
    }
    if (!(await esGestor(tenantId, sub))) {
      return Response.json(
        { error: COPY_403 },
        { status: 403, headers: { "cache-control": SIN_CACHE } },
      );
    }

    const accountId = await cuentaExpressOIdExistente(efectivo, tenantId);
    const base = urlBase();
    const accountLinkUrl = await efectivo.obtenerAccountLink(accountId, {
      refresh: `${base}/admin/pagos?setup=refresh`,
      return: `${base}/api/stripe/connect/return?setup=complete`,
    });

    return Response.json(
      { accountLinkUrl },
      { status: 200, headers: { "cache-control": SIN_CACHE } },
    );
  } catch (error: unknown) {
    console.error(
      "[api/stripe/connect/onboard] no se pudo conectar los cobros",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return Response.json(
      { error: COPY_500 },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}

export async function POST(request: Request): Promise<Response> {
  return manejarOnboard(request);
}