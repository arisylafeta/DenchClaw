import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import {
  discoverWorkspaces,
  setUIActiveWorkspace,
  getActiveWorkspaceName,
  resolveOpenClawStateDir,
  resolveWorkspaceDirForName,
  isValidWorkspaceName,
  resolveWorkspaceRoot,
  ensureAgentInConfig,
  writeActiveProfileName,
} from "@/lib/workspace";
import {
  BOOTSTRAP_TEMPLATE_CONTENT,
  type BootstrapTemplateName,
} from "@/lib/workspace-bootstrap-templates";
import {
  seedWorkspaceFromAssets,
} from "@/lib/workspace-seed";
import { resolveDenchPackageRoot } from "@/lib/project-root";
import { trackServer } from "@/lib/telemetry";
import { ensureLatestSchema } from "@/lib/workspace-schema-migrations";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// ---------------------------------------------------------------------------
// Bootstrap file names (must match src/agents/workspace.ts)
// ---------------------------------------------------------------------------

const BOOTSTRAP_FILENAMES = [
  "AGENTS.md",
  "SOUL.md",
  "TOOLS.md",
  "IDENTITY.md",
  "USER.md",
  "HEARTBEAT.md",
  "BOOTSTRAP.md",
] as const;

// OpenClaw-specific scaffold files that are not relevant under the Hermes backend.
// HEARTBEAT.md references OpenClaw heartbeat API calls; BOOTSTRAP.md is an OpenClaw
// onboarding concept. Skip both when running Hermes-managed.
const OPENCLAW_ONLY_FILES = new Set(["HEARTBEAT.md", "BOOTSTRAP.md"]);

function getBootstrapFilenames(): readonly string[] {
  if (process.env.DENCH_AGENT_BACKEND === "hermes") {
    return BOOTSTRAP_FILENAMES.filter((f) => !OPENCLAW_ONLY_FILES.has(f));
  }
  return BOOTSTRAP_FILENAMES;
}

const TEMPLATE_DIR = join("assets", "seed", "templates");

const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stripFrontMatter(content: string): string {
  if (!content.startsWith("---")) {return content;}
  const endIndex = content.indexOf("\n---", 3);
  if (endIndex === -1) {return content;}
  return content.slice(endIndex + "\n---".length).replace(/^\s+/, "");
}

function loadTemplateContent(filename: string, projectRoot: string | null): string {
  if (projectRoot) {
    const templatePath = join(projectRoot, TEMPLATE_DIR, filename);
    try {
      const raw = readFileSync(templatePath, "utf-8");
      return stripFrontMatter(raw);
    } catch {
      // fall through to fallback
    }
  }
  return BOOTSTRAP_TEMPLATE_CONTENT[filename as BootstrapTemplateName] ?? "";
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    workspace?: string;
    profile?: string;
    path?: string;
    seedBootstrap?: boolean;
  };
  const workspaceName = (body.workspace ?? body.profile)?.trim() || "";
  if (!workspaceName) {
    return Response.json(
      { error: "Workspace name is required." },
      { status: 400 },
    );
  }
  if (body.path?.trim()) {
    return Response.json(
      { error: "Custom workspace paths are currently disabled. Workspaces are created in ~/.openclaw-dench." },
      { status: 400 },
    );
  }
  if (!WORKSPACE_NAME_RE.test(workspaceName) || !isValidWorkspaceName(workspaceName)) {
    return Response.json(
      {
        error:
          "Invalid or reserved workspace name. Use letters, numbers, hyphens, or underscores. Reserved names include 'main', 'default', and 'chat-slot-*'.",
      },
      { status: 400 },
    );
  }

  const existingWorkspaces = discoverWorkspaces();
  if (existingWorkspaces.some((workspace) => workspace.name.toLowerCase() === workspaceName.toLowerCase())) {
    return Response.json(
      { error: `Workspace '${workspaceName}' already exists.` },
      { status: 409 },
    );
  }

  const seedBootstrap = body.seedBootstrap !== false;
  const seeded: string[] = [];
  const copiedFiles: string[] = [];
  const projectRoot = resolveDenchPackageRoot();

  // ---------------------------------------------------------------------------
  // Hermes backend: create a Hermes profile instead of a workspace-<name> dir.
  // ---------------------------------------------------------------------------
  if (process.env.DENCH_AGENT_BACKEND === "hermes") {
    const profilesRoot = join(process.env.DENCH_HOME?.trim() || join(homedir(), ".hermes"), "profiles");
    const profileDir = join(profilesRoot, workspaceName);
    const profileWorkspaceDir = join(profileDir, "workspace");

    try {
      // 1. Create the Hermes profile by cloning the current one.
      execSync(`hermes profile create ${workspaceName} --clone`, {
        stdio: "pipe",
        timeout: 30_000,
      });
    } catch (err) {
      return Response.json(
        { error: `Failed to create Hermes profile: ${(err as Error).message}` },
        { status: 500 },
      );
    }

    // 2. Write an openclaw.json in the new profile dir if it doesn't exist.
    const openclawConfigPath = join(profileDir, "openclaw.json");
    if (!existsSync(openclawConfigPath)) {
      try {
        writeFileSync(
          openclawConfigPath,
          JSON.stringify(
            {
              plugins: { entries: {} },
              tools: { deny: [], web: { search: { enabled: true } } },
              agents: { list: [] },
            },
            null,
            2,
          ) + "\n",
          "utf-8",
        );
        copiedFiles.push("openclaw.json");
      } catch {
        // best-effort
      }
    }

    // 3. Seed bootstrap files into the profile's workspace/ subdirectory.
    if (seedBootstrap) {
      mkdirSync(profileWorkspaceDir, { recursive: true });
      for (const filename of getBootstrapFilenames()) {
        const filePath = join(profileWorkspaceDir, filename);
        if (!existsSync(filePath)) {
          const content = loadTemplateContent(filename, projectRoot);
          try {
            writeFileSync(filePath, content, { encoding: "utf-8", flag: "wx" });
            seeded.push(filename);
          } catch {
            // race / already exists
          }
        }
      }
    }

    // 4. Seed managed skills, DuckDB, and CRM object projections.
    if (projectRoot) {
      const seedResult = seedWorkspaceFromAssets({ workspaceDir: profileWorkspaceDir, packageRoot: projectRoot });
      seeded.push(...seedResult.projectionFiles);
      if (seedResult.seeded) {
        seeded.push("workspace.duckdb");
      }
    }

    if (seedBootstrap) {
      const wsStateDir = join(profileWorkspaceDir, ".openclaw");
      const statePath = join(wsStateDir, "workspace-state.json");
      if (!existsSync(statePath)) {
        try {
          mkdirSync(wsStateDir, { recursive: true });
          const state = {
            version: 1,
            bootstrapSeededAt: new Date().toISOString(),
            duckdbSeededAt: existsSync(join(profileWorkspaceDir, "workspace.duckdb"))
              ? new Date().toISOString()
              : undefined,
          };
          writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
        } catch {
          // Best-effort state tracking
        }
      }
    }

    // 5. Register agent in openclaw.json and make it the default.
    ensureAgentInConfig(workspaceName, profileDir);

    // 6. Set the active profile.
    writeActiveProfileName(workspaceName);
    setUIActiveWorkspace(workspaceName);
    const activeWorkspace = getActiveWorkspaceName();

    // Apply onboarding-related schema additions (idempotent).
    try {
      await ensureLatestSchema();
    } catch {
      // Non-fatal.
    }

    trackServer("workspace_created", { has_seed: seedBootstrap, hermes: true });

    return Response.json({
      workspace: workspaceName,
      activeWorkspace,
      workspaceDir: profileDir,
      stateDir: profileDir,
      copiedFiles,
      seededFiles: seeded,
      crmSynced: !!projectRoot,
      workspaceRoot: profileDir,
      // Backward-compat response fields while callers migrate.
      profile: workspaceName,
      activeProfile: activeWorkspace,
    });
  }

  // ---------------------------------------------------------------------------
  // Default (non-Hermes) workspace creation.
  // ---------------------------------------------------------------------------
  const stateDir = resolveOpenClawStateDir();
  const workspaceDir = resolveWorkspaceDirForName(workspaceName);

  try {
    mkdirSync(stateDir, { recursive: true });
    mkdirSync(workspaceDir, { recursive: false });
  } catch (err) {
    return Response.json(
      { error: `Failed to prepare workspace directory: ${(err as Error).message}` },
      { status: 500 },
    );
  }

  if (seedBootstrap) {
    for (const filename of getBootstrapFilenames()) {
      const filePath = join(workspaceDir, filename);
      if (!existsSync(filePath)) {
        const content = loadTemplateContent(filename, projectRoot);
        try {
          writeFileSync(filePath, content, { encoding: "utf-8", flag: "wx" });
          seeded.push(filename);
        } catch {
          // race / already exists
        }
      }
    }
  }

  // Seed managed skills, DuckDB, and CRM object projections.
  // DenchClaw identity is injected at runtime via the dench-identity plugin.
  if (projectRoot) {
    const seedResult = seedWorkspaceFromAssets({ workspaceDir, packageRoot: projectRoot });
    seeded.push(...seedResult.projectionFiles);
    if (seedResult.seeded) {
      seeded.push("workspace.duckdb");
    }
  }

  if (seedBootstrap) {
    // Write workspace state so the gateway knows seeding was done.
    const wsStateDir = join(workspaceDir, ".openclaw");
    const statePath = join(wsStateDir, "workspace-state.json");
    if (!existsSync(statePath)) {
      try {
        mkdirSync(wsStateDir, { recursive: true });
        const state = {
          version: 1,
          bootstrapSeededAt: new Date().toISOString(),
          duckdbSeededAt: existsSync(join(workspaceDir, "workspace.duckdb"))
            ? new Date().toISOString()
            : undefined,
        };
        writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf-8");
      } catch {
        // Best-effort state tracking
      }
    }
  }

  // Register a per-workspace agent in openclaw.json and make it the default.
  ensureAgentInConfig(workspaceName, workspaceDir);

  // Switch the UI to the new workspace.
  setUIActiveWorkspace(workspaceName);
  const activeWorkspace = getActiveWorkspaceName();

  // Apply onboarding-related schema additions on top of the seed (idempotent).
  // Existing workspaces predating onboarding get the new objects/fields here;
  // brand-new workspaces just have the seed run them and confirm.
  try {
    await ensureLatestSchema();
  } catch {
    // Non-fatal: the workspace works without the new objects, the user just
    // won't see Gmail-imported rows until the migration is re-run.
  }

  trackServer("workspace_created", { has_seed: seedBootstrap });

  return Response.json({
    workspace: workspaceName,
    activeWorkspace,
    workspaceDir,
    stateDir,
    copiedFiles,
    seededFiles: seeded,
    crmSynced: !!projectRoot,
    workspaceRoot: resolveWorkspaceRoot(),
    // Backward-compat response fields while callers migrate.
    profile: workspaceName,
    activeProfile: activeWorkspace,
  });
}
