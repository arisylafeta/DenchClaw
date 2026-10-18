import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
const fixtures = vi.hoisted(() => ({ homes: [] as { name: string; stateDir: string }[] }));
vi.mock("./workspace", () => ({ discoverWorkspaces: () => fixtures.homes }));
import { sessionProjectLabels } from "./hermes-session-projects";
let root: string;
beforeEach(() => {
  const scratch = join(process.cwd(), ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "session-projects-"));
  fixtures.homes = ["alpha", "beta"].map((name) => { const stateDir = join(root, name); mkdirSync(stateDir); return { name, stateDir }; });
});
afterEach(() => rmSync(root, { force: true, recursive: true }));
function seed(home: string, rows: unknown[][]) {
  execFileSync("python3", ["-c", `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, git_repo_root TEXT, title TEXT)')
c.executemany('INSERT INTO sessions VALUES (?,?,?,?)',json.loads(sys.argv[2]))
c.commit(); c.close()`, join(home, "state.db"), JSON.stringify(rows)]);
}
it("returns only requested safe leaf labels, prefers repository root and never infers from titles", async () => {
  seed(fixtures.homes[0].stateDir, [
    ["same", "/private/customer/Harbour/src", "/private/customer/Harbour", "Title"],
    ["cwd", "/private/customer/Beacon", null, "Title"],
    ["unknown", null, null, "Working on Harbour"],
    ["home", "/root", null, "Harbour"],
    ["hidden", "/root/.hermes", null, "Harbour"],
    ["unsafe", "/private/customer/secret@email", null, "Harbour"],
    ["unrequested", "/private/customer/Other", null, "Title"],
  ]);
  seed(fixtures.homes[1].stateDir, [["same", "/confidential/Other", null, "Title"]]);
  const path = join(fixtures.homes[0].stateDir, "state.db");
  const before = readFileSync(path);
  const projects = await sessionProjectLabels("alpha", ["same", "cwd", "unknown", "home", "hidden", "unsafe"]);
  expect(projects).toEqual({ same: "Harbour", cwd: "Beacon" });
  expect(JSON.stringify(projects)).not.toMatch(/private|customer|secret|Working|Other|\//);
  expect(await sessionProjectLabels("beta", ["same"])).toEqual({ same: "Other" });
  expect(readFileSync(path)).toEqual(before);
});
it("bounds reads, isolates profiles, parameterizes IDs and never creates missing databases", async () => {
  expect(await sessionProjectLabels("alpha", ["one"])).toEqual({});
  expect(existsSync(join(fixtures.homes[0].stateDir, "state.db"))).toBe(false);
  expect(await sessionProjectLabels("../../alpha", ["one"])).toEqual({});
  expect(await sessionProjectLabels("alpha", Array.from({ length: 201 }, () => "one"))).toEqual({});
  seed(fixtures.homes[0].stateDir, [["x' OR 1=1 --", "/safe/Exact", null, "Title"], ["other", "/safe/Other", null, "Title"]]);
  expect(await sessionProjectLabels("alpha", ["x' OR 1=1 --"])).toEqual({ "x' OR 1=1 --": "Exact" });
});
it("supports cwd-only schemas and falls back honestly when project columns are missing", async () => {
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE sessions (id TEXT, cwd TEXT)'); c.execute(\"INSERT INTO sessions VALUES ('one', '/safe/Legacy')\"); c.commit(); c.close()", join(fixtures.homes[0].stateDir, "state.db")]);
  expect(await sessionProjectLabels("alpha", ["one"])).toEqual({ one: "Legacy" });
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE sessions (id TEXT)'); c.close()", join(fixtures.homes[1].stateDir, "state.db")]);
  expect(await sessionProjectLabels("beta", ["one"])).toEqual({});
});
