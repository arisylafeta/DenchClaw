import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Server-to-server access for the platform's Jules commercial-buyer path. The shared secret lives in a 0600 file
 * (`COMMERCIAL_STOCK_SECRET_FILE`, default under the workspace secrets) so no unit or env change is needed.
 */
const SECRET_FILE = "/root/.hermes/workspace/secrets/commercial-stock-api.secret";

export function secret(): string | null {
  try {
    const value = readFileSync(process.env.COMMERCIAL_STOCK_SECRET_FILE || SECRET_FILE, "utf8").trim();
    return value.length >= 32 ? value : null;
  } catch {
    return null;
  }
}

export function commercialStockAuthorised(request: Request, expected = secret()): boolean {
  if (!expected) return false;
  const match = /^Bearer (\S+)$/.exec(request.headers.get("authorization") ?? "");
  if (!match) return false;
  const actual = createHash("sha256").update(match[1]).digest();
  return timingSafeEqual(actual, createHash("sha256").update(expected).digest());
}

/** Scope signatures are valid for one 30-day epoch and the one before it, so a leaked signature ages out. */
export const SCOPE_EPOCH_MS = 30 * 86_400_000;

/**
 * `scopeSig` = HMAC-SHA256(HMAC-SHA256(secret, "commercial-stock-scope-v1"), `${scope}|${epoch}`), hex. A key derived
 * from the bearer secret, so a signature never reveals the secret and the platform needs no second secret.
 */
export function scopeSignature(scope: string, key: string, epoch: number): string {
  const signingKey = createHmac("sha256", key).update("commercial-stock-scope-v1").digest();
  return createHmac("sha256", signingKey).update(`${scope}|${epoch}`).digest("hex");
}

export function scopeSignatureValid(scope: string, signature: string, key: string, now = Date.now()): boolean {
  const epoch = Math.floor(now / SCOPE_EPOCH_MS);
  const given = Buffer.from(signature, "hex");
  return [epoch, epoch - 1].some((candidate) => {
    const expected = Buffer.from(scopeSignature(scope, key, candidate), "hex");
    return expected.length === given.length && timingSafeEqual(expected, given);
  });
}

/**
 * A coarse global ceiling (one process serves the CRM): at most 600 stock requests an hour. Per-buyer budgets live in
 * the platform, which knows the visitor; this only stops a runaway or a leaked secret from loading the CRM database.
 */
const HOURLY_LIMIT = 600;
let window: { start: number; count: number } = { start: 0, count: 0 };
export function allowStockRequest(now = Date.now(), limit = HOURLY_LIMIT): boolean {
  if (now - window.start >= 3_600_000) window = { start: now, count: 0 };
  window.count += 1;
  return window.count <= limit;
}

export const unauthorised = () => Response.json({ error: "Unauthorised" }, { status: 401 });
