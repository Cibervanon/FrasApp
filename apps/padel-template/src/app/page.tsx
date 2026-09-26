import { Card } from "@frasapp/ui";

/**
 * Home provisional de T0. Solo comprueba que la cadena de paquetes esta
 * conectada: `ui` renderiza, `core` se importa, el build de Next funciona.
 *
 * El contenido real de la pantalla 1 (pistas del club, con la marca del
 * tenant) es T6.
 */
export default function HomePage() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <h1 className="text-2xl font-semibold">Padel</h1>
      <Card title="Reserva tu pista">
        <p className="text-sm text-neutral-600">
          Aqui apareceran las pistas del club.
        </p>
      </Card>
    </main>
  );
}
