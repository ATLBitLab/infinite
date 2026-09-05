import type { Metadata, Viewport } from "next";
import { Bungee, Space_Grotesk } from "next/font/google";
import "./globals.css";

const bungee = Bungee({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-display",
});

const spaceGrotesk = Space_Grotesk({
  subsets: ["latin"],
  variable: "--font-body",
});

const SITE_URL = process.env.NEXT_PUBLIC_SITE_URL ?? "https://infinite.atlbitlab.com";
const TITLE = "INFINITE — the endless cartoon channel";
const DESCRIPTION =
  "An infinite AI-generated cartoon livestream roasting bitcoin, freedom tech, and AI. Pay bitcoin, add your idea to the broadcast.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: TITLE,
  description: DESCRIPTION,
  openGraph: {
    type: "website",
    url: "/",
    siteName: "INFINITE",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
};

// viewport-fit=cover lets the bottom bar pad itself past the iPhone home
// indicator (see pb-[env(safe-area-inset-bottom)] on the bars).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#0d0b0e",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${bungee.variable} ${spaceGrotesk.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
