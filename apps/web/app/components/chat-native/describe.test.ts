import { describe, expect, it } from "vitest";
import { describeTool } from "./describe";

const tool = (name: string, args: Record<string, unknown>, status: "running" | "done" = "done") => describeTool({ name, args, status }).label;
describe("describeTool", () => {
  it("never exposes a shell command, script body or arguments", () => {
    const secret = "TOKEN=abc123 python3 -c 'print(open(\"/root/secret\").read())'";
    for (const name of ["terminal", "bash", "execute_code"]) {
      const label = tool(name, { command: secret, code: secret });
      expect(label).not.toMatch(/abc123|secret|print/);
    }
    expect(tool("terminal", { command: secret })).toBe("Ran a Python script");
  });
  it("classifies real terminal programs", () => {
    expect(tool("terminal", { command: "cd /repo && git status --short" })).toBe("Ran git status");
    expect(tool("terminal", { command: "FOO=1 psql -c 'select 1'" })).toBe("Queried the database");
    expect(tool("terminal", { command: "pnpm --dir apps/web build" })).toBe("Ran pnpm build");
    expect(tool("terminal", { command: "mkdir -p /tmp/x" })).toBe("Managed files");
    expect(tool("terminal", { command: "frobnicate --now" }, "running")).toBe("Running a shell command");
  });
  it("names files by base name and counts patched files", () => {
    expect(tool("read_file", { path: "/root/.hermes/workspace/notes/plan.md" })).toBe("Read plan.md");
    expect(tool("write_file", { path: "/a/b/out.json" })).toBe("Wrote out.json");
    expect(tool("patch", { mode: "patch", patch: "*** Begin Patch\n*** Update File: /a/b/x.ts\n@@\n-a\n+b\n*** End Patch" })).toBe("Edited x.ts");
    expect(tool("patch", { patch: "*** Add File: /a/new.ts\n+x" })).toBe("Created new.ts");
    expect(tool("patch", { patch: "*** Update File: /a/1.ts\n*** Update File: /a/2.ts" }, "running")).toBe("Editing 2 files");
    expect(tool("read_file", { path: `/x/${"n".repeat(60)}.md` }).length).toBeLessThan(50);
  });
  it("describes searches, web, skills and orchestration tools", () => {
    expect(tool("search_files", { target: "content", pattern: "handleSubmit", path: "/repo/apps/web" })).toBe("Searched for “handleSubmit” in web");
    expect(tool("search_files", { target: "files", pattern: "*.test.ts" })).toBe("Searched files matching “*.test.ts”");
    expect(tool("web_search", { query: "used EV battery prices" })).toBe("Searched the web for “used EV battery prices”");
    expect(tool("web_extract", { urls: ["https://www.example.com/a?x=1", "https://b.dev"] })).toBe("Read example.com +1 more");
    expect(tool("skill_view", { name: "planning" })).toBe("Loaded the planning skill");
    expect(tool("todo", { merge: true, todos: [] })).toBe("Updated the task list");
    expect(tool("delegate_task", { action: "steer", message: "private", subagent_id: "a" })).toBe("Steered a subagent");
    expect(tool("delegate_task", { goal: "secret goal" })).toBe("Delegated a task");
    expect(tool("delegate_task", { tasks: [{}, {}, {}] })).toBe("Delegated 3 tasks");
    expect(tool("process", { action: "poll" })).toBe("Checked a background process");
  });
  it("unwraps tool_call batches and MCP tool names", () => {
    expect(tool("tool_call", { calls: [{ name: "mcp__supabase__execute_sql", arguments: { query: "select secret" } }] })).toBe("Queried Supabase");
    expect(tool("tool_call", { calls: [{ name: "mcp__supabase__execute_sql", arguments: {} }, { name: "mcp__supabase__execute_sql", arguments: {} }] })).toBe("Queried Supabase ×2");
    expect(tool("tool_call", { calls: [{ name: "mcp__code__read_file", arguments: { path: "/a/b.ts" } }, { name: "mcp__sentry__search_errors", arguments: {} }] })).toBe("Ran 2 tool calls");
    expect(tool("mcp__denchclaw__crm_search_people", { q: "x" })).toBe("Searched CRM people");
    expect(tool("mcp__code__read_file", { path: "/a/b.ts" })).toBe("Read b.ts");
    expect(tool("mcp__weird__thing_done", {})).toBe("Used weird · thing done");
    expect(tool("vault_save_login", {})).toBe("Used vault save login");
  });
});
