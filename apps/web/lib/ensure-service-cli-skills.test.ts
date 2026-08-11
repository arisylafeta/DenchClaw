import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const seedSkill = vi.fn();

vi.mock("@/lib/project-root", () => ({ resolveDenchPackageRoot: vi.fn() }));
vi.mock("@/lib/workspace", () => ({
  resolveOpenClawStateDir: vi.fn(() => "/tmp/mock-openclaw-state"),
}));
vi.mock("@/lib/workspace-seed", () => ({
  discoverWorkspaceDirs: vi.fn(),
  MANAGED_SKILLS: [{ name: "composio-cli" }, { name: "monid" }],
  seedSkill,
}));

const { resolveDenchPackageRoot } = await import("@/lib/project-root");
const { discoverWorkspaceDirs } = await import("@/lib/workspace-seed");
const { ensureServiceCliSkillsInWorkspaces } = await import("./ensure-service-cli-skills");

describe("ensureServiceCliSkillsInWorkspaces", () => {
  let packageRoot: string;
  let workspaceDir: string;

  beforeEach(() => {
    seedSkill.mockReset();
    packageRoot = path.join(os.tmpdir(), `dench-package-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    workspaceDir = path.join(os.tmpdir(), `dench-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    for (const skillName of ["composio-cli", "monid"]) {
      mkdirSync(path.join(packageRoot, "skills", skillName), { recursive: true });
      mkdirSync(path.join(workspaceDir, "skills", skillName), { recursive: true });
    }
    vi.mocked(resolveDenchPackageRoot).mockReturnValue(packageRoot);
    vi.mocked(discoverWorkspaceDirs).mockReturnValue([workspaceDir]);
  });

  afterEach(() => {
    rmSync(packageRoot, { recursive: true, force: true });
    rmSync(workspaceDir, { recursive: true, force: true });
  });

  it("re-seeds each bundled service skill whose hash changed", () => {
    for (const skillName of ["composio-cli", "monid"]) {
      writeFileSync(path.join(packageRoot, "skills", skillName, "SKILL.md"), `# bundled ${skillName}\n`);
      writeFileSync(path.join(workspaceDir, "skills", skillName, "SKILL.md"), `# stale ${skillName}\n`);
    }

    ensureServiceCliSkillsInWorkspaces();

    expect(seedSkill).toHaveBeenCalledTimes(2);
    expect(seedSkill).toHaveBeenCalledWith({ workspaceDir, packageRoot }, { name: "composio-cli" });
    expect(seedSkill).toHaveBeenCalledWith({ workspaceDir, packageRoot }, { name: "monid" });
  });

  it("does not rewrite skills whose bundled hashes match", () => {
    for (const skillName of ["composio-cli", "monid"]) {
      const content = `# bundled ${skillName}\n`;
      writeFileSync(path.join(packageRoot, "skills", skillName, "SKILL.md"), content);
      writeFileSync(path.join(workspaceDir, "skills", skillName, "SKILL.md"), content);
    }

    ensureServiceCliSkillsInWorkspaces();

    expect(seedSkill).not.toHaveBeenCalled();
  });
});
