import { NextResponse, type NextRequest } from "next/server";
import { validateSessionToken } from "@/lib/auth";
import { hasSameOrigin, requestOrigin } from "@/lib/request-origin";

const PUBLIC_ASSETS = new Set([
  "/rebattery-favicon.svg",
  "/rebattery-logo-all-black.svg",
  "/rebattery-workspace-icon.svg",
]);
const PUBLIC_ROUTES = new Set([
  "/login",
  "/api/auth/login",
  "/api/auth/me",
  "/api/settings/mcp/connect/callback",
]);
const PUBLIC_PREFIXES = ["/api/apps/webhooks/"];
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
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = req.cookies.get("denchclaw_session")?.value;
  if (!token || !(await validateSessionToken(token))) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/login", requestOrigin(req));
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (!SAFE_METHODS.has(req.method)) {
    if (!hasSameOrigin(req)) {
      return NextResponse.json({ error: "CSRF check failed" }, { status: 403 });
    }
  }

  const response = NextResponse.next();
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Vary", "Cookie");
  return response;
}

export const runtime = "nodejs";
export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
