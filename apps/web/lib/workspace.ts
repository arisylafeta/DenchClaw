import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import { access, readdir as readdirAsync } from "node:fs/promises";
import { execSync, execFile, execFileSync, spawn } from "node:child_process";
import { promisify } from "node:util";
import { join, resolve, normalize, relative, isAbsolute as isNodeAbsolute } from "node:path";
import { homedir } from "node:os";
import YAML from "yaml";
import { normalizeFilterGroup, type SavedView, type ViewTypeSettings } from "./object-filters";
import {
  classifyWorkspacePath,
  isHomeRelativePath,
  type WorkspacePathKind,
} from "./workspace-paths";

const execFileAsync = promisify(execFile);

async function pathExistsAsync(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const UI_STATE_FILENAME = ".dench-ui-state.json";
const FIXED_STATE_DIRNAME = ".openclaw-dench";
const DEFAULT_PROFILE = "default";
const ACTIVE_PROFILE_FILE = join(homedir(), ".hermes", ".dench-active-profile.json");
const WORKSPACE_PREFIX = "workspace-";
const ROOT_WORKSPACE_DIRNAME = "workspace";
const WORKSPACE_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const DEFAULT_WORKSPACE_NAME = "default";
const DENCHCLAW_PROFILE = "dench";
const GATEWAY_MAIN_AGENT_ID = "main";
const CHAT_SLOT_PREFIX = "chat-slot-";
const DEFAULT_CHAT_POOL_SIZE = 5;
const RESERVED_WORKSPACE_NAMES = new Set([
  DEFAULT_WORKSPACE_NAME,
  GATEWAY_MAIN_AGENT_ID,
]);

/** In-memory override; takes precedence over persisted state. */
let _uiActiveWorkspace: string | null | undefined;

type UIState = {
  activeWorkspace?: string | null;
};

function resolveOpenClawHomeDir(): string {
  return process.env.OPENCLAW_HOME?.trim() || homedir();
}

function expandUserPath(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    return trimmed;
  }
  if (trimmed.startsWith("~")) {
    return join(homedir(), trimmed.slice(1));
  }
  return trimmed;
}

export function readActiveProfileName(): string | null {
  try {
    const raw = readFileSync(ACTIVE_PROFILE_FILE, "utf-8");
    const data = JSON.parse(raw);
    return data.activeProfile?.trim() || null;
  } catch {
    return null;
  }
}

export function writeActiveProfileName(name: string): void {
  try {
    writeFileSync(ACTIVE_PROFILE_FILE, JSON.stringify({ activeProfile: name }, null, 2), "utf-8");
  } catch {
    // best-effort
  }
}

function normalizeWorkspaceName(name: string | null | undefined): string | null {
  const normalized = name?.trim() || null;
  if (!normalized) {
    return null;
  }
  if (!WORKSPACE_NAME_RE.test(normalized)) {
    return null;
  }
  return normalized;
}

function workspaceDirName(workspaceName: string): string {
  return `${WORKSPACE_PREFIX}${workspaceName}`;
}

function workspaceNameFromDirName(dirName: string): string | null {
  if (dirName === ROOT_WORKSPACE_DIRNAME) {
    return DEFAULT_WORKSPACE_NAME;
  }
  if (!dirName.startsWith(WORKSPACE_PREFIX)) {
    return null;
  }
  return normalizeWorkspaceName(dirName.slice(WORKSPACE_PREFIX.length));
}

function isInternalWorkspaceNameForDiscovery(name: string): boolean {
  const lowered = name.toLowerCase();
  return lowered === GATEWAY_MAIN_AGENT_ID || lowered.startsWith(CHAT_SLOT_PREFIX);
}

function stateDirPath(): string {
  // When running Hermes backend, check for an active profile override first.
  if (process.env.DENCH_AGENT_BACKEND === "hermes") {
    const activeProfile = readActiveProfileName();
    if (activeProfile) {
      const denchHome = process.env.DENCH_HOME?.trim() || join(homedir(), ".hermes");
      const profileDir = join(denchHome, "profiles", activeProfile);
      if (existsSync(profileDir)) return profileDir;
    }
  }
  const explicitStateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (explicitStateDir) return explicitStateDir;
  const denchHome = process.env.DENCH_HOME?.trim();
  if (denchHome) return join(denchHome, "profiles", DEFAULT_PROFILE);
  return join(resolveOpenClawHomeDir(), FIXED_STATE_DIRNAME);
}

function resolveWorkspaceDir(workspaceName: string): string {
  const stateDir = resolveOpenClawStateDir();
  if (workspaceName === DEFAULT_WORKSPACE_NAME) {
    const rootWorkspaceDir = join(stateDir, ROOT_WORKSPACE_DIRNAME);
    if (existsSync(rootWorkspaceDir)) {
      return rootWorkspaceDir;
    }
    const prefixedWorkspaceDir = join(stateDir, workspaceDirName(workspaceName));
    if (existsSync(prefixedWorkspaceDir)) {
      return prefixedWorkspaceDir;
    }
    return rootWorkspaceDir;
  }
  return join(stateDir, workspaceDirName(workspaceName));
}

function uiStatePath(): string {
  return join(resolveOpenClawStateDir(), UI_STATE_FILENAME);
}

function readUIState(): UIState {
  try {
    const raw = readFileSync(uiStatePath(), "utf-8");
    return JSON.parse(raw) as UIState;
  } catch {
    return {};
  }
}

export function writeUIState(state: UIState): void {
  const p = uiStatePath();
  const dir = join(p, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(p, JSON.stringify(state, null, 2) + "\n");
}

function workspaceNameFromPath(inputPath: string | null | undefined): string | null {
  if (!inputPath) {
    return null;
  }
  const resolvedPath = resolve(expandUserPath(inputPath));
  const stateRoot = resolve(resolveOpenClawStateDir());
  const rel = relative(stateRoot, resolvedPath);
  if (!rel || rel.startsWith("..")) {
    return null;
  }
  const top = rel.split(/[\\/]/)[0];
  if (!top) {
    return null;
  }
  return workspaceNameFromDirName(top);
}

function scanWorkspaceNames(stateDir: string): string[] {
  // When running Hermes backend, discover profiles from ~/.hermes/profiles/
  if (process.env.DENCH_AGENT_BACKEND === "hermes") {
    const profilesRoot = join(process.env.DENCH_HOME?.trim() || join(homedir(), ".hermes"), "profiles");
    try {
      const entries = readdirSync(profilesRoot, { withFileTypes: true });
      const names = entries
        .filter((e) => e.isDirectory() && existsSync(join(profilesRoot, e.name, "config.yaml")))
        .map((e) => e.name)
        .sort();
      if (!names.includes("default") && existsSync(join(profilesRoot, "default"))) {
        names.unshift("default");
      }
      return names;
    } catch {
      return ["default"];
    }
  }
  try {
    const names = readdirSync(stateDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => workspaceNameFromDirName(entry.name))
      .filter((name): name is string => Boolean(name && !isInternalWorkspaceNameForDiscovery(name)));
    return [...new Set(names)].toSorted((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

/**
 * Active workspace resolution precedence:
 * 1) OPENCLAW_WORKSPACE env path (if it points at workspace or workspace-<name>)
 * 2) in-memory UI override
 * 3) persisted UI state
 */
export function getActiveWorkspaceName(): string | null {
  const stateDir = resolveOpenClawStateDir();
  const discoveredNames = scanWorkspaceNames(stateDir);
  const hasDiscoveredWorkspace = (name: string | null | undefined): name is string =>
    Boolean(name && discoveredNames.includes(name));

  const envWorkspace = process.env.OPENCLAW_WORKSPACE?.trim();
  const envWorkspaceName = workspaceNameFromPath(envWorkspace);
  if (hasDiscoveredWorkspace(envWorkspaceName)) {
    return envWorkspaceName;
  }

  if (_uiActiveWorkspace === null) {
    return null;
  }
  if (hasDiscoveredWorkspace(_uiActiveWorkspace)) {
    return _uiActiveWorkspace;
  }

  const persisted = normalizeWorkspaceName(readUIState().activeWorkspace);
  if (hasDiscoveredWorkspace(persisted)) {
    return persisted;
  }
  return discoveredNames[0] ?? null;
}

export function setUIActiveWorkspace(workspaceName: string | null): void {
  const normalized = normalizeWorkspaceName(workspaceName);
  _uiActiveWorkspace = normalized;
  const existing = readUIState();
  writeUIState({ ...existing, activeWorkspace: normalized });
}

export function clearUIActiveWorkspaceCache(): void {
  _uiActiveWorkspace = undefined;
}

export function resolveOpenClawStateDir(): string {
  return stateDirPath();
}

export type DiscoveredWorkspace = {
  name: string;
  stateDir: string;
  workspaceDir: string | null;
  isActive: boolean;
  hasConfig: boolean;
};

export function discoverWorkspaces(): DiscoveredWorkspace[] {
  const stateDir = resolveOpenClawStateDir();
  const activeWorkspace = getActiveWorkspaceName();
  const discovered: DiscoveredWorkspace[] = [];

  // When running Hermes backend, each profile has its own state dir and workspace dir.
  if (process.env.DENCH_AGENT_BACKEND === "hermes") {
    const hermesRoot = process.env.DENCH_HOME?.trim() || join(homedir(), ".hermes");
    const profilesRoot = join(hermesRoot, "profiles");
    for (const workspaceName of scanWorkspaceNames(stateDir)) {
      const profileDir = join(profilesRoot, workspaceName);
      const profileWorkspaceDir = join(profileDir, "workspace");
      discovered.push({
        name: workspaceName,
        stateDir: profileDir,
        workspaceDir: existsSync(profileWorkspaceDir) ? profileWorkspaceDir : null,
        isActive: activeWorkspace === workspaceName,
        hasConfig: existsSync(join(profileDir, "openclaw.json")) || existsSync(join(profileDir, "config.yaml")),
      });
    }
  } else {
    for (const workspaceName of scanWorkspaceNames(stateDir)) {
      const workspaceDir = resolveWorkspaceDir(workspaceName);
      discovered.push({
        name: workspaceName,
        stateDir,
        workspaceDir: existsSync(workspaceDir) ? workspaceDir : null,
        isActive: activeWorkspace === workspaceName,
        hasConfig: existsSync(join(stateDir, "openclaw.json")),
      });
    }
  }

  discovered.sort((a, b) => a.name.localeCompare(b.name));

  if (!discovered.some((item) => item.isActive) && discovered.length > 0) {
    discovered[0] = {
      ...discovered[0],
      isActive: true,
    };
  }

  return discovered;
}

// Compatibility shims while callers migrate away from profile semantics.
export type DiscoveredProfile = DiscoveredWorkspace;
export function discoverProfiles(): DiscoveredProfile[] {
  return discoverWorkspaces();
}
export function getEffectiveProfile(): string {
  return DENCHCLAW_PROFILE;
}
export function setUIActiveProfile(profile: string | null): void {
  setUIActiveWorkspace(normalizeWorkspaceName(profile));
}
export function clearUIActiveProfileCache(): void {
  clearUIActiveWorkspaceCache();
}
export function getWorkspaceRegistry(): Record<string, string> {
  return {};
}
export function getRegisteredWorkspacePath(_profile: string | null): string | null {
  return null;
}
export function registerWorkspacePath(_profile: string, _absolutePath: string): void {
  // No-op: workspace paths are discovered from managed dirs:
  // ~/.openclaw-dench/workspace (default) and ~/.openclaw-dench/workspace-<name>.
}

function isReservedWorkspaceName(name: string): boolean {
  const lowered = name.toLowerCase();
  return RESERVED_WORKSPACE_NAMES.has(lowered) || lowered.startsWith(CHAT_SLOT_PREFIX);
}

export function isValidWorkspaceName(name: string): boolean {
  const normalized = normalizeWorkspaceName(name);
  return normalized !== null && !isReservedWorkspaceName(normalized);
}

// ---------------------------------------------------------------------------
// OpenClaw config (openclaw.json) agent list helpers
// ---------------------------------------------------------------------------

type OpenClawAgentEntry = {
  id: string;
  default?: boolean;
  workspace?: string;
  [key: string]: unknown;
};

type OpenClawConfig = {
  agents?: {
    defaults?: { workspace?: string; [key: string]: unknown };
    list?: OpenClawAgentEntry[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
};

function workspaceNameToAgentId(workspaceName: string): string {
  return workspaceName === DEFAULT_WORKSPACE_NAME ? GATEWAY_MAIN_AGENT_ID : workspaceName;
}

/**
 * Return the gateway agent ID for the currently active workspace.
 * Maps workspace name "default" to "main" (the gateway's built-in ID);
 * all other workspace names pass through as-is.
 */
export function resolveActiveAgentId(): string {
  const workspaceName = getActiveWorkspaceName();
  return workspaceNameToAgentId(workspaceName ?? DEFAULT_WORKSPACE_NAME);
}

function openclawConfigPath(): string {
  return join(resolveOpenClawStateDir(), "openclaw.json");
}

function readOpenClawConfig(): OpenClawConfig {
  const configPath = openclawConfigPath();
  if (!existsSync(configPath)) {
    return {};
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as OpenClawConfig;
    }
    return {};
  } catch {
    return {};
  }
}

function writeOpenClawConfig(config: OpenClawConfig): void {
  const configPath = openclawConfigPath();
  const dir = join(configPath, "..");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

function ensureConfigAgents(config: OpenClawConfig): void {
  if (!config.agents) {
    config.agents = {};
  }
}

function syncDefaultWorkspacePointer(
  config: OpenClawConfig,
  workspaceName: string,
  workspaceDir: string,
): boolean {
  if (workspaceName !== DEFAULT_WORKSPACE_NAME) {
    return false;
  }
  ensureConfigAgents(config);
  if (!config.agents!.defaults) {
    config.agents!.defaults = {};
  }
  if (config.agents!.defaults.workspace === workspaceDir) {
    return false;
  }
  config.agents!.defaults.workspace = workspaceDir;
  return true;
}

function ensureConfigAgentList(config: OpenClawConfig): OpenClawAgentEntry[] {
  ensureConfigAgents(config);
  if (!Array.isArray(config.agents!.list)) {
    config.agents!.list = [];
    const currentDefaultWorkspace = config.agents!.defaults?.workspace;
    if (currentDefaultWorkspace) {
      config.agents!.list.push({
        id: GATEWAY_MAIN_AGENT_ID,
        workspace: currentDefaultWorkspace,
      });
    }
  }
  return config.agents!.list;
}

function upsertAgentWorkspace(
  list: OpenClawAgentEntry[],
  agentId: string,
  workspaceDir: string,
): boolean {
  const existing = list.find((agent) => agent.id === agentId);
  if (existing) {
    if (existing.workspace === workspaceDir) {
      return false;
    }
    existing.workspace = workspaceDir;
    return true;
  }
  list.push({ id: agentId, workspace: workspaceDir });
  return true;
}

function applyDefaultAgentMarker(list: OpenClawAgentEntry[], targetAgentId: string): boolean {
  let changed = false;
  for (const agent of list) {
    if (agent.id === targetAgentId) {
      if (agent.default !== true) {
        agent.default = true;
        changed = true;
      }
      continue;
    }
    if ("default" in agent) {
      delete agent.default;
      changed = true;
    }
  }
  return changed;
}

function removeChatSlotEntries(list: OpenClawAgentEntry[], baseId?: string): boolean {
  const prefix = baseId ? `${CHAT_SLOT_PREFIX}${baseId}-` : CHAT_SLOT_PREFIX;
  const next = list.filter((agent) => !agent.id.startsWith(prefix));
  if (next.length === list.length) {
    return false;
  }
  list.length = 0;
  list.push(...next);
  return true;
}

/**
 * Upsert an agent entry in `agents.list[]`. If the list doesn't exist yet,
 * bootstrap it with a "main" entry pointing to `agents.defaults.workspace`
 * so the original workspace is preserved. Sets `default: true` on the new agent.
 *
 * Workspace name "default" maps to agent ID "main" (the gateway's built-in
 * default agent ID); all other workspace names are used as-is.
 */
export function ensureAgentInConfig(
  workspaceName: string,
  workspaceDir: string,
  options?: { markDefault?: boolean },
): void {
  const normalized = normalizeWorkspaceName(workspaceName);
  if (!normalized) {
    throw new Error("Invalid workspace name.");
  }
  const config = readOpenClawConfig();
  let changed = syncDefaultWorkspacePointer(config, normalized, workspaceDir);
  const list = ensureConfigAgentList(config);
  const resolvedId = workspaceNameToAgentId(normalized);

  // Chat slots are internal, ephemeral session mechanics and should not be
  // persisted as durable named agents in config.
  changed = removeChatSlotEntries(list) || changed;
  changed = upsertAgentWorkspace(list, resolvedId, workspaceDir) || changed;
  if (options?.markDefault ?? true) {
    changed = applyDefaultAgentMarker(list, resolvedId) || changed;
  }

  if (changed) {
    writeOpenClawConfig(config);
  }
}

/**
 * Legacy compatibility helper.
 *
 * Chat-slot agents are no longer persisted in openclaw.json. This function
 * now prunes stale slot entries if present.
 */
export function ensureChatAgentPool(workspaceName: string, workspaceDir: string, poolSize = DEFAULT_CHAT_POOL_SIZE): void {
  void workspaceDir;
  void poolSize;
  const normalized = normalizeWorkspaceName(workspaceName);
  if (!normalized) {
    throw new Error("Invalid workspace name.");
  }
  const config = readOpenClawConfig();
  let changed = false;
  const list = ensureConfigAgentList(config);
  const baseId = workspaceNameToAgentId(normalized);
  changed = removeChatSlotEntries(list, baseId) || changed;

  if (changed) {
    writeOpenClawConfig(config);
  }
}

/**
 * Repair the workspace mapping for an existing managed agent without creating
 * new entries. This also prunes stale `chat-slot-*` agent entries.
 */
export function ensureManagedWorkspaceRouting(
  workspaceName: string,
  workspaceDir: string,
  options?: { markDefault?: boolean; poolSize?: number },
): void {
  void options;
  const normalized = normalizeWorkspaceName(workspaceName);
  if (!normalized) {
    throw new Error("Invalid workspace name.");
  }
  const config = readOpenClawConfig();
  let changed = syncDefaultWorkspacePointer(config, normalized, workspaceDir);
  const list = ensureConfigAgentList(config);
  const resolvedId = workspaceNameToAgentId(normalized);
  const existing = list.find((agent) => agent.id === resolvedId);
  if (existing && existing.workspace !== workspaceDir) {
    existing.workspace = workspaceDir;
    changed = true;
  }
  changed = removeChatSlotEntries(list, resolvedId) || changed;
  if (options?.markDefault && existing) {
    changed = applyDefaultAgentMarker(list, resolvedId) || changed;
  }

  if (changed) {
    writeOpenClawConfig(config);
  }
}

/**
 * Return the list of chat slot agent IDs for a workspace.
 */
export function getChatSlotAgentIds(workspaceName?: string): string[] {
  void workspaceName;
  return [];
}

export { CHAT_SLOT_PREFIX, DEFAULT_CHAT_POOL_SIZE };

/**
 * Flip `default: true` to the target agent in `agents.list[]`.
 * No-op if the list doesn't exist or the agent isn't found.
 *
 * Accepts a workspace name; maps "default" to agent ID "main".
 */
export function setDefaultAgentInConfig(workspaceName: string): void {
  const config = readOpenClawConfig();
  const list = config.agents?.list;
  if (!Array.isArray(list) || list.length === 0) {
    return;
  }

  const resolvedId = workspaceNameToAgentId(workspaceName);
  const target = list.find((a) => a.id === resolvedId);
  if (!target) {
    return;
  }

  for (const agent of list) {
    if (agent.id === resolvedId) {
      agent.default = true;
    } else {
      delete agent.default;
    }
  }

  writeOpenClawConfig(config);
}

export function resolveWorkspaceDirForName(name: string): string {
  const normalized = normalizeWorkspaceName(name);
  if (!normalized) {
    throw new Error("Invalid workspace name.");
  }
  return resolveWorkspaceDir(normalized);
}

export function resolveWorkspaceRoot(): string | null {
  const explicitWorkspace = process.env.OPENCLAW_WORKSPACE?.trim();
  const explicitWorkspaceName = workspaceNameFromPath(explicitWorkspace);
  if (explicitWorkspaceName) {
    const managedWorkspaceDir = resolveWorkspaceDir(explicitWorkspaceName);
    if (existsSync(managedWorkspaceDir)) {
      return managedWorkspaceDir;
    }
  }

  const activeWorkspace = getActiveWorkspaceName();
  if (activeWorkspace) {
    const activeDir = resolveWorkspaceDir(activeWorkspace);
    if (existsSync(activeDir)) {
      return activeDir;
    }
  }

  const discovered = discoverWorkspaces();
  return discovered.find((workspace) => workspace.isActive)?.workspaceDir ?? null;
}

export function resolveWebChatDir(): string {
  const workspaceRoot = resolveWorkspaceRoot();
  if (workspaceRoot) {
    return join(workspaceRoot, ".openclaw", "web-chat");
  }

  const activeWorkspace = getActiveWorkspaceName();
  if (activeWorkspace) {
    return join(resolveWorkspaceDir(activeWorkspace), ".openclaw", "web-chat");
  }

  // Fallback for first-run flows before any workspace is selected/created.
  return join(resolveWorkspaceDir(DEFAULT_WORKSPACE_NAME), ".openclaw", "web-chat");
}

/**
 * Resolve the per-workspace `.denchclaw/` directory used as the source of
 * truth for onboarding state, Composio connection metadata, sync cursors,
 * and the user-extended personal-email blocklist. Mirrors `resolveWebChatDir`
 * for fallbacks so first-run flows still produce a valid path.
 */
export function resolveDenchClawDir(workspaceName?: string | null): string {
  if (workspaceName) {
    const normalized = normalizeWorkspaceName(workspaceName);
    if (normalized) {
      return join(resolveWorkspaceDir(normalized), ".denchclaw");
    }
  }

  const workspaceRoot = resolveWorkspaceRoot();
  if (workspaceRoot) {
    return join(workspaceRoot, ".denchclaw");
  }

  const activeWorkspace = getActiveWorkspaceName();
  if (activeWorkspace) {
    return join(resolveWorkspaceDir(activeWorkspace), ".denchclaw");
  }

  return join(resolveWorkspaceDir(DEFAULT_WORKSPACE_NAME), ".denchclaw");
}

/** @deprecated Use `resolveWorkspaceRoot` instead. */
export const resolveDenchRoot = resolveWorkspaceRoot;

/**
 * Return the workspace path prefix for the agent.
 * Returns the absolute workspace path (e.g. ~/.openclaw/workspace),
 * or a relative path from the repo root if the workspace is inside it.
 */
export function resolveAgentWorkspacePrefix(): string | null {
  const root = resolveWorkspaceRoot();
  if (!root) {return null;}

  // If the workspace is an absolute path outside the repo, return it as-is
  if (root.startsWith("/")) {
    const cwd = process.cwd();
    const repoRoot = cwd.endsWith(join("apps", "web"))
      ? resolve(cwd, "..", "..")
      : cwd;
    const rel = relative(repoRoot, root);
    // If the relative path starts with "..", it's outside the repo — use absolute
    if (rel.startsWith("..")) {return root;}
    return rel || root;
  }

  return root;
}

// ---------------------------------------------------------------------------
// Hierarchical DuckDB discovery
//
// Supports multiple workspace.duckdb files in a tree structure.  Each
// subdirectory may contain its own workspace.duckdb that is authoritative
// for the objects in that subtree.  Shallower (closer to workspace root)
// databases take priority when objects share the same name.
// ---------------------------------------------------------------------------

/**
 * Recursively discover all workspace.duckdb files under `root`.
 * Returns absolute paths sorted by depth (shallowest first) so that
 * root-level databases have priority over deeper ones.
 */
export function discoverDuckDBPaths(root?: string): string[] {
  const wsRoot = root ?? resolveWorkspaceRoot();
  if (!wsRoot) {return [];}

  const results: Array<{ path: string; depth: number }> = [];

  function walk(dir: string, depth: number) {
    const dbFile = join(dir, "workspace.duckdb");
    if (existsSync(dbFile)) {
      results.push({ path: dbFile, depth });
    }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {continue;}
        if (entry.name.startsWith(".")) {continue;}
        // Skip common non-workspace directories
        if (entry.name === "tmp" || entry.name === "exports" || entry.name === "node_modules") {continue;}
        walk(join(dir, entry.name), depth + 1);
      }
    } catch {
      // unreadable directory
    }
  }

  walk(wsRoot, 0);
  results.sort((a, b) => a.depth - b.depth);
  return results.map((r) => r.path);
}

/**
 * Async version of discoverDuckDBPaths — avoids blocking the event loop
 * while recursively scanning large workspaces.
 */
export async function discoverDuckDBPathsAsync(root?: string): Promise<string[]> {
  const wsRoot = root ?? resolveWorkspaceRoot();
  if (!wsRoot) {return [];}

  const results: Array<{ path: string; depth: number }> = [];

  async function walk(dir: string, depth: number): Promise<void> {
    const dbFile = join(dir, "workspace.duckdb");
    if (await pathExistsAsync(dbFile)) {
      results.push({ path: dbFile, depth });
    }

    try {
      const entries = await readdirAsync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {continue;}
        if (entry.name.startsWith(".")) {continue;}
        // Skip common non-workspace directories
        if (entry.name === "tmp" || entry.name === "exports" || entry.name === "node_modules") {continue;}
        await walk(join(dir, entry.name), depth + 1);
      }
    } catch {
      // unreadable directory
    }
  }

  await walk(wsRoot, 0);
  results.sort((a, b) => a.depth - b.depth);
  return results.map((r) => r.path);
}

/**
 * Path to the primary DuckDB database file.
 * Checks the workspace root first, then falls back to any workspace.duckdb
 * discovered in subdirectories (backward compat with legacy layout).
 */
export function duckdbPath(): string | null {
  const root = resolveWorkspaceRoot();
  if (!root) {return null;}

  // Try root-level first (standard layout)
  const rootDb = join(root, "workspace.duckdb");
  if (existsSync(rootDb)) {return rootDb;}

  // Fallback: discover the shallowest workspace.duckdb in subdirectories
  const all = discoverDuckDBPaths(root);
  return all.length > 0 ? all[0] : null;
}

/** Async version of duckdbPath — avoids sync recursive discovery fallback. */
export async function duckdbPathAsync(): Promise<string | null> {
  const root = resolveWorkspaceRoot();
  if (!root) {return null;}

  // Try root-level first (standard layout)
  const rootDb = join(root, "workspace.duckdb");
  if (await pathExistsAsync(rootDb)) {return rootDb;}

  // Fallback: discover the shallowest workspace.duckdb in subdirectories
  const all = await discoverDuckDBPathsAsync(root);
  return all.length > 0 ? all[0] : null;
}

/**
 * Compute the workspace-relative directory that a DuckDB file is authoritative for.
 * e.g. for `~/.openclaw/workspace/subdir/workspace.duckdb` returns `"subdir"`.
 * For the root DB returns `""` (empty string).
 */
export function duckdbRelativeScope(dbPath: string): string {
  const root = resolveWorkspaceRoot();
  if (!root) {return "";}
  const dir = resolve(dbPath, "..");
  const rel = relative(root, dir);
  return rel === "." ? "" : rel;
}

/**
 * Resolve the duckdb CLI binary path.
 * Checks common locations since the Next.js server may have a minimal PATH.
 */
export function resolveDuckdbBin(): string | null {
  const home = homedir();
  const candidates = [
    // User-local installs
    join(home, ".duckdb", "cli", "latest", "duckdb"),
    join(home, ".local", "bin", "duckdb"),
    // Homebrew
    "/opt/homebrew/bin/duckdb",
    "/usr/local/bin/duckdb",
    // System
    "/usr/bin/duckdb",
  ];

  for (const bin of candidates) {
    if (existsSync(bin)) {return bin;}
  }

  // Fallback: try bare `duckdb` and hope it's in PATH
  try {
    execSync("which duckdb", { encoding: "utf-8", timeout: 2000 });
    return "duckdb";
  } catch {
    return null;
  }
}

/**
 * Execute a DuckDB query and return parsed JSON rows.
 * Uses the duckdb CLI with -json output format.
 *
 * @deprecated Prefer `duckdbQueryAsync` in server route handlers to avoid
 * blocking the Node.js event loop (which freezes the standalone server).
 */
export function duckdbQuery<T = Record<string, unknown>>(
  sql: string,
): T[] {
  const db = duckdbPath();
  if (!db) {return [];}

  const bin = resolveDuckdbBin();
  if (!bin) {return [];}

  try {
    const result = execFileSync(bin, ["-json", db, sql], {
      encoding: "utf-8",
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024, // 10 MB
    });

    const trimmed = result.trim();
    if (!trimmed || trimmed === "[]") {return [];}
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}

/**
 * Async version of duckdbQuery — does not block the event loop.
 * Always prefer this in Next.js route handlers (especially the standalone build
 * which is single-threaded; a blocking execSync freezes the entire server).
 *
 * Retries on DuckDB exclusive-lock conflicts (250ms → 4s, up to 8 tries).
 * Without retry, concurrent queries silently return `[]` and downstream
 * code (e.g. field-id maps in the Gmail sync pipeline) breaks because
 * "no rows" looks indistinguishable from "lookup failed".
 */
export async function duckdbQueryAsync<T = Record<string, unknown>>(
  sql: string,
): Promise<T[]> {
  const db = await duckdbPathAsync();
  if (!db) {return [];}

  const bin = resolveDuckdbBin();
  if (!bin) {return [];}

  const MAX_RETRIES = 8;
  let attempt = 0;
  let lastErr = "";
  while (attempt < MAX_RETRIES) {
    try {
      const { stdout } = await execFileAsync(bin, ["-json", db, sql], {
        encoding: "utf-8",
        timeout: 30_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === "[]") {return [];}
      return JSON.parse(trimmed) as T[];
    } catch (err) {
      const stderr = (err as { stderr?: string | Buffer }).stderr;
      const stderrText =
        typeof stderr === "string"
          ? stderr
          : Buffer.isBuffer(stderr)
            ? stderr.toString("utf-8")
            : (err as Error).message ?? "";
      lastErr = stderrText.slice(0, 600);
      const lockConflict =
        stderrText.includes("Conflicting lock") ||
        stderrText.includes("Could not set lock");
      if (!lockConflict) {
        return [];
      }
      const delay = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
      await new Promise((resolve) => setTimeout(resolve, delay));
      attempt += 1;
    }
  }
  console.error(`[duckdb] query gave up after ${MAX_RETRIES} retries: ${lastErr}`);
  return [];
}

// ---------------------------------------------------------------------------
// Multi-DB query helpers — aggregate results from all discovered databases
// ---------------------------------------------------------------------------

/**
 * Query ALL discovered workspace.duckdb files and merge results.
 * Shallower databases are queried first; use `dedupeKey` to drop duplicates
 * from deeper databases (shallower wins).
 */
export function duckdbQueryAll<T = Record<string, unknown>>(
  sql: string,
  dedupeKey?: keyof T,
): T[] {
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length === 0) {return [];}

  const bin = resolveDuckdbBin();
  if (!bin) {return [];}

  const seen = new Set<unknown>();
  const merged: T[] = [];

  for (const db of dbPaths) {
    try {
      const result = execFileSync(bin, ["-json", db, sql], {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const trimmed = result.trim();
      if (!trimmed || trimmed === "[]") {continue;}
      const rows = JSON.parse(trimmed) as T[];
      for (const row of rows) {
        if (dedupeKey) {
          const key = row[dedupeKey];
          if (seen.has(key)) {continue;}
          seen.add(key);
        }
        merged.push(row);
      }
    } catch {
      // skip failing DBs
    }
  }

  return merged;
}

/**
 * Async version of duckdbQueryAll.
 */
export async function duckdbQueryAllAsync<T = Record<string, unknown>>(
  sql: string,
  dedupeKey?: keyof T,
): Promise<T[]> {
  const dbPaths = await discoverDuckDBPathsAsync();
  if (dbPaths.length === 0) {return [];}

  const bin = resolveDuckdbBin();
  if (!bin) {return [];}

  const seen = new Set<unknown>();
  const merged: T[] = [];

  for (const db of dbPaths) {
    try {
      const { stdout } = await execFileAsync(bin, ["-json", db, sql], {
        encoding: "utf-8",
        timeout: 10_000,
        maxBuffer: 10 * 1024 * 1024,
      });
      const trimmed = stdout.trim();
      if (!trimmed || trimmed === "[]") {continue;}
      const rows = JSON.parse(trimmed) as T[];
      for (const row of rows) {
        if (dedupeKey) {
          const key = row[dedupeKey];
          if (seen.has(key)) {continue;}
          seen.add(key);
        }
        merged.push(row);
      }
    } catch {
      // skip failing DBs
    }
  }

  return merged;
}

/**
 * Find the DuckDB file that contains a specific object by name.
 * Returns the absolute path to the database, or null if not found.
 * Checks shallower databases first (parent takes priority).
 */
export function findDuckDBForObject(objectName: string): string | null {
  const dbPaths = discoverDuckDBPaths();
  if (dbPaths.length === 0) {return null;}

  const bin = resolveDuckdbBin();
  if (!bin) {return null;}

  // SQL-escape object name for DuckDB string literals (not shell).
  const sql = `SELECT id FROM objects WHERE name = '${objectName.replace(/'/g, "''")}' LIMIT 1`;

  for (const db of dbPaths) {
    try {
      const result = execFileSync(bin, ["-json", db, sql], {
        encoding: "utf-8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      const trimmed = result.trim();
      if (trimmed && trimmed !== "[]") {return db;}
    } catch {
      // continue to next DB
    }
  }

  return null;
}

/** Async version of findDuckDBForObject — avoids blocking recursive discovery. */
export async function findDuckDBForObjectAsync(objectName: string): Promise<string | null> {
  const dbPaths = await discoverDuckDBPathsAsync();
  if (dbPaths.length === 0) {return null;}

  const bin = resolveDuckdbBin();
  if (!bin) {return null;}

  const sql = `SELECT id FROM objects WHERE name = '${objectName.replace(/'/g, "''")}' LIMIT 1`;

  for (const db of dbPaths) {
    try {
      const { stdout } = await execFileAsync(bin, ["-json", db, sql], {
        encoding: "utf-8",
        timeout: 5_000,
        maxBuffer: 1024 * 1024,
      });
      const trimmed = stdout.trim();
      if (trimmed && trimmed !== "[]") {return db;}
    } catch {
      // continue to next DB
    }
  }

  return null;
}

/**
 * Execute a DuckDB statement (no JSON output expected).
 * Used for INSERT/UPDATE/ALTER operations.
 */
export function duckdbExec(sql: string): boolean {
  const db = duckdbPath();
  if (!db) {return false;}
  return duckdbExecOnFile(db, sql);
}

/** Async version of duckdbExec — avoids sync DB discovery fallback. */
export async function duckdbExecAsync(sql: string): Promise<boolean> {
  const db = await duckdbPathAsync();
  if (!db) {return false;}
  return duckdbExecOnFileAsync(db, sql);
}

/**
 * Execute a DuckDB statement against a specific database file (no JSON output).
 * Used for INSERT/UPDATE/ALTER operations on a targeted DB.
 */
export function duckdbExecOnFile(dbFilePath: string, sql: string): boolean {
  const bin = resolveDuckdbBin();
  if (!bin) {return false;}

  try {
    execFileSync(bin, [dbFilePath, sql], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    return true;
  } catch {
    return false;
  }
}

type DuckdbExecAttemptResult = {
  ok: true;
} | {
  ok: false;
  retriable: boolean;
  errorMessage: string;
};

async function duckdbExecOnFileOnce(
  bin: string,
  dbFilePath: string,
  sql: string,
): Promise<DuckdbExecAttemptResult> {
  return new Promise<DuckdbExecAttemptResult>((resolve) => {
    const proc = spawn(bin, [dbFilePath], { stdio: ["pipe", "pipe", "pipe"] });
    let stderrBuf = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
    }, 60_000);

    proc.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString("utf-8");
    });
    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, retriable: false, errorMessage: `spawn failed: ${err.message}` });
    });
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({
          ok: false,
          retriable: true,
          errorMessage: "exec timed out after 60s",
        });
        return;
      }
      if (code !== 0) {
        const errText = stderrBuf.trim();
        // DuckDB acquires an exclusive file lock for writes; concurrent
        // CLI processes (the workspace tree/search-index routes also
        // query DuckDB) collide here. Treat lock conflicts as retriable
        // so an ingestion page commit eventually wins instead of silently
        // dropping all writes.
        const lockConflict =
          errText.includes("Conflicting lock") ||
          errText.includes("Could not set lock");
        resolve({
          ok: false,
          retriable: lockConflict,
          errorMessage: errText.slice(0, 800) || `exit code ${code}`,
        });
        return;
      }
      resolve({ ok: true });
    });

    // EPIPE arises when duckdb exits before we finish writing stdin
    // (e.g. it errored on the first statement). Swallow it — the close
    // handler will still fire with the real error code/message.
    proc.stdin.on("error", () => {});
    proc.stdin.write(sql);
    proc.stdin.end();
  });
}

/**
 * Async version of duckdbExecOnFile — does not block the event loop, and
 * pipes SQL via stdin so it isn't constrained by the OS arg-length cap
 * (~128KB on macOS). Sync ingestion writes can easily exceed that for
 * a single page commit (each message generates ~10–20 statements,
 * sometimes multi-KB body inserts).
 *
 * Retries on lock-conflict errors with exponential backoff (250ms → 4s,
 * up to 8 tries). Other errors are surfaced to stderr and return false
 * so the caller can decide whether to abort or continue.
 */
export async function duckdbExecOnFileAsync(dbFilePath: string, sql: string): Promise<boolean> {
  const bin = resolveDuckdbBin();
  if (!bin) {return false;}

  const MAX_RETRIES = 8;
  let attempt = 0;
  let lastErr = "";
  while (attempt < MAX_RETRIES) {
    const result = await duckdbExecOnFileOnce(bin, dbFilePath, sql);
    if (result.ok) {return true;}
    lastErr = result.errorMessage;
    if (!result.retriable) {
      console.error(`[duckdb] exec failed on ${dbFilePath}: ${lastErr}`);
      return false;
    }
    const delay = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt += 1;
  }
  console.error(`[duckdb] exec gave up after ${MAX_RETRIES} retries on ${dbFilePath}: ${lastErr}`);
  return false;
}

/**
 * Parse a relation field value which may be a single ID or a JSON array of IDs.
 * Handles both many_to_one (single ID string) and many_to_many (JSON array).
 */
export function parseRelationValue(value: string | null | undefined): string[] {
  if (!value) {return [];}
  const trimmed = value.trim();
  if (!trimmed) {return [];}

  // Try JSON array first (many-to-many)
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (Array.isArray(parsed)) {return parsed.map(String).filter(Boolean);}
    } catch {
      // not valid JSON array, treat as single value
    }
  }

  return [trimmed];
}

/** Database file extensions that trigger the database viewer. */
export const DB_EXTENSIONS = new Set([
  "duckdb",
  "sqlite",
  "sqlite3",
  "db",
  "postgres",
]);

/** Check whether a filename has a database extension. */
export function isDatabaseFile(filename: string): boolean {
  const ext = filename.split(".").pop()?.toLowerCase();
  return ext ? DB_EXTENSIONS.has(ext) : false;
}

/**
 * Execute a DuckDB query against an arbitrary database file and return parsed JSON rows.
 * This is used by the database viewer to introspect any .duckdb/.sqlite/.db file.
 *
 * @deprecated Prefer `duckdbQueryOnFileAsync` in route handlers.
 */
export function duckdbQueryOnFile<T = Record<string, unknown>>(
  dbFilePath: string,
  sql: string,
): T[] {
  const bin = resolveDuckdbBin();
  if (!bin) {return [];}

  try {
    const result = execFileSync(bin, ["-json", dbFilePath, sql], {
      encoding: "utf-8",
      timeout: 15_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const trimmed = result.trim();
    if (!trimmed || trimmed === "[]") {return [];}
    return JSON.parse(trimmed) as T[];
  } catch {
    return [];
  }
}

type DuckdbReadAttemptResult<T> =
  | { ok: true; rows: T[] }
  | { ok: false; retriable: boolean; error: unknown; errorMessage: string };

/**
 * Run one DuckDB read against a specific DB file and classify the outcome
 * so callers can decide whether to retry. DuckDB acquires an exclusive
 * file lock for any operation; concurrent CLI processes against the same
 * file collide. When stderr contains "Conflicting lock" or "Could not set
 * lock" the failure is transient and worth retrying. Other failures (bad
 * SQL, missing table) are terminal and surfaced unchanged.
 */
async function runDuckdbReadOnce<T>(
  bin: string,
  dbFilePath: string,
  sql: string,
  timeoutMs: number,
): Promise<DuckdbReadAttemptResult<T>> {
  try {
    const { stdout } = await execFileAsync(bin, ["-json", dbFilePath, sql], {
      encoding: "utf-8",
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
    });
    const trimmed = stdout.trim();
    if (!trimmed || trimmed === "[]") {return { ok: true, rows: [] };}
    return { ok: true, rows: JSON.parse(trimmed) as T[] };
  } catch (err) {
    const stderr = (err as { stderr?: string | Buffer }).stderr;
    const stderrText =
      typeof stderr === "string"
        ? stderr
        : Buffer.isBuffer(stderr)
          ? stderr.toString("utf-8")
          : (err as Error).message ?? "";
    const lockConflict =
      stderrText.includes("Conflicting lock") ||
      stderrText.includes("Could not set lock");
    return {
      ok: false,
      retriable: lockConflict,
      error: err,
      errorMessage: stderrText.slice(0, 800) || (err as Error).message || "duckdb read failed",
    };
  }
}

/**
 * Run a DuckDB read with the same retry-on-lock-conflict semantics that
 * `duckdbExecOnFileAsync` already uses for writes. Resolves with rows on
 * success, or with an error result after retries are exhausted (so callers
 * can choose between returning `[]` or rethrowing).
 *
 * Why this exists: DuckDB's CLI takes an exclusive file lock for every
 * operation. Back-to-back operations from the workspace (POST /fields,
 * server-side pivot view rebuild, then the immediate GET /objects/[name]
 * that the client fires after the write completes) can race a still-running
 * sibling on the same file. Without retry, the read fails with a lock
 * conflict and silently returns `[]`. The route then treats the empty
 * result as "object not found" and 404s — the right panel goes blank and
 * the user sees a "crash" right after creating a column. Reads need the
 * same retry resilience writes already have.
 */
async function runDuckdbReadWithRetry<T>(
  bin: string,
  dbFilePath: string,
  sql: string,
  timeoutMs: number,
): Promise<DuckdbReadAttemptResult<T>> {
  const MAX_RETRIES = 8;
  let attempt = 0;
  let lastResult: DuckdbReadAttemptResult<T> = {
    ok: false,
    retriable: false,
    error: new Error("no attempts made"),
    errorMessage: "no attempts made",
  };
  while (attempt < MAX_RETRIES) {
    lastResult = await runDuckdbReadOnce<T>(bin, dbFilePath, sql, timeoutMs);
    if (lastResult.ok) {return lastResult;}
    if (!lastResult.retriable) {return lastResult;}
    const delay = Math.min(4000, 250 * 2 ** attempt) + Math.floor(Math.random() * 100);
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt += 1;
  }
  return lastResult;
}

/**
 * Async version of duckdbQueryOnFile — does not block the event loop.
 * Retries lock conflicts (transient races with concurrent CLI processes)
 * with exponential backoff before giving up. Persistent failures still
 * resolve to `[]`, matching the legacy contract for callers that don't
 * distinguish errors from empty results.
 */
export async function duckdbQueryOnFileAsync<T = Record<string, unknown>>(
  dbFilePath: string,
  sql: string,
): Promise<T[]> {
  const bin = resolveDuckdbBin();
  if (!bin) {return [];}

  const result = await runDuckdbReadWithRetry<T>(bin, dbFilePath, sql, 15_000);
  if (result.ok) {return result.rows;}
  console.error(`[duckdb] query gave up on ${dbFilePath}: ${result.errorMessage}`);
  return [];
}

/**
 * Like `duckdbQueryOnFileAsync`, but rethrows errors instead of silently
 * returning `[]`. Use when callers need to distinguish "no rows" from "query
 * failed" (e.g. to trigger an EAV fallback when a pivot view is missing or
 * has a bad identifier). Lock conflicts are still retried with exponential
 * backoff; only persistent failures throw.
 */
export async function duckdbQueryOnFileAsyncStrict<T = Record<string, unknown>>(
  dbFilePath: string,
  sql: string,
): Promise<T[]> {
  const bin = resolveDuckdbBin();
  if (!bin) {
    throw new Error("DuckDB CLI binary not found");
  }

  const result = await runDuckdbReadWithRetry<T>(bin, dbFilePath, sql, 15_000);
  if (result.ok) {return result.rows;}
  throw result.error instanceof Error
    ? result.error
    : new Error(result.errorMessage);
}

/**
 * Build a safe, quoted DuckDB identifier for an object's auto-generated PIVOT
 * view. DuckDB object names may contain hyphens (e.g. `ai-agent`), which are
 * parsed as the minus operator in unquoted identifiers. We normalize hyphens
 * to underscores AND wrap the identifier in double quotes so it is always a
 * single valid identifier regardless of what other characters appear.
 *
 * Example: `ai-agent` → `"v_ai_agent"`.
 */
export function pivotViewIdentifier(objectName: string): string {
  const normalized = objectName.replace(/-/g, "_");
  const escaped = normalized.replace(/"/g, '""');
  return `"v_${escaped}"`;
}

export type ResolvedFilesystemPath = {
  absolutePath: string;
  kind: WorkspacePathKind;
  withinWorkspace: boolean;
  workspaceRelativePath: string | null;
};

function toPortableRelativePath(path: string): string {
  return path.replace(/\\/g, "/");
}

function expandHomeRelativePath(inputPath: string): string {
  if (!isHomeRelativePath(inputPath)) {return inputPath;}
  return join(homedir(), inputPath.slice(2));
}

/**
 * Resolve a local filesystem path that may be workspace-relative, absolute,
 * or home-relative. Virtual `~skills/...` style paths are rejected here.
 */
export function resolveFilesystemPath(
  inputPath: string,
  options: { allowMissing?: boolean } = {},
): ResolvedFilesystemPath | null {
  if (inputPath.includes("\0")) {return null;}

  const kind = classifyWorkspacePath(inputPath);
  if (kind === "virtual") {return null;}

  const workspaceRoot = resolveWorkspaceRoot();
  const resolvedWsRoot = workspaceRoot ? resolve(workspaceRoot) : null;
  const home = homedir();
  let absolutePath: string;

  if (kind === "workspaceRelative") {
    if (!resolvedWsRoot) {return null;}
    const wsPrefix = resolvedWsRoot + "/";
    const resolved = resolve(resolvedWsRoot, normalize(inputPath));
    if (resolved.startsWith(wsPrefix)) {
      absolutePath = resolved;
    } else if (resolved === resolvedWsRoot) {
      absolutePath = resolvedWsRoot;
    } else {
      return null;
    }
  } else if (kind === "homeRelative") {
    const homePrefix = home + "/";
    const resolved = resolve(normalize(expandHomeRelativePath(inputPath)));
    if (resolved.startsWith(homePrefix)) {
      absolutePath = resolved;
    } else if (resolved === home) {
      absolutePath = home;
    } else {
      return null;
    }
  } else {
    const resolved = resolve(normalize(inputPath));
    const homePrefix = home + "/";
    if (resolvedWsRoot && resolved.startsWith(resolvedWsRoot + "/")) {
      absolutePath = resolved;
    } else if (resolved.startsWith(homePrefix)) {
      absolutePath = resolved;
    } else {
      return null;
    }
  }

  if (!options.allowMissing && !existsSync(absolutePath)) {return null;}

  const withinWorkspace = !!resolvedWsRoot
    && (absolutePath.startsWith(resolvedWsRoot + "/") || absolutePath === resolvedWsRoot);
  const workspaceRelativePath = withinWorkspace && resolvedWsRoot
    ? toPortableRelativePath(relative(resolvedWsRoot, absolutePath))
    : null;

  return {
    absolutePath,
    kind,
    withinWorkspace,
    workspaceRelativePath,
  };
}

/**
 * Validate and resolve a path within the workspace.
 * Prevents path traversal by ensuring the resolved path stays within root.
 * Returns the absolute path or null if invalid/nonexistent.
 */
export function safeResolvePath(
  relativePath: string,
): string | null {
  const resolvedPath = resolveFilesystemPath(relativePath);
  if (!resolvedPath || resolvedPath.kind !== "workspaceRelative") {return null;}
  return resolvedPath.absolutePath;
}

/**
 * Lightweight YAML frontmatter / simple-value parser.
 * Handles flat key: value pairs and simple nested structures.
 * Good enough for .object.yaml and workspace_context.yaml top-level fields.
 */
export function parseSimpleYaml(
  content: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = content.split("\n");
  let currentListKey: string | null = null;

  for (const line of lines) {
    if (line.trim().startsWith("#") || !line.trim()) {continue;}

    // Match top-level key: value (value may be empty for list parents)
    const match = line.match(/^(\w[\w_-]*)\s*:\s*(.*)/);
    if (match) {
      currentListKey = null;
      const key = match[1];
      let value: unknown = match[2].trim();

      if (value === "") {
        currentListKey = key;
        result[key] = [];
        continue;
      }

      // Strip quotes
      if (
        typeof value === "string" &&
        ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'")))
      ) {
        value = (value).slice(1, -1);
      }

      // Parse booleans and numbers
      if (value === "true") {value = true;}
      else if (value === "false") {value = false;}
      else if (value === "null") {value = null;}
      else if (
        typeof value === "string" &&
        /^-?\d+(\.\d+)?$/.test(value)
      ) {
        value = Number(value);
      }

      result[key] = value;
      continue;
    }

    // Collect indented list items ("  - value") under the current list key
    if (currentListKey) {
      const listMatch = line.match(/^\s+-\s+(.*)/);
      if (listMatch) {
        let item: unknown = listMatch[1].trim();
        if (
          typeof item === "string" &&
          ((item.startsWith('"') && item.endsWith('"')) ||
            (item.startsWith("'") && item.endsWith("'")))
        ) {
          item = (item).slice(1, -1);
        }
        (result[currentListKey] as unknown[]).push(item);
      } else {
        currentListKey = null;
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// .object.yaml with nested views support
// ---------------------------------------------------------------------------

/** Parsed representation of a .object.yaml file. */
export type ObjectYamlConfig = {
  icon?: string;
  default_view?: string;
  view_settings?: ViewTypeSettings;
  views?: SavedView[];
  active_view?: string;
  /** Any other top-level keys. */
  [key: string]: unknown;
};

/**
 * Parse a .object.yaml file with full YAML support (handles nested views).
 * Falls back to parseSimpleYaml for files that only have flat keys.
 */
export function parseObjectYaml(content: string): ObjectYamlConfig {
  try {
    const parsed = YAML.parse(content);
    if (!parsed || typeof parsed !== "object") {return {};}
    return parsed as ObjectYamlConfig;
  } catch {
    // Fall back to the simple parser for minimal files
    return parseSimpleYaml(content) as ObjectYamlConfig;
  }
}

/**
 * Read and parse a .object.yaml from disk.
 * Returns null if the file does not exist.
 */
export function readObjectYaml(objectDir: string): ObjectYamlConfig | null {
  const wsRoot = resolveWorkspaceRoot();
  const resolvedRoot = wsRoot ? resolve(wsRoot) : null;
  const yamlPath = join(resolve(objectDir), ".object.yaml");

  if (resolvedRoot && !yamlPath.startsWith(resolvedRoot + "/")) {return null;}
  if (!existsSync(yamlPath)) {return null;}
  const raw = readFileSync(yamlPath, "utf-8");
  return parseObjectYaml(raw);
}

/**
 * Read just the `icon:` field from an object's .object.yaml. Returns undefined
 * if the object directory is not found, the yaml is missing, or the file lacks
 * an `icon:` key. This is the canonical way to look up an object's icon —
 * `.object.yaml` is the single source of truth (the legacy DuckDB
 * `objects.icon` column has been retired).
 */
export function readObjectYamlIcon(objectName: string): string | undefined {
  const dir = findObjectDir(objectName);
  if (!dir) {return undefined;}
  const cfg = readObjectYaml(dir);
  const icon = cfg?.icon;
  return typeof icon === "string" && icon.trim() !== "" ? icon : undefined;
}

/**
 * Write a .object.yaml file, merging view config with existing top-level keys.
 */
export function writeObjectYaml(objectDir: string, config: ObjectYamlConfig): void {
  const wsRoot = resolveWorkspaceRoot();
  const resolvedRoot = wsRoot ? resolve(wsRoot) : null;
  const yamlPath = join(resolve(objectDir), ".object.yaml");

  if (resolvedRoot && !yamlPath.startsWith(resolvedRoot + "/")) {
    throw new Error("Object directory must be within the workspace.");
  }

  let existing: ObjectYamlConfig = {};
  if (existsSync(yamlPath)) {
    try {
      existing = parseObjectYaml(readFileSync(yamlPath, "utf-8"));
    } catch {
      existing = {};
    }
  }

  const merged = { ...existing, ...config };

  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) {delete merged[key];}
  }

  const yamlStr = YAML.stringify(merged, { indent: 2, lineWidth: 0 });
  writeFileSync(yamlPath, yamlStr, "utf-8");
}

/**
 * Find the filesystem directory for an object by name.
 * Recursively walks the workspace tree looking for a directory containing a
 * .object.yaml matching the given object name. This ensures objects nested
 * inside category folders (e.g. marketing/influencer) are discovered correctly.
 */
export function findObjectDir(objectName: string): string | null {
  const root = resolveWorkspaceRoot();
  if (!root) {return null;}

  const resolvedRoot = resolve(root);
  const direct = join(resolvedRoot, objectName);
  if (!direct.startsWith(resolvedRoot + "/")) {return null;}
  if (existsSync(direct) && existsSync(join(direct, ".object.yaml"))) {
    return direct;
  }

  // Recursively search for a directory named {objectName} containing .object.yaml.
  // Depth-limited to avoid traversing heavy subtrees.
  const MAX_DEPTH = 4;
  const SKIP_DIRS = new Set(["node_modules", ".git", ".next", "tmp", "exports"]);

  function search(dir: string, depth: number): string | null {
    if (depth > MAX_DEPTH) {return null;}
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) {continue;}
        const subDir = join(dir, entry.name);
        if (entry.name === objectName && existsSync(join(subDir, ".object.yaml"))) {
          return subDir;
        }
        const found = search(subDir, depth + 1);
        if (found) {return found;}
      }
    } catch {
      // ignore read errors (permission denied, etc.)
    }
    return null;
  }

  return search(root, 1);
}

/**
 * Get saved views for an object from its .object.yaml.
 */
export function getObjectViews(objectName: string): {
  views: SavedView[];
  activeView: string | undefined;
  viewSettings: ViewTypeSettings | undefined;
} {
  const dir = findObjectDir(objectName);
  if (!dir) {return { views: [], activeView: undefined, viewSettings: undefined };}

  const config = readObjectYaml(dir);
  if (!config) {return { views: [], activeView: undefined, viewSettings: undefined };}

  return {
    views: (config.views ?? []).map((v) => ({
      ...v,
      filters: v.filters ? normalizeFilterGroup(v.filters) : undefined,
    })),
    activeView: config.active_view,
    viewSettings: config.view_settings,
  };
}

/**
 * Save views for an object to its .object.yaml.
 */
export function saveObjectViews(
  objectName: string,
  views: SavedView[],
  activeView?: string,
  viewSettings?: ViewTypeSettings,
): boolean {
  const dir = findObjectDir(objectName);
  if (!dir) {return false;}

  const patch: ObjectYamlConfig = {
    views: views.length > 0 ? views : undefined,
    active_view: activeView,
  };
  if (viewSettings) {
    patch.view_settings = viewSettings;
  }
  writeObjectYaml(dir, patch);
  return true;
}

// --- System file protection ---

/** Always protected regardless of depth. */
const ALWAYS_SYSTEM_PATTERNS = [
  /^\.object\.yaml$/,
  /\.wal$/,
  /\.tmp$/,
];

/** Only protected at the workspace root (no "/" in the relative path). */
const ROOT_ONLY_SYSTEM_PATTERNS = [
  /^workspace\.duckdb/,
  /^workspace_context\.yaml$/,
];

/** Check if a workspace-relative path refers to a protected system file. */
export function isSystemFile(relativePath: string): boolean {
  const base = relativePath.split("/").pop() ?? "";
  if (ALWAYS_SYSTEM_PATTERNS.some((p) => p.test(base))) {return true;}
  const isRoot = !relativePath.includes("/");
  return isRoot && ROOT_ONLY_SYSTEM_PATTERNS.some((p) => p.test(base));
}

export function isProtectedSystemPath(
  resolvedPath: ResolvedFilesystemPath | null,
): boolean {
  if (!resolvedPath?.withinWorkspace || resolvedPath.workspaceRelativePath == null) {
    return false;
  }
  return isSystemFile(resolvedPath.workspaceRelativePath);
}

/**
 * Like safeResolvePath but does NOT require the target to exist on disk.
 * Useful for mkdir / create / rename-target validation.
 * Still prevents path traversal.
 */
export function safeResolveNewPath(relativePath: string): string | null {
  const resolvedPath = resolveFilesystemPath(relativePath, { allowMissing: true });
  if (!resolvedPath || resolvedPath.kind !== "workspaceRelative") {return null;}
  return resolvedPath.absolutePath;
}

/**
 * Read a file from the workspace safely.
 * Returns content and detected type, or null if not found.
 */
export function readWorkspaceFile(
  relativePath: string,
): { content: string; type: "markdown" | "yaml" | "text" } | null {
  const absolute = safeResolvePath(relativePath);
  if (!absolute) {return null;}

  try {
    const content = readFileSync(absolute, "utf-8");
    const ext = relativePath.split(".").pop()?.toLowerCase();

    let type: "markdown" | "yaml" | "text" = "text";
    if (ext === "md" || ext === "mdx") {type = "markdown";}
    else if (ext === "yaml" || ext === "yml") {type = "yaml";}

    return { content, type };
  } catch {
    return null;
  }
}
