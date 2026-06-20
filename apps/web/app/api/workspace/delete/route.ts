import { rmSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  discoverWorkspaces,
  getActiveWorkspaceName,
  resolveWorkspaceRoot,
  setUIActiveWorkspace,
  readActiveProfileName,
  writeActiveProfileName,
} from "@/lib/workspace";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function normalizeWorkspaceName(raw: unknown): string | null {
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  if (!WORKSPACE_NAME_RE.test(trimmed)) {
    return null;
  }
  return trimmed;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { workspace?: unknown; profile?: unknown };
  const workspaceName = normalizeWorkspaceName(body.workspace ?? body.profile);
  if (!workspaceName) {
    return Response.json(
      { error: "Invalid workspace name. Use letters, numbers, hyphens, or underscores." },
      { status: 400 },
    );
  }

  const availableWorkspace = discoverWorkspaces().find((candidate) => candidate.name === workspaceName);
  if (!availableWorkspace) {
    return Response.json(
      { error: `Workspace '${workspaceName}' was not found.` },
      { status: 404 },
    );
  }
  if (!availableWorkspace.workspaceDir) {
    return Response.json(
      { error: `Workspace '${workspaceName}' does not have a directory to delete.` },
      { status: 409 },
    );
  }

  // When running Hermes backend, remove the Hermes profile via CLI.
  if (process.env.DENCH_AGENT_BACKEND === "hermes") {
    try {
      execSync(`hermes profile remove ${workspaceName}`, {
        stdio: "pipe",
        timeout: 15_000,
      });
    } catch (error) {
      return Response.json(
        { error: `Hermes profile delete failed: ${(error as Error).message}` },
        { status: 500 },
      );
    }

    // If the deleted profile was the active one, reset to "default".
    if (readActiveProfileName() === workspaceName) {
      writeActiveProfileName("default");
    }

    trackServer("workspace_deleted");

    const remaining = discoverWorkspaces();
    const previousActive = getActiveWorkspaceName();
    if (previousActive === workspaceName) {
      setUIActiveWorkspace(remaining[0]?.name ?? null);
    }
    const activeWorkspace = getActiveWorkspaceName();

    return Response.json({
      deleted: true,
      workspace: workspaceName,
      activeWorkspace,
      workspaceRoot: resolveWorkspaceRoot(),
      profile: workspaceName,
      activeProfile: activeWorkspace,
    });
  }

  // Default (non-Hermes) deletion.
  try {
    rmSync(availableWorkspace.workspaceDir, { recursive: true, force: false });
  } catch (error) {
    return Response.json(
      { error: `Workspace delete failed: ${(error as Error).message}` },
      { status: 500 },
    );
  }

  trackServer("workspace_deleted");

  const remaining = discoverWorkspaces();
  const previousActive = getActiveWorkspaceName();
  if (previousActive === workspaceName) {
    setUIActiveWorkspace(remaining[0]?.name ?? null);
  }
  const activeWorkspace = getActiveWorkspaceName();

  return Response.json({
    deleted: true,
    workspace: workspaceName,
    activeWorkspace,
    workspaceRoot: resolveWorkspaceRoot(),
    // Backward-compat response fields while callers migrate.
    profile: workspaceName,
    activeProfile: activeWorkspace,
  });
}
