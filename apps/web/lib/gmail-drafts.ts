import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

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
        const result = (parsed.draft ?? parsed) as { id?: unknown; message?: { id?: unknown } };
        resolve({
          draftId: typeof result.id === "string" ? result.id : null,
          messageId: typeof result.message?.id === "string" ? result.message.id : null,
        });
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
