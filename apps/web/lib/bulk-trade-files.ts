import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

export const MAX_TRADE_FILE_BYTES = 50 * 1024 * 1024;

/**
 * Private folder for trade uploads, set by BULK_TRADE_FILES_DIR. There is no default: a guessed
 * location could sit inside a git repository or outside the backups. Never served statically.
 */
export function tradeFilesDir(): string | null {
  const dir = process.env.BULK_TRADE_FILES_DIR?.trim();
  return dir && isAbsolute(dir) ? dir : null;
}

function requireDir(): string {
  const dir = tradeFilesDir();
  if (!dir) throw new Error("File storage is not configured (BULK_TRADE_FILES_DIR).");
  return dir;
}

/** Storage keys are generated ids only, so a key can never point outside the folder. */
const KEY = /^btf_[0-9a-f-]{36}$/;

export async function storeTradeFile(bytes: Uint8Array): Promise<{ id: string; storage_key: string }> {
  const id = `btf_${randomUUID()}`;
  const dir = requireDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, id), bytes, { mode: 0o600, flag: "wx" });
  return { id, storage_key: id };
}

export async function readTradeFile(storageKey: string): Promise<Buffer> {
  if (!KEY.test(storageKey)) throw new Error("Invalid storage key");
  return readFile(join(requireDir(), storageKey));
}

export async function discardTradeFile(storageKey: string): Promise<void> {
  const dir = tradeFilesDir();
  if (dir && KEY.test(storageKey)) await rm(join(dir, storageKey), { force: true });
}
