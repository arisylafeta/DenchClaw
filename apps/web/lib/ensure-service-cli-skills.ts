import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { resolveDenchPackageRoot } from "@/lib/project-root";
import { resolveOpenClawStateDir } from "@/lib/workspace";
import { discoverWorkspaceDirs, MANAGED_SKILLS, seedSkill } from "@/lib/workspace-seed";

const SERVICE_CLI_SKILL_NAMES = new Set(["composio-cli", "monid"]);
const serviceCliSkillEntries = MANAGED_SKILLS.filter((skill) =>
  SERVICE_CLI_SKILL_NAMES.has(skill.name),
);

function sha256File(filePath: string): string | null {
  if (!existsSync(filePath)) {
    return null;
  }
  const hash = createHash("sha256");
  hash.update(readFileSync(filePath));
  return hash.digest("hex");
}

/** Keep the bundled Composio-first service-routing skills current in every workspace. */
export function ensureServiceCliSkillsInWorkspaces(): void {
  const packageRoot = resolveDenchPackageRoot();
  if (!packageRoot) {
    return;
  }
  const workspaceDirs = discoverWorkspaceDirs(resolveOpenClawStateDir());
  for (const skill of serviceCliSkillEntries) {
    const sourceSkillFile = join(packageRoot, "skills", skill.name, "SKILL.md");
    const sourceHash = sha256File(sourceSkillFile);
    if (!sourceHash) {
      continue;
    }
    for (const workspaceDir of workspaceDirs) {
      const targetSkillFile = join(workspaceDir, "skills", skill.name, "SKILL.md");
      if (sha256File(targetSkillFile) !== sourceHash) {
        seedSkill({ workspaceDir, packageRoot }, skill);
      }
    }
  }
}
