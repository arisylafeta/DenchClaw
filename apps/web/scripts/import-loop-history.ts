import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { importLoopMonitorSnapshot, type LoopMonitorSnapshot } from "../lib/crm-postgres/loop-monitor-import";
import { pgPool } from "../lib/postgres";

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}
function loadSnapshot(): LoopMonitorSnapshot {
  const snapshotFile = argument("--snapshot-file");
  if (!snapshotFile) throw new Error("Pass --snapshot-file <path> to import an archived loop-history snapshot.");
  return JSON.parse(readFileSync(resolve(snapshotFile), "utf8")) as LoopMonitorSnapshot;
}

try {
  const snapshot = loadSnapshot();
  const imported = await importLoopMonitorSnapshot(snapshot);
  console.log(JSON.stringify({ ok: true, generatedAt: snapshot.generatedAt, imported }));
} finally {
  await pgPool.end();
}
