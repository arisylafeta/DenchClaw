import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

describe("terminal working directory", () => {
  it("starts terminals from the DenchClaw state root instead of its workspace subdirectory", () => {
    const source = readFileSync(
      join(process.cwd(), "app/workspace/workspace-content.tsx"),
      "utf8",
    );

    expect(source).toContain("cwd={openclawDir ?? workspaceRoot ?? undefined}");
    expect(source).not.toContain("cwd={workspaceRoot ?? undefined}");
  });
});
