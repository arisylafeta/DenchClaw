import { describe, expect, it } from "vitest";
import { describeTool } from "./describe";

const tool = (name: string, args: Record<string, unknown>, status: "running" | "done" = "done") => describeTool({ name, args, status });
describe("describeTool", () => {
  it("never exposes a shell command or script body", () => {
    const secret = "python3 -c 'import os; print(os.environ[\"TOKEN\"])'";
    for (const name of ["terminal", "bash", "execute_code"]) {
      expect(tool(name, { command: secret, code: secret }).label).toBe("Ran a shell command");
      expect(tool(name, { command: secret }, "running").label).toBe("Running a shell command");
    }
  });
  it("names files by base name, truncating long ones", () => {
    expect(tool("read_file", { path: "/root/.hermes/workspace/notes/plan.md" }).label).toBe("Read plan.md");
    expect(tool("write_file", { path: "/a/b/out.json" }).label).toBe("Wrote out.json");
    expect(tool("patch", { path: "/a/b/out.json" }, "running").label).toBe("Editing out.json");
    expect(tool("read_file", { path: `/x/${"n".repeat(60)}.md` }).label.length).toBeLessThan(50);
  });
  it("describes web, fetch, delegation and unknown tools in plain words", () => {
    expect(tool("web_search", { query: "used EV battery prices" }).label).toBe("Searched the web for “used EV battery prices”");
    expect(tool("web_extract", { url: "https://www.example.com/a/b?x=1" }).label).toBe("Opened example.com");
    expect(tool("delegate_task", { goal: "secret goal" }).label).toBe("Delegated a task");
    expect(tool("vault_save_login", {}).label).toBe("Used vault save login");
  });
});
