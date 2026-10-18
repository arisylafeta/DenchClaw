import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { discoverWorkspaces } from "./workspace";

const run = promisify(execFile);
// API-server _session_response omits display_name/origin_json. Project only
// names in SQLite, never load messages or move raw origin/user IDs into Node.
// URI mode=ro plus query_only avoids creating a database or changing sessions.
const READ_NAMES = `
import json, sqlite3, sys
from pathlib import Path
path, ids_json = sys.argv[1:]
ids = json.loads(ids_json)
if not isinstance(ids, list) or not 0 < len(ids) <= 200:
    raise ValueError("Invalid metadata batch")
db = sqlite3.connect(Path(path).as_uri() + "?mode=ro", uri=True, timeout=0.2)
try:
    db.execute("PRAGMA query_only=ON")
    budget = [0]
    def progress():
        budget[0] += 1
        return int(budget[0] > 1000)
    db.set_progress_handler(progress, 1000)
    slots = ",".join("?" for _ in ids)
    rows = db.execute("""SELECT id, substr(display_name, 1, 200),
        CASE WHEN json_valid(origin_json) THEN CASE WHEN json_type(origin_json, '$.chat_name') = 'text'
            THEN substr(json_extract(origin_json, '$.chat_name'), 1, 200) END END
        FROM sessions WHERE id IN (""" + slots + """ )
        AND source IN ('discord','whatsapp','telegram','slack','signal','matrix','mattermost','sms','email') LIMIT 200""", ids)
    names = {}
    for sid, display, chat in rows:
        for value in (display, chat):
            if isinstance(value, str):
                value = " ".join(value.split()).strip()
                if value:
                    names[sid] = value
                    break
    print(json.dumps(names))
finally:
    db.close()
`;

/** Only requested IDs in a discovered profile home; missing/old DBs use titles. */
export async function sessionDisplayNames(profile: string, ids: string[]): Promise<Record<string, string>> {
  const workspace = discoverWorkspaces().find((item) => item.name === profile);
  if (!workspace?.stateDir || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== "string" || id.length > 2000)) return {};
  try {
    const { stdout } = await run("python3", ["-c", READ_NAMES, join(workspace.stateDir, "state.db"), JSON.stringify(ids)], { timeout: 2000, maxBuffer: 256 * 1024 });
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || Array.isArray(result)) return {};
    const allowed = new Set(ids);
    return Object.fromEntries(Object.entries(result).filter(([id, name]) => allowed.has(id) && typeof name === "string" && name.length > 0 && name.length <= 200));
  } catch { return {}; }
}
