/**
 * Zona `/admin/*` - el espacio de gestion del club.
 *
 * Layout minimo de T13 (spec t13-stripe-connect.md, pantalla 20): no decide nada por
 * su cuenta. La autorizacion de cada pantalla (el sub de la cookie y su fila en
 * `tenant_members`) la hace la pagina, porque es de lo que sabe la pagina y no el
 * layout. Cuando /admin tenga mas de una pantalla, este es el sitio para la barra de
 * navegacion compartida.
 *
 * `force-dynamic` por el mismo motivo que el layout raiz: el tenant y su marca se leen
 * de la base por peticion, y un admin prerenderizado en el build seria el fallo de la
 * marca equivocada de `layout.tsx` con la gravedad anadida de gestion.
 */

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <main className="mx-auto flex min-h-dvh max-w-2xl flex-col gap-4 p-4">
      {children}
    </main>
  );
}