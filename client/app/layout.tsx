import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "MAESTRO",
  description:
    "Expérience musicale participative temps réel : le Maestro joue la base, le public ajoute les couches.",
};

export const viewport: Viewport = {
  themeColor: "#040804",
  // The musician screen is a play surface: pinch-zooming it would move the pads
  // out from under the fingers already on them.
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="fr">
      <body className="min-h-dvh bg-screen-deep text-phosphor antialiased">
        {children}
      </body>
    </html>
  );
}
