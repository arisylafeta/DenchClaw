import "server-only";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { discoverWorkspaces } from "./workspace";

const run = promisify(execFile);
// API-server omits cwd. Paths stay in the bounded read-only subprocess;
// only leaf labels cross into Node/the browser. Never inspect messages.
const READ_PROJECTS = `
import json, re, sqlite3, sys
from pathlib import Path, PurePosixPath
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
    columns = {row[1] for row in db.execute("PRAGMA table_info(sessions)")}
    fields = [name for name in ('git_repo_root', 'cwd') if name in columns]
    labels = {}
    if fields:
        slots = ','.join('?' for _ in ids)
        rows = db.execute('SELECT id,' + ','.join('substr(' + name + ',1,4096)' for name in fields) + ' FROM sessions WHERE id IN (' + slots + ') LIMIT 200', ids)
        for sid, *paths in rows:
            for value in paths:
                if not isinstance(value, str) or not value.startswith('/') or len(value) >= 4096:
                    continue
                label = PurePosixPath(value).name
                if label.lower() in ('root', 'home', 'workspace', 'workspaces', 'projects', 'tmp', 'app', 'apps') or label.startswith('.'):
                    continue
                if re.fullmatch(r'[\\w][\\w .-]{0,79}', label):
                    labels[sid] = label
                    break
    print(json.dumps(labels))
finally:
    db.close()
`;

/** Explicit metadata only, isolated to requested IDs in a discovered profile. */
export async function sessionProjectLabels(profile: string, ids: string[]): Promise<Record<string, string>> {
  const workspace = discoverWorkspaces().find((item) => item.name === profile);
  if (!workspace?.stateDir || !ids.length || ids.length > 200 || ids.some((id) => typeof id !== "string" || id.length > 2000)) return {};
  try {
    const { stdout } = await run("python3", ["-c", READ_PROJECTS, join(workspace.stateDir, "state.db"), JSON.stringify(ids)], { timeout: 2000, maxBuffer: 256 * 1024 });
    const result: unknown = JSON.parse(stdout);
    if (!result || typeof result !== "object" || Array.isArray(result)) return {};
    const allowed = new Set(ids);
    return Object.fromEntries(Object.entries(result).filter(([id, label]) => allowed.has(id) && typeof label === "string" && /^[\p{L}\p{N}_][\p{L}\p{N}_ .-]{0,79}$/u.test(label)));
  } catch { return {}; }
}
