import type {Metadata, Viewport} from "next";
import {Geist, Geist_Mono} from "next/font/google";
import "./globals.css";

import {OfflineBanner} from "./offline-banner";
import {ServiceWorkerRegister} from "@/components/pwa/service-worker-register";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const APP_NAME = "Peptimania";
const APP_DESCRIPTION =
    "Privacy-first, offline-capable peptide & medication tracker. All data stays in your browser.";

export const metadata: Metadata = {
    title: {
        default: `${APP_NAME} — Peptide & Medication Tracker`,
        template: `%s — ${APP_NAME}`,
    },
    description: APP_DESCRIPTION,
    applicationName: APP_NAME,
    manifest: "/manifest.webmanifest",
    appleWebApp: {
        capable: true,
        statusBarStyle: "black-translucent",
        title: APP_NAME,
    },
    icons: {
        icon: "/icons/icon-192.png",
        apple: "/icons/apple-touch-icon.png",
    },
};

export const viewport: Viewport = {
    width: "device-width",
    initialScale: 1,
    viewportFit: "cover",
    themeColor: [
        {media: "(prefers-color-scheme: light)", color: "#ffffff"},
        {media: "(prefers-color-scheme: dark)", color: "#0a0a0a"},
    ],
};

// Applies the dark class before first paint (no flash) and keeps it in sync
// when the OS theme changes. A manual toggle can replace the listeners later.
const themeInitScript = `
(function () {
  var root = document.documentElement;
  var mql = window.matchMedia("(prefers-color-scheme: dark)");
  function apply() {
    root.classList.toggle("dark", mql.matches);
    root.style.colorScheme = mql.matches ? "dark" : "light";
  }
  apply();
  mql.addEventListener("change", apply);
})();
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
    <head>
        <script dangerouslySetInnerHTML={{__html: themeInitScript}}/>
    </head>
    <body className="min-h-full flex flex-col">
    <OfflineBanner/>
    {children}
    <ServiceWorkerRegister/>
    </body>
    </html>
  );
}
