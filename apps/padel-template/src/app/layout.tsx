import type { Metadata, Viewport } from "next";

import "./globals.css";

/**
 * Metadata sin marca. El nombre del club llega de `tenant_branding` en T6, con
 * el middleware que resuelve el subdominio. Poner un nombre aqui seria
 * hardcodear la marca del club de demostración en la plantilla.
 */
export const metadata: Metadata = {
  title: "Padel",
  description: "Reserva pista",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className="min-h-dvh bg-neutral-50 text-neutral-900 antialiased">
        {children}
      </body>
    </html>
  );
}
