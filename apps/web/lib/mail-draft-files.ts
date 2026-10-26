import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

const STORE = process.env.REBATTERY_MAIL_ATTACHMENT_STORE ?? "/srv/rebattery-data/mail-attachments";
/** Types a browser may show inline as a thumbnail. SVG is excluded: it can carry script. */
export const INLINE_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const SHA256 = /^[a-f0-9]{64}$/;

export type DraftFile = { bytes: Buffer; filename: string; mediaType: string | null };

/** Reads a stored draft attachment. The path comes from the database, must stay inside the store, and must still match its recorded checksum. */
export async function readDraftFile(entry: { path: string; filename: string; mediaType: string | null }, sha256: string, store = STORE): Promise<DraftFile | null> {
  try {
    const [root, file] = await Promise.all([realpath(store), realpath(entry.path)]);
    if (!file.startsWith(root + path.sep)) { return null; }
    const bytes = await readFile(file);
    if (createHash("sha256").update(bytes).digest("hex") !== sha256) { return null; }
    return { bytes, filename: entry.filename, mediaType: entry.mediaType };
  } catch { return null; }
}

export function fileResponse(file: DraftFile, inline: boolean): Response {
  const safe = file.filename.replace(/[^\x20-\x7e]|["\\]/g, "_");
  const showInline = inline && !!file.mediaType && INLINE_IMAGE_TYPES.has(file.mediaType);
  return new Response(new Uint8Array(file.bytes), { headers: {
    "content-type": showInline ? file.mediaType! : "application/octet-stream",
    "content-disposition": `${showInline ? "inline" : "attachment"}; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    "x-content-type-options": "nosniff", "content-security-policy": "default-src 'none'; sandbox", "cache-control": "private, max-age=300",
  } });
}
