import { ALLOWED_EMAILS, type AuthenticatedUser } from "@/lib/auth";

/** Admins retain trusted host access. Conversation ACLs are not a host sandbox. */
export function hasHostAccess(user: Pick<AuthenticatedUser, "email">): boolean {
  return ALLOWED_EMAILS.has(user.email);
}

const ADMIN_PREFIXES = [
  "/api/terminal",
  "/api/settings",
  "/api/integrations",
  "/api/apps",
  "/api/skills",
  "/api/memories",
  "/api/cron",
  "/api/onboarding",
  // Retired OpenClaw transports have no conversation ACL integration. Native
  // Hermes clients use /api/hermes; only trusted host admins may inspect legacy data.
  "/api/sessions",
  "/api/web-sessions",
  "/api/gateway",
  "/api/chat",
  "/platform-admin",
];
const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * Generic host files, SQL, executable apps and configuration must not bypass
 * conversation ACLs. Structured CRM entry/view routes retain their own user
 * checks. Public callbacks/webhooks are handled separately by middleware.
 * Unknown workspace operations default to admin-only, including new routes.
 */
export function requiresHostAccess(pathname: string, method: string): boolean {
  let path: string;
  try { path = decodeURIComponent(pathname).replace(/\/+$/, ""); }
  catch { return true; }
  if (path.includes("\\") || path.includes("\0") || path.split("/").some(part => part === "." || part === "..")) { return true; }
  if (ADMIN_PREFIXES.some(prefix => under(path, prefix))) { return true; }
  if (under(path, "/api/profiles")) { return path !== "/api/profiles" || method !== "GET"; }
  if (!under(path, "/api/workspace")) { return false; }

  // Metadata and structured CRM records use the existing scoped data adapters.
  if (method === "GET" && /^\/api\/workspace\/objects(?:\/[^/]+)?$/.test(path)) { return false; }
  if (/^\/api\/workspace\/objects\/[^/]+\/(entries|views)(?:\/|$)/.test(path)) { return false; }
  return true;
}
