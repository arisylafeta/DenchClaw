import type { Metadata, Viewport } from "next";
import { Suspense } from "react";
import { ThemeProvider } from "next-themes";
import { getOrCreateAnonymousId, readPersonInfo, readPrivacyMode } from "@/lib/telemetry";
import { PostHogProvider } from "./components/posthog-provider";
import { PwaRegister } from "./components/pwa-register";
import { Toaster } from "./components/platform-admin/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "ReBattery CRM",
  applicationName: "ReBattery CRM",
  description: "ReBattery's private CRM and DenchClaw AI workspace.",
  appleWebApp: {
    capable: true,
    title: "ReBattery CRM",
    statusBarStyle: "default",
  },
  icons: {
    icon: "/rebattery-favicon.svg",
    apple: {
      url: "/apple-touch-icon.png",
      sizes: "180x180",
      type: "image/png",
    },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f5f4" },
    { media: "(prefers-color-scheme: dark)", color: "#222222" },
  ],
};

export const dynamic = "force-dynamic";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const anonymousId = getOrCreateAnonymousId();
  const personInfo = readPersonInfo();
  const privacyMode = readPrivacyMode();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){
  var k='__chunk_reload';
  if(sessionStorage.getItem(k)){sessionStorage.removeItem(k);return}
  function reload(){sessionStorage.setItem(k,'1');window.location.reload()}
  window.addEventListener('error',function(e){
    var t=e.target;
    if(t&&(t.tagName==='SCRIPT'||t.tagName==='LINK')){
      var s=t.src||t.href||'';
      if(s.indexOf('_next/static')!==-1)reload();
    }
  },true);
  window.addEventListener('unhandledrejection',function(e){
    if(e.reason&&e.reason.name==='ChunkLoadError')reload();
  });
})();`,
          }}
        />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Instrument+Serif:ital@0;1&family=Inter:wght@300;400;500;600;700&family=Lora:ital,wght@0,400..700;1,400..700&family=Geist:wght@400;500;600;700&family=Geist+Mono:wght@500&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased">
        <ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
          <Suspense fallback={null}>
            <PostHogProvider anonymousId={anonymousId} personInfo={personInfo ?? undefined} privacyMode={privacyMode}>
              {children}
              <Toaster />
              <PwaRegister />
            </PostHogProvider>
          </Suspense>
        </ThemeProvider>
      </body>
    </html>
  );
}
