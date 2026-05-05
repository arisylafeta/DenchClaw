import type { Dirent } from "node:fs";
import { access, readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  resolveWorkspaceRoot,
  resolveOpenClawStateDir,
  getActiveWorkspaceName,
  parseSimpleYaml,
  duckdbQueryAllAsync,
  isDatabaseFile,
} from "@/lib/workspace";
import { loadPostgresTreeObjects } from "@/lib/crm-postgres/tree";
import {
  projectMissingObjectsToFilesystem,
  type ProjectionTarget,
} from "@/lib/workspace-projection";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export type TreeNode = {
  name: string;
  path: string; // relative to workspace root (or ~skills/ for virtual nodes)
  type: "object" | "document" | "folder" | "file" | "database" | "report" | "app";
  icon?: string;
  defaultView?: "table" | "kanban";
  children?: TreeNode[];
  /** Virtual nodes live outside the main workspace. */
  virtual?: boolean;
  /** True when the entry is a symbolic link. */
  symlink?: boolean;
  /** App manifest metadata (only for type: "app"). */
  appManifest?: {
    name: string;
    description?: string;
    icon?: string;
    version?: string;
    entry?: string;
    runtime?: string;
  };
};

type DbObject = {
  name: string;
  id?: string | null;
  description?: string | null;
  default_view?: string;
};

/** Read .object.yaml metadata from a directory if it exists. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Read .object.yaml metadata from a directory if it exists. */
async function readObjectMeta(
  dirPath: string,
): Promise<{ icon?: string; defaultView?: string } | null> {
  const yamlPath = join(dirPath, ".object.yaml");
  if (!await pathExists(yamlPath)) {return null;}

  try {
    const content = await readFile(yamlPath, "utf-8");
    const parsed = parseSimpleYaml(content);
    return {
      icon: parsed.icon as string | undefined,
      defaultView: parsed.default_view as string | undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Query ALL discovered DuckDB files for objects so we can identify object
 * directories even when .object.yaml files are missing.
 * Shallower databases win on name conflicts (parent priority).
 *
 * The file tree intentionally shows object table folders, while a short list
 * of noisy sync backing tables follows the same show-hidden toggle as dotfiles.
 */
const ROOT_ONLY_HIDDEN_SYNC_OBJECTS = new Set([
  "calendar_event",
  "email_message",
  "email_thread",
  "interaction",
]);

async function loadDbObjects(): Promise<Map<string, DbObject>> {
  const objects = new Map<string, DbObject>();
  const rows = await duckdbQueryAllAsync<DbObject & { name: string }>(
    `SELECT o.id, o.name, o.description, o.default_view
     FROM objects o
     JOIN information_schema.tables t
       ON t.table_schema = 'main'
      AND t.table_type = 'VIEW'
      AND t.table_name = 'v_' || replace(o.name, '-', '_')`,
    "name",
  );
  for (const row of rows) {
    objects.set(row.name, row);
  }
  return objects;
}

/** Resolve a dirent's effective type, following symlinks to their target. */
async function resolveEntryType(
  entry: Dirent,
  absPath: string,
): Promise<"directory" | "file" | null> {
  if (entry.isDirectory()) {return "directory";}
  if (entry.isFile()) {return "file";}
  if (entry.isSymbolicLink()) {
    try {
      const st = await stat(absPath);
      if (st.isDirectory()) {return "directory";}
      if (st.isFile()) {return "file";}
    } catch {
      // Broken symlink -- skip
    }
  }
  return null;
}

/** Read .dench.yaml manifest from a .dench.app directory. */
async function readAppManifest(
  dirPath: string,
): Promise<TreeNode["appManifest"] | null> {
  const yamlPath = join(dirPath, ".dench.yaml");
  if (!await pathExists(yamlPath)) {return null;}

  try {
    const content = await readFile(yamlPath, "utf-8");
    const parsed = parseSimpleYaml(content);
    return {
      name: (parsed.name as string) || dirPath.split("/").pop()?.replace(/\.dench\.app$/, "") || "App",
      description: parsed.description as string | undefined,
      icon: parsed.icon as string | undefined,
      version: parsed.version as string | undefined,
      entry: (parsed.entry as string) || "index.html",
      runtime: (parsed.runtime as string) || "static",
    };
  } catch {
    return null;
  }
}

/** Recursively build a tree from a workspace directory. */
async function buildTree(
  absDir: string,
  relativeBase: string,
  dbObjects: Map<string, DbObject>,
  showHidden = false,
): Promise<TreeNode[]> {
  const nodes: TreeNode[] = [];

  let entries: Dirent[];
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch {
    return nodes;
  }

  const filtered = entries.filter((e) => {
    // .object.yaml is always needed for metadata; also shown as a node when showHidden is on
    if (e.name === ".object.yaml") {return true;}
    if (e.name.startsWith(".")) {return showHidden;}
    if (relativeBase === "" && ROOT_ONLY_HIDDEN_SYNC_OBJECTS.has(e.name)) {
      return showHidden;
    }
    return true;
  });

  // Sort: directories first, then files, alphabetical within each group
  const typedEntries = await Promise.all(filtered.map(async (entry) => {
    const absPath = join(absDir, entry.name);
    const effectiveType = await resolveEntryType(entry, absPath);
    return { entry, absPath, effectiveType };
  }));

  const sorted = typedEntries.toSorted((a, b) => {
    const dirA = a.effectiveType === "directory";
    const dirB = b.effectiveType === "directory";
    if (dirA && !dirB) {return -1;}
    if (!dirA && dirB) {return 1;}
    return a.entry.name.localeCompare(b.entry.name);
  });

  for (const { entry, absPath, effectiveType } of sorted) {
    // .object.yaml is consumed for metadata; only show it as a visible node when revealing hidden files
    if (entry.name === ".object.yaml" && !showHidden) {continue;}
    const relPath = relativeBase
      ? `${relativeBase}/${entry.name}`
      : entry.name;

    const isSymlink = entry.isSymbolicLink();

    if (effectiveType === "directory") {
      // Detect .dench.app folders -- treat as app nodes
      if (entry.name.endsWith(".dench.app")) {
        const manifest = await readAppManifest(absPath);
        const displayName = manifest?.name || entry.name.replace(/\.dench\.app$/, "");
        const children = showHidden ? await buildTree(absPath, relPath, dbObjects, showHidden) : undefined;
        nodes.push({
          name: displayName,
          path: relPath,
          type: "app",
          icon: manifest?.icon,
          appManifest: manifest ?? { name: displayName, entry: "index.html", runtime: "static" },
          ...(children && children.length > 0 && { children }),
          ...(isSymlink && { symlink: true }),
        });
        continue;
      }

      const objectMeta = await readObjectMeta(absPath);
      // DB-only object rows are projected to root-level object directories
      // before we build the tree. Do not classify nested folders by basename
      // alone, or ordinary folders like `marketing/influencers` duplicate the
      // `influencers` table in CRM navigation.
      const dbObject = relativeBase === "" ? dbObjects.get(entry.name) : undefined;
      const children = await buildTree(absPath, relPath, dbObjects, showHidden);

      if (objectMeta || dbObject) {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "object",
          icon: objectMeta?.icon,
          defaultView:
            ((objectMeta?.defaultView ?? dbObject?.default_view) as
              | "table"
              | "kanban") ?? "table",
          children: children.length > 0 ? children : undefined,
          ...(isSymlink && { symlink: true }),
        });
      } else {
        nodes.push({
          name: entry.name,
          path: relPath,
          type: "folder",
          children: children.length > 0 ? children : undefined,
          ...(isSymlink && { symlink: true }),
        });
      }
    } else if (effectiveType === "file") {
      const ext = entry.name.split(".").pop()?.toLowerCase();
      const isReport = entry.name.endsWith(".report.json");
      const isDocument = ext === "md" || ext === "mdx";
      const isDatabase = isDatabaseFile(entry.name);

      nodes.push({
        name: entry.name,
        path: relPath,
        type: isReport ? "report" : isDatabase ? "database" : isDocument ? "document" : "file",
        ...(isSymlink && { symlink: true }),
      });
    }
  }

  return nodes;
}


export async function GET(req: Request) {
  const url = new URL(req.url);
  const showHidden = url.searchParams.get("showHidden") === "1";

  const openclawDir = resolveOpenClawStateDir();
  const workspace = getActiveWorkspaceName();
  const root = resolveWorkspaceRoot();
  if (!root) {
    const tree: TreeNode[] = [];
    return Response.json({ tree, exists: false, workspaceRoot: null, openclawDir, workspace });
  }

  const dbObjects = process.env.CRM_DB_BACKEND === "postgres"
    ? await loadPostgresTreeObjects()
    : await loadDbObjects();

  // ── Self-heal: project DB-only objects to the filesystem ─────────────
  // The tree builder is filesystem-centric: a DuckDB row only becomes a
  // visible node if a directory and `.object.yaml` exist for it. Agents
  // (and a few legacy code paths) frequently insert into `objects`
  // without ever creating those filesystem entries — leaving rows
  // invisible in both the sidebar and the file tree, which the user
  // (correctly) experiences as "I created a table and it disappeared".
  //
  // To make the system converge regardless of how the row got into
  // DuckDB, every tree GET projects any missing object into the
  // workspace. The helper is idempotent, refuses to write outside the
  // workspace root, and never overwrites an existing `.object.yaml`,
  // so this is safe to run on every request. Errors are logged but do
  // not block the tree response — the tree still renders, the user just
  // doesn't see the (still DB-only) row this turn.
  try {
    const targets: ProjectionTarget[] = [];
    for (const obj of dbObjects.values()) {
      targets.push({
        name: obj.name,
        id: obj.id ?? null,
        description: obj.description ?? null,
        default_view: obj.default_view ?? null,
      });
    }
    if (targets.length > 0) {
      const results = projectMissingObjectsToFilesystem(root, targets);
      const errors = results.filter((r) => r.status === "error");
      if (errors.length > 0) {
        // Surface in server logs so we can diagnose persistent failures
        // (e.g. permission errors, exotic filesystems) without
        // breaking the user-facing tree.
        console.warn(
          "[workspace/tree] projection errors:",
          errors.map((e) => `${e.name}: ${e.reason ?? "unknown"}`).join("; "),
        );
      }
    }
  } catch (err) {
    // Defensive: never let projection break the tree response.
    console.warn(
      "[workspace/tree] projection threw:",
      err instanceof Error ? err.message : String(err),
    );
  }

  const tree = await buildTree(root, "", dbObjects, showHidden);

  return Response.json({ tree, exists: true, workspaceRoot: root, openclawDir, workspace });
}
