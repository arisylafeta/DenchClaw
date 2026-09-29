// Per-recipient tracked links for Gmail drafts made from a trade. Safe for server only.

import { randomBytes } from "node:crypto";

/**
 * Public origin for tracked links, e.g. https://crm.rebattery.io. Tracking is off until it is set,
 * because the /t/ route must be reachable from the internet to work.
 */
export function trackedLinkBase(): string | null {
  const raw = process.env.BULK_TRADES_LINK_BASE?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "https:" ? url.origin : null;
  } catch {
    return null;
  }
}

export function newLinkToken(): string {
  return randomBytes(16).toString("base64url");
}

export const TOKEN = /^[A-Za-z0-9_-]{22}$/;

const URL_IN_TEXT = /https?:\/\/[^\s<>"']+/g;

/** Web links in a plain-text body, without trailing punctuation, each once. */
export function linksIn(body: string): string[] {
  const found = (body.match(URL_IN_TEXT) ?? []).map((url) => url.replace(/[.,;:!?)\]]+$/, ""));
  return [...new Set(found)];
}

/** Replaces each link with its tracked version. Longest first, so a link that prefixes another stays intact. */
export function replaceLinks(body: string, tracked: Map<string, string>): string {
  const urls = [...tracked.keys()].sort((a, b) => b.length - a.length);
  let result = body;
  const placeholders = urls.map((url, index) => {
    const marker = `\u0000${index}\u0000`;
    result = result.split(url).join(marker);
    return [marker, tracked.get(url)!] as const;
  });
  for (const [marker, replacement] of placeholders) result = result.split(marker).join(replacement);
  return result;
}

/**
 * Mail security scanners and link previewers open links before a person does. Their visits are
 * forwarded but not counted as clicks.
 */
export function isAutomatedVisit(method: string, userAgent: string | null): boolean {
  if (method !== "GET") return true;
  if (!userAgent) return true;
  return /bot|crawl|spider|preview|scan|proofpoint|mimecast|barracuda|safelinks|urldefense|headless|python|curl|wget|go-http|java\/|okhttp|facebookexternalhit|slack|whatsapp|googleimageproxy/i
    .test(userAgent);
}
