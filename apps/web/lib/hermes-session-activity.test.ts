import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
const fixtures = vi.hoisted(() => ({ homes: [] as { name: string; stateDir: string }[] }));
vi.mock("./workspace", () => ({ discoverWorkspaces: () => fixtures.homes }));
import { recentlyActiveSessionIds } from "./hermes-session-activity";
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
c.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, ended_at REAL, last_activity_at REAL)')
now=time.time()
c.executemany('INSERT INTO sessions VALUES (?,?,?)',[[i, e, None if a is None else now-a] for i,e,a in json.loads(sys.argv[2])])
c.commit(); c.close()`, join(fixtures.homes[0].stateDir, "state.db"), JSON.stringify(rows)]);
}
it("marks a not-ended session touched recently as active, even when it runs in another process", async () => {
  seed([["oneshot-live", null, 5], ["stale-crashed", null, 3600], ["finished", 100, 5], ["never-touched", null, null], ["unrequested", null, 1]]);
  const active = await recentlyActiveSessionIds("alpha", ["oneshot-live", "stale-crashed", "finished", "never-touched", "missing"]);
  expect([...active]).toEqual(["oneshot-live"]);
});
it("degrades to nothing for unknown profiles, missing databases and older schemas", async () => {
  expect((await recentlyActiveSessionIds("beta", ["x"])).size).toBe(0);
  expect((await recentlyActiveSessionIds("alpha", ["x"])).size).toBe(0);
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE sessions (id TEXT)'); c.execute(\"INSERT INTO sessions VALUES ('x')\"); c.commit()", join(fixtures.homes[0].stateDir, "state.db")]);
  expect((await recentlyActiveSessionIds("alpha", ["x"])).size).toBe(0);
});
