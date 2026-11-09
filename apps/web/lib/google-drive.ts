import "server-only";
import { execFile } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * Saves files to a user's own Google Drive through the gog CLI (the same Google login Relay already uses for Gmail),
 * and connects Drive to that login when it is missing. Every Drive call is limited to gog's drive commands.
 */

const run = promisify(execFile);
const GOG = process.env.GOG_BIN || "/usr/local/bin/gog";
const KEYRING_PASSWORD_FILE = "/root/.hermes/workspace/.secrets/gog-keyring-password";
export const DRIVE_FOLDER = "Relay attachments";
/** The login keeps everything it already had (Gmail read, labels and send; Calendar) and gains Drive. */
const SERVICES = "gmail,calendar,drive";
const EXTRA_SCOPES = "https://www.googleapis.com/auth/gmail.send";
const FOLDER_MIME = "application/vnd.google-apps.folder";
/** Scopes Relay mail depends on, plus Drive. A login missing any of them is rolled back. */
const REQUIRED_SCOPES = ["https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/drive"];
const KEYRING_DIR = process.env.GOG_KEYRING_DIR || join(process.env.HOME || "/root", ".config/gogcli/keyring");

/** gog names each stored login `_gogcli_key_v1_<base64 of "token:[client:]email">`. */
function keyName(name: string): string {
  try { return Buffer.from(name.replace(/^_gogcli_key_v1_/, "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"); } catch { return ""; }
}

/** The stored (encrypted) logins, so a bad re-consent can be undone byte for byte. Fails closed: without a readable
 * snapshot holding this account's login, connecting is refused rather than run without a way back. */
function snapshotKeyring(email: string): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  try {
    for (const name of readdirSync(KEYRING_DIR)) { const path = join(KEYRING_DIR, name); if (statSync(path).isFile()) files.set(name, readFileSync(path)); }
  } catch {
    throw new DriveError("drive_failed", "Couldn't back up the current Google login, so nothing was changed.");
  }
  if (![...files.keys()].some((name) => keyName(name).toLowerCase().endsWith(`:${email.toLowerCase()}`))) {
    throw new DriveError("drive_failed", "Couldn't find the current Google login to back up, so nothing was changed.");
  }
  return files;
}

/** Puts the keyring back exactly: the old files restored, files added since removed. */
function restoreKeyring(before: Map<string, Buffer>): void {
  try { for (const name of readdirSync(KEYRING_DIR)) if (!before.has(name)) rmSync(join(KEYRING_DIR, name), { force: true }); } catch { /* restore below still runs */ }
  for (const [name, bytes] of before) writeFileSync(join(KEYRING_DIR, name), bytes, { mode: 0o600 });
}

/** One connect at a time on this server, so two snapshots never restore over each other. */
let connecting: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = connecting.then(task, task);
  connecting = next.catch(() => undefined);
  return next;
}

export class DriveError extends Error {
  constructor(public readonly code: "drive_not_connected" | "drive_failed" | "bad_account" | "bad_redirect", message: string) { super(message); }
}

function gogEnv(): NodeJS.ProcessEnv {
  if (process.env.GOG_KEYRING_PASSWORD) return process.env;
  try { return { ...process.env, GOG_KEYRING_PASSWORD: readFileSync(process.env.GOG_KEYRING_PASSWORD_FILE || KEYRING_PASSWORD_FILE, "utf8").trim() }; } catch { return process.env; }
}

async function gog(args: string[], timeout = 120_000): Promise<unknown> {
  try {
    const { stdout } = await run(GOG, [...args, "--json", "--no-input"], { env: gogEnv(), timeout, maxBuffer: 8 << 20 });
    return stdout.trim() ? JSON.parse(stdout) : {};
  } catch (error) {
    const text = `${(error as { stderr?: string }).stderr ?? ""} ${(error as { stdout?: string }).stdout ?? ""}`;
    if (/insufficient(Permissions| authentication scopes)|invalid_grant|no (refresh )?token|not authorized/i.test(text)) {
      throw new DriveError("drive_not_connected", "Google Drive isn't connected to this account yet.");
    }
    throw new DriveError("drive_failed", "Google Drive didn't accept that. Try again.");
  }
}

const drive = (account: string, args: string[], timeout?: number) => gog(["--account", account, "--enable-commands", "drive", "drive", ...args], timeout);

/** Accounts the server already holds a Google login for. Connecting Drive never adds a new account. */
async function knownAccounts(): Promise<{ email: string; scopes: string[] }[]> {
  const out = await gog(["auth", "list"]) as { accounts?: { email?: string; scopes?: string[] }[] };
  return (out.accounts ?? []).filter((a): a is { email: string; scopes?: string[] } => typeof a.email === "string").map((a) => ({ email: a.email.toLowerCase(), scopes: a.scopes ?? [] }));
}

async function requireKnown(email: string) {
  const account = (await knownAccounts()).find((a) => a.email === email.toLowerCase());
  if (!account) throw new DriveError("bad_account", "This account has no Google login on the server.");
  return account;
}

export async function driveConnected(email: string): Promise<boolean> {
  const account = (await knownAccounts()).find((a) => a.email === email.toLowerCase());
  return !!account?.scopes.some((s) => s === "https://www.googleapis.com/auth/drive" || s === "https://www.googleapis.com/auth/drive.file");
}

/** Step 1 of connecting: Google's consent page for this account, asking for Drive on top of what it already has. */
export async function driveConnectUrl(email: string): Promise<string> {
  await requireKnown(email);
  const out = await gog(["auth", "add", email.toLowerCase(), "--remote", "--step", "1", "--services", SERVICES, "--extra-scopes", EXTRA_SCOPES, "--force-consent"]) as { auth_url?: string };
  if (!out.auth_url?.startsWith("https://accounts.google.com/")) throw new DriveError("drive_failed", "Couldn't start the Google sign-in. Try again.");
  return out.auth_url;
}

/** The address Google sent the browser to after consent: a local callback carrying a one-time code. */
export function validRedirect(url: string): boolean {
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" && (u.hostname === "127.0.0.1" || u.hostname === "localhost") && u.pathname === "/oauth2/callback" && !!u.searchParams.get("code") && !!u.searchParams.get("state");
  } catch { return false; }
}

/** Step 2: exchanges the code for the new login. It must keep every scope the account had and carry Gmail send,
 * Gmail modify and Drive; otherwise, or if checking fails, the previous login is put back byte for byte. */
export function driveConnectFinish(email: string, redirectUrl: string): Promise<void> {
  return serial(async () => {
    const account = await requireKnown(email);
    if (!validRedirect(redirectUrl)) throw new DriveError("bad_redirect", "That isn't the address Google opened. Copy the whole address from the tab that didn't load.");
    const before = snapshotKeyring(email);
    try {
      await gog(["auth", "add", email.toLowerCase(), "--remote", "--step", "2", "--auth-url", redirectUrl.trim(), "--services", SERVICES, "--extra-scopes", EXTRA_SCOPES]);
    } catch {
      restoreKeyring(before);
      throw new DriveError("drive_failed", "Google didn't accept that sign-in. Codes last about 10 minutes: start again.");
    }
    try {
      const scopes = (await knownAccounts()).find((a) => a.email === email.toLowerCase())?.scopes ?? [];
      const missing = [...new Set([...REQUIRED_SCOPES, ...account.scopes])].filter((s) => !scopes.includes(s));
      if (missing.length) {
        // Google lets you untick boxes on the consent page; a login without Gmail would stop Relay mail.
        throw new DriveError("drive_not_connected", `Some boxes were unticked on Google's page (${missing.map((s) => s.replace("https://www.googleapis.com/auth/", "")).join(", ")}), so nothing changed. Start again and leave every box ticked.`);
      }
    } catch (error) {
      // Any failure here, including a failed scope check, leaves the old login in place.
      restoreKeyring(before);
      if (error instanceof DriveError && error.code === "drive_not_connected") throw error;
      throw new DriveError("drive_failed", "Couldn't check the new Google login, so the old one was kept. Try again.");
    }
  });
}

const CONVERT: Record<string, "doc" | "sheet" | "slides"> = {
  docx: "doc", doc: "doc", odt: "doc", rtf: "doc",
  xlsx: "sheet", xls: "sheet", ods: "sheet", csv: "sheet",
  pptx: "slides", ppt: "slides", odp: "slides",
};

/** Office files become Google Docs, Sheets or Slides so they open for editing; PDFs and images upload as they are. */
const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", doc: "application/msword", odt: "application/vnd.oasis.opendocument.text", rtf: "application/rtf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xls: "application/vnd.ms-excel", ods: "application/vnd.oasis.opendocument.spreadsheet", csv: "text/csv",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation", ppt: "application/vnd.ms-powerpoint", odp: "application/vnd.oasis.opendocument.presentation",
};

export function convertTarget(filename: string): "doc" | "sheet" | "slides" | null {
  return CONVERT[(filename.split(".").pop() ?? "").toLowerCase()] ?? null;
}

function firstFile(out: unknown): { id?: string; webViewLink?: string; mimeType?: string } | undefined {
  const o = out as { files?: unknown[]; file?: unknown; id?: string };
  if (Array.isArray(o?.files)) return o.files[0] as { id?: string };
  if (o?.file && typeof o.file === "object") return o.file as { id?: string };
  const folder = (out as { folder?: unknown })?.folder;
  if (folder && typeof folder === "object") return folder as { id?: string };
  return o?.id ? o as { id?: string } : undefined;
}

export function openUrl(file: { id: string; webViewLink?: string; mimeType?: string }): string {
  if (file.webViewLink?.startsWith("https://")) return file.webViewLink;
  const kind = file.mimeType === "application/vnd.google-apps.document" ? "document" : file.mimeType === "application/vnd.google-apps.spreadsheet" ? "spreadsheets" : file.mimeType === "application/vnd.google-apps.presentation" ? "presentation" : null;
  return kind ? `https://docs.google.com/${kind}/d/${file.id}/edit` : `https://drive.google.com/file/d/${file.id}/view`;
}

async function folderId(account: string): Promise<string> {
  const found = firstFile(await drive(account, ["search", `name = '${DRIVE_FOLDER}' and mimeType = '${FOLDER_MIME}' and 'root' in parents and trashed = false`, "--raw-query", "--max", "1"]));
  if (found?.id) return found.id;
  const made = firstFile(await drive(account, ["mkdir", DRIVE_FOLDER]));
  if (!made?.id) throw new DriveError("drive_failed", "Couldn't make the Relay attachments folder in Drive.");
  return made.id;
}

/** Uploads one local file into the account's "Relay attachments" folder and returns the link that opens it. */
export async function uploadToDrive(account: string, localPath: string, filename: string): Promise<{ url: string; name: string; converted: boolean }> {
  const parent = await folderId(account);
  const target = convertTarget(filename);
  const name = target ? filename.replace(/\.[^.]+$/, "") : filename;
  // The temp file has no extension, so name the source type explicitly: Drive converts from it.
  const mime = target ? MIME[(filename.split(".").pop() ?? "").toLowerCase()] : null;
  const out = await drive(account, ["upload", localPath, "--name", name, "--parent", parent, ...(target && mime ? ["--mime-type", mime, "--convert-to", target] : [])], 300_000);
  const file = firstFile(out);
  if (!file?.id) throw new DriveError("drive_failed", "Drive didn't confirm the upload. Check the Relay attachments folder.");
  return { url: openUrl({ id: file.id, webViewLink: file.webViewLink, mimeType: file.mimeType }), name, converted: !!target };
}
