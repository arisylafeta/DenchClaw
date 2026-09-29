import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type EmailDraft = { to: string[]; subject: string; body: string };
export type CreatedDraft = { draftId: string | null; messageId: string | null };

const EMAIL = /^[^\s@<>,;"]+@[^\s@<>,;"]+\.[^\s@<>,;"]+$/;

/** Validates a draft request. Recipients may be empty; Alex can add them in Gmail. */
export function parseEmailDraft(body: unknown): { value: EmailDraft } | { error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "Body must be an object." };
  const input = body as Record<string, unknown>;
  const to = typeof input.to === "string" ? input.to.split(/[,;]/).map((address) => address.trim()).filter(Boolean) : [];
  const bad = to.find((address) => !EMAIL.test(address));
  if (bad) return { error: `${bad} is not an email address.` };
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const text = typeof input.body === "string" ? input.body : "";
  if (!subject) return { error: "Add a subject." };
  if (!text.trim()) return { error: "Add a message." };
  return { value: { to, subject, body: text } };
}

/**
 * Creates a Gmail draft in the given account through the gog CLI. The CLI is limited to draft
 * creation and blocked from sending, so this can never send mail.
 */
/** Root-only file holding gog's keyring password; gog cannot prompt for it in a server process. */
const KEYRING_PASSWORD_FILE = "/root/.hermes/workspace/.secrets/gog-keyring-password";

function gogEnv(): NodeJS.ProcessEnv {
  if (process.env.GOG_KEYRING_PASSWORD) return process.env;
  const file = process.env.GOG_KEYRING_PASSWORD_FILE || KEYRING_PASSWORD_FILE;
  try {
    return { ...process.env, GOG_KEYRING_PASSWORD: readFileSync(file, "utf8").trim() };
  } catch {
    return process.env;
  }
}

export function createGmailDraft(account: string, draft: EmailDraft): Promise<CreatedDraft> {
  const args = [
    "--account", account,
    "--gmail-no-send",
    "--enable-commands-exact", "gmail.drafts.create",
    "--no-input",
    "--json",
    "gmail", "drafts", "create",
    "--subject", draft.subject,
    "--body-file", "-",
  ];
  if (draft.to.length) args.push("--to", draft.to.join(","));

  return new Promise((resolve, reject) => {
    const child = execFile(process.env.GOG_BIN || "gog", args, { env: gogEnv(), timeout: 30_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error("Gmail did not accept the draft. Check that this account is connected to gog."));
      try {
        const parsed = JSON.parse(stdout) as Record<string, unknown>;
        // gog has returned both {id, message: {id}} and {draftId, messageId}; accept either.
        const result = (parsed.draft ?? parsed) as { id?: unknown; draftId?: unknown; messageId?: unknown; message?: { id?: unknown } };
        const text = (...values: unknown[]) => (values.find((value) => typeof value === "string") as string | undefined) ?? null;
        resolve({ draftId: text(result.id, result.draftId), messageId: text(result.message?.id, result.messageId) });
      } catch {
        resolve({ draftId: null, messageId: null });
      }
    });
    child.stdin?.end(draft.body);
  });
}

/** Link to the draft in Gmail, or to the account's drafts folder. */
export function gmailDraftUrl(account: string, messageId: string | null): string {
  const base = `https://mail.google.com/mail/u/?authuser=${encodeURIComponent(account)}#drafts`;
  return messageId ? `${base}?compose=${encodeURIComponent(messageId)}` : base;
}

function gog(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.env.GOG_BIN || "gog", args, { env: gogEnv(), timeout: 60_000, maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(new Error("Gmail did not answer. Check that this account is connected to gog."));
      else resolve(stdout);
    });
    child.stdin?.end(stdin ?? "");
  });
}

type Part = { filename?: string; body?: { attachmentId?: string }; parts?: Part[] };

function findAttachment(part: Part | undefined, fileName: string): string | null {
  if (!part) return null;
  if (part.filename === fileName && part.body?.attachmentId) return part.body.attachmentId;
  for (const child of part.parts ?? []) {
    const found = findAttachment(child, fileName);
    if (found) return found;
  }
  return null;
}

/**
 * Downloads one attachment, read-only. Gmail attachment ids change between reads, so the message
 * is read again and the attachment found by file name.
 */
export async function fetchGmailAttachment(account: string, messageId: string, fileName: string, _staleId: string | null): Promise<Buffer> {
  const base = ["--account", account, "--readonly", "--no-input"];
  const message = JSON.parse(await gog([...base, "--json", "gmail", "get", messageId])) as { message?: { payload?: Part }; payload?: Part };
  const attachmentId = findAttachment(message.message?.payload ?? message.payload, fileName);
  if (!attachmentId) throw new Error(`${fileName} is no longer on that email.`);
  const dir = mkdtempSync(join(tmpdir(), "bt-attachment-"));
  try {
    const out = join(dir, "file");
    await gog([...base, "gmail", "attachment", messageId, attachmentId, "--out", out]);
    return readFileSync(out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
