import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { discoverWorkspaces } from "./workspace";
import { goalFromState, type GoalSnapshot } from "./hermes-chat/goal";

const run = promisify(execFile);
// Hermes persists GoalState in state_meta; read one key, read-only, bounded.
const READ_GOAL = `
import json, sqlite3, sys
from pathlib import Path
path, sid = sys.argv[1:]
db = sqlite3.connect(Path(path).as_uri() + "?mode=ro", uri=True, timeout=0.2)
try:
    db.execute("PRAGMA query_only=ON")
    if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='state_meta'").fetchone():
        print("null")
    else:
        row = db.execute("SELECT substr(value,1,65536) FROM state_meta WHERE key=?", ("goal:" + sid,)).fetchone()
        print(row[0] if row and row[0] else "null")
finally:
    db.close()
`;

/** The persisted goal of an idle session, when no live runtime can answer session.control.read. */
export async function persistedSessionGoal(profile: string, storedId: string): Promise<GoalSnapshot | null> {
  const workspace = discoverWorkspaces().find((item) => item.name === profile);
  if (!workspace?.stateDir || !/^[\w.-]{1,200}$/.test(storedId)) return null;
  try {
    const { stdout } = await run("python3", ["-c", READ_GOAL, join(workspace.stateDir, "state.db"), storedId], { timeout: 2000, maxBuffer: 128 * 1024 });
    return goalFromState(JSON.parse(stdout));
  } catch { return null; }
}
