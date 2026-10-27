import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { MailDraft } from "./mail-types";

const run = promisify(execFile);
const CLI = "/usr/local/bin/rebattery-mail";

/** Same instant, whether either side is a pg Date or an ISO string. `Date.parse(date)` would drop the milliseconds. */
export function sameVersion(a: string | Date, b: string | Date): boolean {
  const left = new Date(a).getTime(); const right = new Date(b).getTime();
  return Number.isFinite(left) && left === right;
}

export class DraftActionError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}

type Identity = { key: string; signature_text: string | null; signature_html: string | null };
let identityCache: { at: number; list: Identity[] } | null = null;

/** The sending identities with their live signatures. Cached briefly: the panel polls drafts every 10s. */
async function identities(): Promise<Identity[]> {
  if (identityCache && Date.now() - identityCache.at < 60_000) { return identityCache.list; }
  const { stdout } = await run(CLI, ["identity", "list"], { timeout: 30_000, maxBuffer: 4 << 20 });
  const list = (JSON.parse(stdout) as { identities: Identity[] }).identities;
  identityCache = { at: Date.now(), list };
  return list;
}

/** Signature text per identity key, so callers can show a draft's main copy without the signature. */
export async function identitySignatures(): Promise<Map<string, string | null>> {
  return new Map((await identities().catch(() => [])).map((i) => [i.key, i.signature_text]));
}

const escapeHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Same paragraph markup `mail-draft-recopy.py` writes. */
export function textToHtml(body: string): string {
  return body.split("\n\n").map((part) => `<p style="margin:0 0 12px;font-size:14px;line-height:1.5;color:#0A0A0A;">${escapeHtml(part).replace(/\n/g, "<br>")}</p>`).join("");
}

/** Splits a draft's text into the copy a person writes and the identity signature frozen at its end. */
export function splitCopy(bodyText: string | null, signatureText: string | null): { main: string; signed: boolean } {
  const text = bodyText ?? "";
  const signature = (signatureText ?? "").trim();
  const trimmed = text.trimEnd();
  if (signature && trimmed.endsWith(signature)) { return { main: trimmed.slice(0, trimmed.length - signature.length).trimEnd(), signed: true }; }
  return { main: text.trimEnd(), signed: false };
}

export async function editableCopy(draft: Pick<MailDraft, "identity_key" | "body_text">): Promise<{ main: string; signature: string | null }> {
  const identity = (await identities().catch(() => [])).find((i) => i.key === draft.identity_key);
  const { main, signed } = splitCopy(draft.body_text, identity?.signature_text ?? null);
  return { main, signature: signed ? (identity?.signature_text ?? "").trim() : null };
}

function cliError(error: unknown): DraftActionError {
  const out = (error as { stdout?: string; stderr?: string });
  const raw = `${out.stdout ?? ""}`.trim();
  try {
    const parsed = JSON.parse(raw) as { refused?: string; message?: string; reason?: string };
    return new DraftActionError(409, parsed.refused ? `${parsed.refused}${parsed.message && parsed.message !== parsed.refused ? `: ${parsed.message}` : ""}` : "The mail command failed.");
  } catch {
    return new DraftActionError(502, (out.stderr ?? "").trim().split("\n")[0] || "The mail command failed.");
  }
}

/** Applies a subject and/or main-copy edit to an unsent draft through the CLI, so the frozen digest and content policy still apply. */
export async function editDraft(draft: MailDraft, changes: { subject?: string; body?: string }): Promise<void> {
  if (draft.state !== "draft") { throw new DraftActionError(409, "This draft was already sent or is being sent."); }
  const args = ["edit"];
  if (typeof changes.subject === "string" && changes.subject !== (draft.subject ?? "")) { args.push(`--subject=${changes.subject}`); }
  if (typeof changes.body === "string") {
    const identity = (await identities()).find((i) => i.key === draft.identity_key);
    const { main, signed } = splitCopy(draft.body_text, identity?.signature_text ?? null);
    const body = changes.body.replace(/\r\n/g, "\n").replace(/^\n+|\s+$/g, "");
    if (body !== main) {
      if (!body) { throw new DraftActionError(400, "The message cannot be empty."); }
      const signatureText = signed ? (identity?.signature_text ?? "") : "";
      args.push(`--body=${body}${signatureText ? `\n\n${signatureText}` : ""}`, `--html=${textToHtml(body)}${signed ? (identity?.signature_html ?? "") : ""}`);
    }
  }
  if (args.length === 1) { return; }
  try { await run(CLI, [...args, "--", draft.id], { timeout: 60_000, maxBuffer: 4 << 20 }); } catch (error) { throw cliError(error); }
}

/** Sends the current draft. Naming the approver is the CLI's go-ahead, so only a named human and the exact version they saw may send. */
export async function sendDraft(draft: MailDraft, approver: string): Promise<{ sent: boolean }> {
  if (draft.state !== "draft") { throw new DraftActionError(409, "This draft was already sent or is being sent."); }
  if (!draft.to_emails.length) { throw new DraftActionError(400, "Add a recipient before sending."); }
  try {
    // Long timeout on purpose: killing the CLI after its claim leaves a message "sending" that may or may not have gone.
    await run(CLI, ["send", "--apply", "--approved-by", approver, "--", draft.id], { timeout: 600_000, maxBuffer: 4 << 20 });
    return { sent: true };
  } catch (error) { throw cliError(error); }
}
