import { execFile } from "node:child_process";
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

/** The team channel where sourcing requests are announced. */
const DISCORD_TARGET = process.env.COMMERCIAL_BUYER_DISCORD_TARGET || "discord:1523383956878266388";
const HERMES_BIN = process.env.HERMES_BIN || "/usr/local/lib/hermes-agent/.hermes/bin/hermes";

const quiet = (text: string) => text.replace(/@/g, "@\u200b");

export function buyRequestAnnouncement(input: { listingId: string; email: string; units: number; lines: { label: string | null; wanted: number; allocated: number }[]; suppliers: number }) {
  const base = (process.env.BULK_TRADES_LINK_BASE || "https://crm.rebattery.io").replace(/\/+$/, "");
  return [
    `**New buy request** (Jules, commercial buyer) · ${input.units} units · stock from ${input.suppliers} supplier${input.suppliers === 1 ? "" : "s"} attached`,
    ...input.lines.slice(0, 8).map((line) => `- ${line.wanted}x ${quiet(line.label ?? "battery")}${line.allocated < line.wanted ? ` (only ${line.allocated} in stock)` : ""}`),
    `Buyer: ${quiet(input.email)}`,
    `<${base}/?path=%7Etrades-preview&listing=${encodeURIComponent(input.listingId)}>`,
  ].join("\n");
}

/** Best effort: the demand is already saved, so a failed post is logged, never raised. */
export function announceBuyRequest(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(HERMES_BIN, ["-p", "default", "send", "--json", "-t", DISCORD_TARGET, text], { timeout: 60_000 }, (error, stdout) => {
      if (error) { console.error("[commercial-buyer] Discord announcement failed", { reason: error.message.slice(0, 200) }); resolve(false); return; }
      try { resolve(Boolean(JSON.parse(stdout).success)); } catch { resolve(false); }
    });
  });
}
