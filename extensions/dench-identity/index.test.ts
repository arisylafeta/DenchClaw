import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import register, { buildIdentityPrompt, resolveWorkspaceDir } from "./index.ts";

describe("buildIdentityPrompt", () => {
  const workspaceDir = "/home/user/workspace";

  it("keeps the core DenchClaw workspace contract", () => {
    const prompt = buildIdentityPrompt(workspaceDir);

    expect(prompt).toContain("You are **DenchClaw**");
    expect(prompt).toContain("always use **DenchClaw** (not OpenClaw)");
    expect(prompt).toContain(`**Root**: \`${workspaceDir}\``);
    expect(prompt).toContain(path.join(workspaceDir, ".openclaw/web-chat/"));
    expect(prompt).toContain(path.join(workspaceDir, "skills", "crm", "SKILL.md"));
    expect(prompt).toContain("elevated: true");
  });

  it("routes external services through Composio before Monid", () => {
    const prompt = buildIdentityPrompt(workspaceDir);

    expect(prompt).toContain(path.join(workspaceDir, "skills", "composio-cli", "SKILL.md"));
    expect(prompt).toContain('composio search "<use case>"');
    expect(prompt).toContain("composio link <toolkit> --no-browser --no-wait");
    expect(prompt).toContain("composio execute <TOOL_SLUG>");
    expect(prompt).toContain(path.join(workspaceDir, "skills", "monid", "SKILL.md"));
    expect(prompt).toContain("External service routing: Composio first, Monid second");
    expect(prompt).toContain('monid discover -q "<task>"');
    expect(prompt.indexOf('composio search "<task>"')).toBeLessThan(
      prompt.indexOf('monid discover -q "<task>"'),
    );
    expect(prompt).not.toContain("dench://composio");
  });
});

describe("resolveWorkspaceDir", () => {
  it("returns a trimmed configured workspace", () => {
    expect(
      resolveWorkspaceDir({ config: { agents: { defaults: { workspace: " /home/user/ws " } } } }),
    ).toBe("/home/user/ws");
  });

  it("returns undefined for missing or invalid workspace values", () => {
    expect(resolveWorkspaceDir(null)).toBeUndefined();
    expect(resolveWorkspaceDir({})).toBeUndefined();
    expect(
      resolveWorkspaceDir({ config: { agents: { defaults: { workspace: "   " } } } }),
    ).toBeUndefined();
    expect(
      resolveWorkspaceDir({ config: { agents: { defaults: { workspace: 42 } } } }),
    ).toBeUndefined();
  });
});

describe("register", () => {
  it("injects the identity prompt without registering integration adapter tools", () => {
    const handlerByEvent = new Map<string, (...args: any[]) => unknown>();
    const api = {
      config: { agents: { defaults: { workspace: "/home/user/ws" } }, plugins: { entries: {} } },
      on: vi.fn((event: string, handler: (...args: any[]) => unknown) => {
        handlerByEvent.set(event, handler);
      }),
      registerTool: vi.fn(),
    };

    register(api as any);

    expect(api.registerTool).not.toHaveBeenCalled();
    const result = handlerByEvent.get("before_prompt_build")?.({}, {});
    expect(result).toEqual({ prependSystemContext: buildIdentityPrompt("/home/user/ws") });
  });

  it("does nothing when disabled", () => {
    const api = {
      config: { plugins: { entries: { "dench-identity": { config: { enabled: false } } } } },
      on: vi.fn(),
      registerTool: vi.fn(),
    };

    register(api as any);

    expect(api.on).not.toHaveBeenCalled();
    expect(api.registerTool).not.toHaveBeenCalled();
  });
});
