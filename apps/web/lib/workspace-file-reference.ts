import type { TreeNode } from "../app/hooks/use-workspace-watcher";
import { joinWorkspaceRoot } from "./workspace-paths";

function findExactNode(tree: TreeNode[], path: string): TreeNode | null {
  for (const node of tree) {
    if (node.path === path) return node;
    const child = node.children && findExactNode(node.children, path);
    if (child) return child;
  }
  return null;
}

/** Resolve a canonical file reference without fuzzy basename/knowledge fallbacks.
 * path-info is the existing server identity lookup; no envelope
 * workspace field is accepted as an access grant. Works before the tree arrives.
 */
export async function resolveWorkspaceFileReference(
  path: string,
  tree: TreeNode[],
  workspaceRoot: string | null,
): Promise<TreeNode | null> {
  if (!path || /^(https?:)?\/\//.test(path)) return null;
  if (!path.startsWith("/") && !path.startsWith("~/") && !path.startsWith("./") && !path.startsWith("../")) {
    const node = findExactNode(tree, path);
    if (node) return node;
  }
  let lookupPath = path;
  if (path.startsWith("~workspace/")) {
    if (!workspaceRoot) return null;
    lookupPath = joinWorkspaceRoot(workspaceRoot, path.slice("~workspace/".length));
  } else if (!path.startsWith("/") && !path.startsWith("~/")) {
    if (!workspaceRoot || path.startsWith("~")) return null;
    lookupPath = joinWorkspaceRoot(workspaceRoot, path);
  }
  // Always supply an explicit path: path-info's bare-name Spotlight fallback
  // must never choose a different file, and process cwd is not workspace root.
  const response = await fetch(`/api/workspace/path-info?path=${encodeURIComponent(lookupPath)}`);
  if (!response.ok) return null;
  const info = await response.json() as { path?: string; name?: string; type?: string };
  if (!info.path || !info.name || !["file", "directory"].includes(info.type ?? "")) return null;
  let nodePath = info.path;
  if (workspaceRoot && info.path.startsWith(`${workspaceRoot}/`)) {
    nodePath = info.path.slice(workspaceRoot.length + 1);
    const node = findExactNode(tree, nodePath);
    if (node) return node;
  }
  if (info.type === "directory") return { name: info.name, path: nodePath, type: "folder" };
  const extension = info.name.split(".").pop()?.toLowerCase();
  const type = info.name.endsWith(".dench.app") ? "app"
    : ["md", "mdx"].includes(extension ?? "") ? "document"
    : ["duckdb", "sqlite", "sqlite3", "db"].includes(extension ?? "") ? "database" : "file";
  return { name: info.name, path: nodePath, type };
}
