"use client";

import { useState } from "react";

/**
 * El boton "Conectar los cobros de mi club" (pantalla 20, T13).
 *
 * ---------------------------------------------------------------------------------------
 * LO QUE HACE
 *
 *  1. Pide `POST /api/stripe/connect/onboard`. El servidor crea (o reutiliza) la cuenta
 *     Express, monta el Account Link con el return y el refresh, y contesta la URL.
 *  2. Solo si es 200 abre la URL en pestana nueva.
 *
 * LO QUE NO HACE, A PROPOSITO
 *
 *  - No pinta NINGUN error de Stripe ni el detalle del 500: "jamas se pinta un error de
 *    Stripe en la pantalla" (spec). El fallo se resume en la misma frase generica del
 *    servidor, y el sub se queda en el boton para poder reintentar.
 *  - No navega la pestana actual: el gestor vuelve solo con la redireccion de Stripe.
 *
 * LOS STRINGS SON COPY DE PRODUCTO (regla 5), FIJADOS EN LA SPEC: sin jerga
 * tecnica, y por eso no hay "Account Link" ni "Express" por ninguna parte.
 */

const COPY_FALLO = "No se pudieron conectar los cobros. Vuelve a intentarlo en unos minutos.";

export function ConectarCobros() {
  const [conectando, setConectando] = useState(false);
  const [fallo, setFallo] = useState<string | null>(null);

  async function conectar(): Promise<void> {
    setConectando(true);
    setFallo(null);
    try {
      const respuesta = await fetch("/api/stripe/connect/onboard", { method: "POST" });
      if (respuesta.status !== 200) {
        setFallo(COPY_FALLO);
        return;
      }
      const cuerpo = (await respuesta.json()) as { accountLinkUrl?: unknown };
      if (typeof cuerpo.accountLinkUrl !== "string") {
        setFallo(COPY_FALLO);
        return;
      }
      window.open(cuerpo.accountLinkUrl, "_blank", "noopener,noreferrer");
    } catch {
      setFallo(COPY_FALLO);
    } finally {
      setConectando(false);
    }
  }

  return (
    <div className="mt-4 flex flex-col gap-2">
      <button
        type="button"
        onClick={conectar}
        disabled={conectando}
        className="w-fit rounded-xl bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-60"
      >
        {conectando ? "Conectando..." : "Conectar los cobros de mi club"}
      </button>
      {fallo !== null && (
        <p role="alert" className="text-sm text-red-600">
          {fallo}
        </p>
      )}
    </div>
  );
}