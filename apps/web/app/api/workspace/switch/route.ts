import {
  discoverWorkspaces,
  getActiveWorkspaceName,
  resolveOpenClawStateDir,
  resolveWorkspaceRoot,
  setUIActiveWorkspace,
  setDefaultAgentInConfig,
  writeActiveProfileName,
} from "@/lib/workspace";
import { trackServer } from "@/lib/telemetry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;

function normalizeSwitchWorkspace(raw: unknown): string | null {
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
  const body = (await req.json().catch(() => ({}))) as { workspace?: unknown };
  const requestedWorkspace = normalizeSwitchWorkspace(body.workspace);
  if (!requestedWorkspace) {
    return Response.json(
      { error: "Invalid workspace name. Use letters, numbers, hyphens, or underscores." },
      { status: 400 },
    );
  }

  const discovered = discoverWorkspaces();
  const availableNames = new Set(discovered.map((workspace) => workspace.name));
  if (!availableNames.has(requestedWorkspace)) {
    return Response.json(
      { error: `Workspace '${requestedWorkspace}' was not found.` },
      { status: 404 },
    );
  }

  setUIActiveWorkspace(requestedWorkspace);
  setDefaultAgentInConfig(requestedWorkspace);

  // When running Hermes backend, persist the active profile so the state dir
  // resolution picks up the new profile on subsequent requests.
  if (process.env.DENCH_AGENT_BACKEND === "hermes") {
    writeActiveProfileName(requestedWorkspace);
  }

  trackServer("workspace_switched");
  const activeWorkspace = getActiveWorkspaceName();
  const selected = discoverWorkspaces().find((workspace) => workspace.name === activeWorkspace) ?? null;
  return Response.json({
    activeWorkspace,
    stateDir: resolveOpenClawStateDir(),
    workspaceRoot: resolveWorkspaceRoot(),
    workspace: selected,
  });
}
