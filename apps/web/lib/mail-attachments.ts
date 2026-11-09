import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { queryPg } from "./postgres";
import { mailboxScopeSql } from "./mail-scope";
import { DriveError, driveConnected, uploadToDrive } from "./google-drive";

const run = promisify(execFile);
const CLI = "/usr/local/bin/rebattery-mail";
const ID = /^[A-Za-z0-9_.:-]+$/;

export type MailAttachment = { filename: string; mediaType: string | null; sizeBytes: number | null };
export type AttachmentList = { attachments: MailAttachment[] } | { unavailable: string };

/** Message ids come from the URL and go to a CLI, so only plain id characters pass. */
export function validMessageId(id: string) { return ID.test(id); }

async function owns(messageId: string, userId: string) {
  const rows = await queryPg<{ id: string }>(`select m.id from mail_message m where m.id = $1 and ${mailboxScopeSql('m', '$2')}`, [messageId, userId]);
  return rows.length > 0;
}

function cliError(error: unknown): string {
  const out = (error as { stdout?: string; stderr?: string }) ?? {};
  for (const text of [out.stdout, out.stderr]) {
    try { const parsed = JSON.parse(text ?? ""); const rule = parsed.refused ?? parsed.error ?? parsed.rule ?? parsed.reason; if (typeof rule === "string") return rule; } catch { /* not JSON */ }
  }
  return "attachment_fetch_failed";
}

/** Real (non-inline) files on one message, read live from Gmail through the rebattery-mail CLI. Null when the caller does not own the message. */
export async function listMailAttachments(messageId: string, userId: string): Promise<AttachmentList | null> {
  if (!validMessageId(messageId) || !(await owns(messageId, userId))) return null;
  try {
    const { stdout } = await run(CLI, ["attachment", "list", "--", messageId], { timeout: 60_000, maxBuffer: 4 << 20 });
    const parsed = JSON.parse(stdout) as { attachments: { filename: string; mediaType?: string; sizeBytes?: number; inline?: boolean }[] | { unavailable: string } };
    if (!Array.isArray(parsed.attachments)) return { unavailable: parsed.attachments?.unavailable ?? "unavailable" };
    return { attachments: parsed.attachments.filter((a) => !a.inline).map((a) => ({ filename: a.filename, mediaType: a.mediaType ?? null, sizeBytes: a.sizeBytes ?? null })) };
  } catch (error) { return { unavailable: cliError(error) }; }
}

/** Downloads one attachment by exact filename into a private temp dir and returns the bytes. */
export async function downloadMailAttachment(messageId: string, userId: string, filename: string): Promise<{ bytes: Buffer; filename: string } | { error: string; status: number }> {
  if (!validMessageId(messageId) || !filename || !(await owns(messageId, userId))) return { error: "not_found", status: 404 };
  const dir = await mkdtemp(path.join(os.tmpdir(), "mail-att-"));
  try {
    const target = path.join(dir, "file");
    await run(CLI, ["attachment", "get", "--out", target, "--", messageId, filename], { timeout: 300_000, maxBuffer: 4 << 20 });
    return { bytes: await readFile(target), filename };
  } catch (error) {
    const rule = cliError(error);
    return { error: rule, status: rule.startsWith("attachment_not_found") || rule === "message_not_found" ? 404 : 502 };
  } finally { await rm(dir, { recursive: true, force: true }); }
}

const DRIVE_MAX_BYTES = 100 * 1024 * 1024;

/** Fetches one attachment from Gmail and saves it to the signed-in user's own Google Drive (Relay attachments folder). */
export async function saveMailAttachmentToDrive(messageId: string, user: { id: string; email: string }, filename: string): Promise<{ url: string; name: string; converted: boolean } | { error: string; status: number; message?: string }> {
  if (!validMessageId(messageId) || !filename || !(await owns(messageId, user.id))) return { error: "not_found", status: 404 };
  if (!(await driveConnected(user.email).catch(() => false))) return { error: "drive_not_connected", status: 409, message: "Google Drive isn't connected to this account yet." };
  const listed = await listMailAttachments(messageId, user.id);
  const file = listed && "attachments" in listed ? listed.attachments.find((a) => a.filename === filename) : undefined;
  if (!file) return { error: "attachment_not_found", status: 404 };
  if ((file.sizeBytes ?? 0) > DRIVE_MAX_BYTES) return { error: "too_large", status: 413, message: "That file is over 100 MB. Download it instead." };
  const dir = await mkdtemp(path.join(os.tmpdir(), "mail-drive-"));
  try {
    const target = path.join(dir, "file");
    try {
      await run(CLI, ["attachment", "get", "--out", target, "--", messageId, filename], { timeout: 300_000, maxBuffer: 4 << 20 });
    } catch (error) {
      const rule = cliError(error);
      return { error: rule, status: rule.startsWith("attachment_not_found") || rule === "message_not_found" ? 404 : 502 };
    }
    try {
      return await uploadToDrive(user.email, target, filename);
    } catch (error) {
      if (error instanceof DriveError) return { error: error.code, status: error.code === "drive_not_connected" ? 409 : 502, message: error.message };
      throw error;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
}
