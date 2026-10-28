import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Server-to-server access for the platform's Jules commercial-buyer path. The shared secret lives in a 0600 file
 * (`COMMERCIAL_STOCK_SECRET_FILE`, default under the workspace secrets) so no unit or env change is needed.
 */
const SECRET_FILE = "/root/.hermes/workspace/secrets/commercial-stock-api.secret";

function secret(): string | null {
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

export const unauthorised = () => Response.json({ error: "Unauthorised" }, { status: 401 });
