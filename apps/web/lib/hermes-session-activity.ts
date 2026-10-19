import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { discoverWorkspaces } from "./workspace";

const run = promisify(execFile);
/** Hermes touches last_activity_at on every stream chunk and tool heartbeat. */
export const ACTIVE_WINDOW_SECONDS = 120;

// Sessions started by a CLI agent (oneshot, `hermes chat`, a spawned worker) run in their own
// process, so the dashboard gateway's active_list never lists them. Their state.db row is the
// only shared signal: not ended, and touched within the window. Read-only, requested IDs only.
const READ_ACTIVE = `
import json, sqlite3, sys, time
from pathlib import Path
path, ids_json, window = sys.argv[1:]
ids = json.loads(ids_json)
if not isinstance(ids, list) or not 0 < len(ids) <= 200:
    raise ValueError("Invalid activity batch")
db = sqlite3.connect(Path(path).as_uri() + "?mode=ro", uri=True, timeout=0.2)
try:
    db.execute("PRAGMA query_only=ON")
    columns = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}
    active = []
    if {"ended_at", "last_activity_at"} <= columns:
        slots = ",".join("?" for _ in ids)
        rows = db.execute("SELECT id FROM sessions WHERE ended_at IS NULL AND last_activity_at >= ? AND id IN (" + slots + ") LIMIT 200", [time.time() - float(window), *ids])
        active = [row[0] for row in rows]
    print(json.dumps(active))
finally:
    db.close()
`;

export async function recentlyActiveSessionIds(profile: string, ids: string[]): Promise<Set<string>> {
  const workspace = discoverWorkspaces().find((item) => item.name === profile);
  if (!workspace?.stateDir || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== "string" || id.length > 2000)) return new Set();
  try {
    const { stdout } = await run("python3", ["-c", READ_ACTIVE, join(workspace.stateDir, "state.db"), JSON.stringify(ids), String(ACTIVE_WINDOW_SECONDS)], { timeout: 2000, maxBuffer: 256 * 1024 });
    const result: unknown = JSON.parse(stdout);
    const allowed = new Set(ids);
    return new Set(Array.isArray(result) ? result.filter((id): id is string => typeof id === "string" && allowed.has(id)) : []);
  } catch { return new Set(); }
}
