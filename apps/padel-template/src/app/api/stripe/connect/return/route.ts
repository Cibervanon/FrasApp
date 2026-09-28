import { resolveTenantId } from "../../../../../lib/server/tenant";
import { subDeSesion } from "../../../../../lib/server/session";
import {
  crearClienteStripe,
  cuentaConnectDeTenant,
  esGestor,
  sincronizarEstadoConnect,
  type StripeConnectClient,
} from "../../../../../lib/server/stripe-connect";

/**
 * `GET /api/stripe/connect/return?setup=complete` — gestor.
 *
 * Stripe redirige aqui cuando el gestor termina el onboarding (o lo deja a medias y
 * pulsa refresh). El servidor lee la cuenta en Stripe y actualiza los flags de la
 * fila del tenant ANTES de devolverlo al panel, para que la pantalla 20 cambie de
 * "Conectar los cobros" a "Los cobros estan conectados" al instante, sin esperar al
 * webhook.
 *
 * El webhook `account.updated` sigue siendo la autoridad final: si el gestor cierra
 * la pestana antes de llegar aqui, es el webhook quien mantiene el estado. Este
 * endpoint es el refuerzo rapido, no la fuente de verdad.
 */

export const dynamic = "force-dynamic";

const SIN_CACHE = "no-store";
const PANEL = "/admin/pagos";

const COPY_403 = "No tienes permiso para gestionar los cobros de este club.";

function alPanel(): Response {
  return new Response(null, { status: 302, headers: { location: PANEL } });
}

export async function manejarReturn(
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

    const accountId = await cuentaConnectDeTenant(tenantId);
    if (accountId === null) {
      // Sin cuenta el flujo no empezo: devolver al panel sin tocar Stripe.
      return alPanel();
    }

    if (new URL(request.url).searchParams.get("setup") === "complete") {
      await sincronizarEstadoConnect(efectivo, accountId);
    }
    // Cualquier otro query param (o ninguno) tambien vuelve al panel, sin sincronizar:
    // solo el retorno exitoso de Stripe dice que el onboarding avanzo.
    return alPanel();
  } catch (error: unknown) {
    console.error(
      "[api/stripe/connect/return] no se pudo sincronizar el onboarding",
      error instanceof Error ? error.stack ?? error.message : String(error),
    );
    return Response.json(
      { error: "No se pudieron conectar los cobros. Vuelve a intentarlo en unos minutos." },
      { status: 500, headers: { "cache-control": SIN_CACHE } },
    );
  }
}

export async function GET(request: Request): Promise<Response> {
  return manejarReturn(request);
}