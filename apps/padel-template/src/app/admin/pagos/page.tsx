import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { subDeValor } from "../../../lib/server/session";
import { resolveTenantId } from "../../../lib/server/tenant";
import { estadoConnectDelTenant, esGestor } from "../../../lib/server/stripe-connect";

import { ConectarCobros } from "./ConectarCobros";

/**
 * Pantalla 20 del MVP: pagos del club. Spec t13-stripe-connect.md.
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE HACE, Y EN QUE ORDEN
 *
 *  1. Lee el `sub` de la cookie. Sin identidad, redirige a `/`: el panel de gestion no
 *     es publico y esta pantalla no se prerenderiza para ningun club.
 *  2. Comprueba que el `sub` es gestor DE ESTE tenant con `esGestor`, que corre bajo
 *     `tenantQuery` y de cuyo aislamiento se encarga la RLS de `tenant_members`. Un
 *     gestor de otro club no ve la fila y cae redirigido igual que un visitante.
 *  3. Lee `tenants.stripe_charges_enabled` (estado local, sin llamar a Stripe) y pinta
 *     una de las dos copias fijadas en la spec:
 *       - pendiente: "Conectar los cobros de mi club" + el boton.
 *       - conectado: "Los cobros estan conectados".
 *
 * LOS STRINGS DE ESTA PANTALLA SON LOS DE LA SPEC, NO MARCA DEL CLUB: son copy de
 * producto (regla 5, sin jerga), no contenido del gestor, y por eso van aqui y no en
 * `tenant_content`.
 */

export const dynamic = "force-dynamic";

const COPY_PENDIENTE = "Conectar los cobros de mi club";
const COPY_PENDIENTE_DETALLE =
  "Para que los socios puedan pagar, conecta los cobros con tu banco.";
const COPY_CONECTADO = "Los cobros estan conectados";
const COPY_CONECTADO_DETALLE = "Los pagos de los socios van a la cuenta de tu club.";

export default async function PagosPage() {
  const cookieHeader = (await cookies()).get("frasapp_session")?.value ?? null;
  const sub = subDeValor(cookieHeader);
  if (sub === null) redirect("/");

  const tenantId = await resolveTenantId();
  if (!(await esGestor(tenantId, sub))) redirect("/");

  const estado = await estadoConnectDelTenant(tenantId);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-xl font-semibold text-neutral-900">Pagos</h1>

      {estado.chargesEnabled ? (
        <section className="rounded-2xl border border-neutral-200 bg-white p-4">
          <h2 className="text-base font-medium text-neutral-900">{COPY_CONECTADO}</h2>
          <p className="mt-1 text-sm text-neutral-600">{COPY_CONECTADO_DETALLE}</p>
        </section>
      ) : (
        <section className="rounded-2xl border border-neutral-200 bg-white p-4">
          <h2 className="text-base font-medium text-neutral-900">{COPY_PENDIENTE}</h2>
          <p className="mt-1 text-sm text-neutral-600">{COPY_PENDIENTE_DETALLE}</p>
          <ConectarCobros />
        </section>
      )}
    </div>
  );
}