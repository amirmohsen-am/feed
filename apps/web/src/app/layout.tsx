import type { Metadata } from "next";
import "./globals.css";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import { cn } from "@/lib/utils";
import ServerErrorToast from "@/components/ServerErrorToast";
import Analytics from "@/components/Analytics";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});
const geistMono = Geist_Mono({subsets:['latin'],variable:'--font-geist-mono'});
const spaceGrotesk = Space_Grotesk({subsets:['latin'],variable:'--font-display'});

export const metadata: Metadata = {
  title: "Willow — A quieter, more intentional feed.",
  description: "Curate your Bluesky feed with AI. In the same way you curate what you eat, now curate what you read.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={cn("h-full antialiased", "font-sans", geist.variable, geistMono.variable, spaceGrotesk.variable)}>
      <head>
        {/* Editorial brand wordmarks only: Instrument Serif (landing "willow"),
            Merriweather (curator "Willow" logo). All UI/body/mono type is Geist. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif&family=Merriweather:wght@900&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-full flex flex-col">
        <Analytics />
        <ServerErrorToast />
        {children}
      </body>
    </html>
  );
}
