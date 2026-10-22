import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const fixtures = vi.hoisted(() => ({ homes: [] as { name: string; stateDir: string }[] }));
vi.mock("./workspace", () => ({ discoverWorkspaces: () => fixtures.homes }));
import { recentSessionActivity } from "./hermes-session-activity";
let root: string;
beforeEach(() => {
  const scratch = join(process.cwd(), ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "session-activity-"));
  const stateDir = join(root, "alpha"); mkdirSync(stateDir);
  fixtures.homes = [{ name: "alpha", stateDir }];
});
afterEach(() => rmSync(root, { force: true, recursive: true }));
function seed(rows: unknown[][]) {
  execFileSync("python3", ["-c", `import sqlite3,json,sys,time
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, ended_at REAL, last_activity_at REAL, last_activity_description TEXT)')
now=time.time()
c.executemany('INSERT INTO sessions VALUES (?,?,?,?)',[[i, e, None if a is None else now-a, (r[3] if len(r) > 3 else None)] for r in json.loads(sys.argv[2]) for i,e,a in [r[:3]]])
c.commit(); c.close()`, join(fixtures.homes[0].stateDir, "state.db"), JSON.stringify(rows)]);
}
it("marks a not-ended session touched recently as active, even when it runs in another process", async () => {
  seed([["oneshot-live", null, 5], ["stale-crashed", null, 3600], ["finished", 100, 5], ["never-touched", null, null], ["unrequested", null, 1]]);
  const active = await recentSessionActivity("alpha", ["oneshot-live", "stale-crashed", "finished", "never-touched", "missing"]);
  expect([...active]).toEqual([["oneshot-live", "working"]]);
});
it("classifies a heartbeat stamped by a background subagent as background, not the session's own work", async () => {
  seed([["parent", null, 5, "delegate_task: subagent receiving stream response (iteration 28/250)"], ["own", null, 5, "terminal: running"]]);
  const active = await recentSessionActivity("alpha", ["parent", "own"]);
  expect(Object.fromEntries(active)).toEqual({ parent: "background", own: "working" });
});
it("degrades to nothing for unknown profiles, missing databases and older schemas", async () => {
  expect((await recentSessionActivity("beta", ["x"])).size).toBe(0);
  expect((await recentSessionActivity("alpha", ["x"])).size).toBe(0);
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE sessions (id TEXT)'); c.execute(\"INSERT INTO sessions VALUES ('x')\"); c.commit()", join(fixtures.homes[0].stateDir, "state.db")]);
  expect((await recentSessionActivity("alpha", ["x"])).size).toBe(0);
});
