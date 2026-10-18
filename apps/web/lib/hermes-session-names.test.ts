import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
const fixtures = vi.hoisted(() => ({ homes: [] as { name: string; stateDir: string }[] }));
vi.mock("./workspace", () => ({ discoverWorkspaces: () => fixtures.homes }));
import { sessionDisplayNames } from "./hermes-session-names";
let root: string;
beforeEach(() => {
  const scratch = join(process.cwd(), ".tmp"); mkdirSync(scratch, { recursive: true });
  root = mkdtempSync(join(scratch, "session-names-"));
  fixtures.homes = ["alpha", "beta"].map((name) => { const stateDir = join(root, name); mkdirSync(stateDir); return { name, stateDir }; });
});
afterEach(() => rmSync(root, { force: true, recursive: true }));
function seed(home: string, rows: unknown[][]) {
  execFileSync("python3", ["-c", `import sqlite3,json,sys
c=sqlite3.connect(sys.argv[1])
c.execute('CREATE TABLE sessions (id TEXT PRIMARY KEY, source TEXT, display_name TEXT, origin_json TEXT)')
c.executemany('INSERT INTO sessions VALUES (?,?,?,?)',json.loads(sys.argv[2]))
c.commit(); c.close()`, join(home, "state.db"), JSON.stringify(rows)]);
}
it("projects only requested messaging names, handles malformed origin and keeps profiles isolated without writes", async () => {
  seed(fixtures.homes[0].stateDir, [
    ["same", "discord", " Harbour / #stock ", '{"chat_name":"Fallback","user_id":"private-id","token":"secret-marker"}'],
    ["contact", "whatsapp", "", '{"chat_name":"Harbour contact","user_id":"private-id"}'],
    ["broken", "discord", null, "not json"], ["plain", "web", "Must not use", "{}"],
    ["object", "discord", null, '{"chat_name":{"user_id":"private-id"}}'],
    ["unrequested", "discord", "Not requested", "{}"],
  ]);
  seed(fixtures.homes[1].stateDir, [["same", "discord", "Beta room", "{}"]]);
  const before = readFileSync(join(fixtures.homes[0].stateDir, "state.db"));
  const names = await sessionDisplayNames("alpha", ["same", "contact", "broken", "plain", "object"]);
  expect(names).toEqual({ same: "Harbour / #stock", contact: "Harbour contact" });
  expect(JSON.stringify(names)).not.toMatch(/private-id|secret-marker|origin_json|Fallback|Not requested/);
  expect(await sessionDisplayNames("beta", ["same"])).toEqual({ same: "Beta room" });
  expect(readFileSync(join(fixtures.homes[0].stateDir, "state.db"))).toEqual(before);
});
it("does not create missing databases, accepts no arbitrary profile paths and bounds requests", async () => {
  expect(await sessionDisplayNames("alpha", ["one"])).toEqual({});
  expect(existsSync(join(fixtures.homes[0].stateDir, "state.db"))).toBe(false);
  expect(await sessionDisplayNames("../../alpha", ["one"])).toEqual({});
  expect(await sessionDisplayNames("alpha", Array.from({ length: 201 }, () => "one"))).toEqual({});
  seed(fixtures.homes[0].stateDir, [["x' OR 1=1 --", "discord", "Exact ID", "{}"]]);
  expect(await sessionDisplayNames("alpha", ["x' OR 1=1 --"])).toEqual({ "x' OR 1=1 --": "Exact ID" });
});
it("uses title fallback for older metadata schemas", async () => {
  execFileSync("python3", ["-c", "import sqlite3,sys; c=sqlite3.connect(sys.argv[1]); c.execute('CREATE TABLE sessions (id TEXT)'); c.close()", join(fixtures.homes[0].stateDir, "state.db")]);
  expect(await sessionDisplayNames("alpha", ["one"])).toEqual({});
});
