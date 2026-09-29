import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveOpenClawStateDir } from "./workspace";

export const MAX_TRADE_FILE_BYTES = 50 * 1024 * 1024;

/** Private folder for trade uploads. Never served statically; read only through the files route. */
export function tradeFilesDir(): string {
  return process.env.BULK_TRADE_FILES_DIR?.trim() || join(resolveOpenClawStateDir(), "bulk-trade-files");
}

/** Storage keys are generated ids only, so a key can never point outside the folder. */
const KEY = /^btf_[0-9a-f-]{36}$/;

export async function storeTradeFile(bytes: Uint8Array): Promise<{ id: string; storage_key: string }> {
  const id = `btf_${randomUUID()}`;
  const dir = tradeFilesDir();
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, id), bytes, { mode: 0o600, flag: "wx" });
  return { id, storage_key: id };
}

export async function readTradeFile(storageKey: string): Promise<Buffer> {
  if (!KEY.test(storageKey)) throw new Error("Invalid storage key");
  return readFile(join(tradeFilesDir(), storageKey));
}

export async function discardTradeFile(storageKey: string): Promise<void> {
  if (KEY.test(storageKey)) await rm(join(tradeFilesDir(), storageKey), { force: true });
}
