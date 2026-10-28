import { NextResponse, type NextRequest } from "next/server";
import { refreshSessionToken, sessionCookie } from "@/lib/auth";
import { hasSameOrigin, requestOrigin } from "@/lib/request-origin";
import { hasHostAccess, requiresHostAccess } from "@/lib/app-capabilities";

const PUBLIC_ASSETS = new Set([
  "/rebattery-favicon.svg",
  "/rebattery-logo-all-black.svg",
  "/rebattery-workspace-icon.svg",
  // Public installation resources contain branding only, never workspace data.
  "/manifest.webmanifest",
  "/sw.js",
  "/rebattery-app-192.png",
  "/rebattery-app-512.png",
  "/rebattery-app-maskable-512.png",
  "/apple-touch-icon.png",
]);
const PUBLIC_ROUTES = new Set([
  "/login",
  "/api/auth/login",
  "/api/webhooks/postmark-mail",
  "/api/settings/mcp/connect/callback",
  // Platform server-to-server, read only (Jules commercial-buyer path); the route checks its own bearer secret.
  "/api/commercial-buyer/stock",
]);
// /t/ serves tracked links from trade emails; tokens are random and only forward.
const PUBLIC_PREFIXES = ["/api/apps/webhooks/", "/t/"];
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function isPublicPath(pathname: string): boolean {
  return (
    PUBLIC_ASSETS.has(pathname) ||
    PUBLIC_ROUTES.has(pathname) ||
    PUBLIC_PREFIXES.some((prefix) => pathname.startsWith(prefix))
  );
}

export async function middleware(req: NextRequest) {
  const pathname = req.nextUrl.pathname;
  if (isPublicPath(pathname)) { return NextResponse.next(); }

  if (!SAFE_METHODS.has(req.method) && !hasSameOrigin(req)) {
    return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
  }

  if (pathname === "/api/auth/logout") {
    return NextResponse.next();
  }

  const token = req.cookies.get("denchclaw_session")?.value;
  const user = token ? await refreshSessionToken(token) : null;
  if (!token || !user) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", requestOrigin(req));
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (requiresHostAccess(pathname, req.method) && !hasHostAccess(user)) {
    return NextResponse.json({ error: "Forbidden" }, {
      status: 403,
      headers: { "Cache-Control": "private, no-store", Vary: "Cookie" },
    });
  }

  // Next 15's Node middleware runner starts clone finalization without awaiting
  // it. If an authenticated upload is still arriving, the route adapter sees
  // the already-disturbed original Node stream and throws before POST runs.
  // Drain only this authenticated upload's clone so finalization can replace
  // the original body before the runner hands it to the route. The framework
  // clone limit and the route's 25 MB file limit remain unchanged.
  if (pathname === "/api/workspace/upload" && req.method === "POST") {
    await req.arrayBuffer();
  }

  const response = NextResponse.next();
  response.cookies.set(sessionCookie(token));
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}

export const runtime = "nodejs";
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
