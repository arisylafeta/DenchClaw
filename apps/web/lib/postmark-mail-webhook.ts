import { createHash } from "node:crypto";

export const POSTMARK_BODY_LIMIT = 64 * 1024;
export class PostmarkBodyTooLarge extends Error {}

/** Count bytes as they arrive, including requests without Content-Length. */
export async function readPostmarkBody(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) {throw new Error("Missing body");}
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {break;}
      bytes += value.byteLength;
      if (bytes > POSTMARK_BODY_LIMIT) {
        await reader.cancel();
        throw new PostmarkBodyTooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Bound strings inside provider metadata as well as its top-level fields. */
export function boundedPostmarkMetadata(value: unknown, limit = 256): unknown {
  if (typeof value === "string") {return value.slice(0, limit);}
  if (Array.isArray(value)) {return value.map((item) => boundedPostmarkMetadata(item, limit));}
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key.slice(0, 256), boundedPostmarkMetadata(item, limit)]));
  }
  return value;
}

/** Python datetime.isoformat(), preserving Postmark's sub-millisecond precision. */
export function canonicalPostmarkTime(value: string): string | null {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d{1,7}))?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) {return null;}
  // Date.parse normalises invalid calendar days. Python rejects them.
  const local = Date.parse(`${match[1]}T${match[2]}Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== `${match[1]}T${match[2]}`) {return null;}
  const base = Date.parse(`${match[1]}T${match[2]}${match[4] || "Z"}`);
  if (!Number.isFinite(base)) {return null;}
  const micros = (match[3] || "").slice(0, 6).padEnd(6, "0");
  return new Date(base).toISOString().slice(0, 19) + (micros === "000000" ? "" : `.${micros}`) + "+00:00";
}

export function postmarkOpenEventId(messageId: string, canonicalAt: string): string {
  // Match ingest.py: sha256(json.dumps([message_id, kind, canonical_at, null])).
  const identity = [messageId, "opened", canonicalAt, null].map((part) =>
    JSON.stringify(part).replace(/[\u007f-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`),
  ).join(", ");
  return createHash("sha256").update(`[${identity}]`).digest("hex");
}
