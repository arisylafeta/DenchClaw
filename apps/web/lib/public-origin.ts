/**
 * Resolves the public origin DenchClaw is reachable at — used when
 * registering OAuth callbacks (e.g. Composio) and computing the
 * `postMessage` target origin in OAuth callback popups.
 *
 * Why this helper exists:
 * - `new URL(request.url).origin` reflects the actual TCP socket
 *   DenchClaw is listening on (`http://localhost:3100`), not the public
 *   URL the user's browser is using.
 * - Next.js does NOT honor `X-Forwarded-*` headers when materializing
 *   `request.url`. Without this helper the Composio gateway would
 *   register `http://localhost:3100/api/composio/callback` as the OAuth
 *   redirect URI, which fails the moment the app is hosted behind any
 *   reverse proxy (ReBattery Cloud, ngrok, your own k8s ingress, etc.).
 *
 * Priority:
 *   1. **Trusted forwarded headers** (`X-Forwarded-Host` +
 *      `X-Forwarded-Proto`). On ReBattery Cloud the in-container Nginx sets
 *      both, so this naturally reflects the *current* public subdomain.
 *      That matters for warm-pool slug rebinds where the underlying
 *      container keeps running across the rebind: the env var below
 *      becomes stale, but the Host header is always live.
 *
 *      Spoofing risk is bounded by deployment topology — DenchClaw
 *      binds to 127.0.0.1:3100 inside the sandbox container, so these
 *      headers can only originate from the colocated Nginx instance,
 *      which sets them itself (`proxy_set_header X-Forwarded-Host
 *      $host;`).
 *   2. **`DENCHCLAW_PUBLIC_URL` env var.** Seeded by the sandbox boot
 *      script from the Secrets Manager config (`publicUrl` field). Used
 *      as a fallback when forwarded headers are absent (e.g. in-process
 *      probes, server-internal calls) and as a debugging aid.
 *   3. **`new URL(request.url).origin`.** Local dev fallback. With
 *      `bun run dev` and no proxy in front, this is
 *      `http://localhost:3100` and Composio happily accepts a localhost
 *      callback URL during development.
 */
export function resolveAppPublicOrigin(request: Request): string {
  const forwardedHost = firstHeaderValue(request, "x-forwarded-host");
  if (forwardedHost) {
    const forwardedProto = firstHeaderValue(request, "x-forwarded-proto");
    const proto = forwardedProto === "https" ? "https" : "http";
    return `${proto}://${forwardedHost}`;
  }

  const envUrl = process.env.DENCHCLAW_PUBLIC_URL?.trim();
  if (envUrl) {
    try {
      return new URL(envUrl).origin;
    } catch {
      // DENCHCLAW_PUBLIC_URL is malformed — fall through to request.url
      // so we still produce *some* origin instead of crashing.
    }
  }

  return new URL(request.url).origin;
}

/**
 * Reads the first comma-separated value from a header. Forwarded
 * headers can stack as proxies chain (`x-forwarded-host: a, b`); the
 * leftmost value is the original client-facing one.
 */
function firstHeaderValue(request: Request, name: string): string | null {
  const raw = request.headers.get(name);
  if (!raw) {
    return null;
  }
  const first = raw.split(",")[0]?.trim();
  return first && first.length > 0 ? first : null;
}
