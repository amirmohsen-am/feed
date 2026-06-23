import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
import { Geist, Geist_Mono, Space_Grotesk } from "next/font/google";
import { cn } from "@/lib/utils";
import ServerErrorToast from "@/components/ServerErrorToast";
import Analytics from "@/components/Analytics";

// Standalone GA4 property (gtag.js), separate from the Firebase-SDK GA4 in
// <Analytics />, which reports to a different measurement id (G-72NL4ZF268).
const GA_MEASUREMENT_ID = "G-V28TWVBNE7";

const geist = Geist({subsets:['latin'],variable:'--font-sans'});
const geistMono = Geist_Mono({subsets:['latin'],variable:'--font-geist-mono'});
const spaceGrotesk = Space_Grotesk({subsets:['latin'],variable:'--font-display'});

export const metadata: Metadata = {
  title: "amadi — A quieter, more intentional feed.",
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
        {/* Editorial brand wordmarks only: Instrument Serif (landing "amadi"),
            Merriweather (curator "amadi" logo). All UI/body/mono type is Geist. */}
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
        <Script
          src={`https://www.googletagmanager.com/gtag/js?id=${GA_MEASUREMENT_ID}`}
          strategy="afterInteractive"
        />
        <Script id="gtag-init" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', '${GA_MEASUREMENT_ID}');
          `}
        </Script>
      </body>
    </html>
  );
}
