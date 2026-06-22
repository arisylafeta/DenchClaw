import { readdirSync, type Dirent } from "node:fs";
import { join, dirname, resolve, basename } from "node:path";
import { homedir } from "node:os";
import {
	resolveWorkspaceRoot,
	readObjectYamlIcon,
} from "@/lib/workspace";
import { searchPostgresEntries, searchPostgresObjects } from "@/lib/crm-postgres/suggest-files";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SuggestItem = {
	name: string;
	path: string;
	type: "folder" | "file" | "document" | "database" | "object" | "entry";
	/** Icon hint (emoji) for objects/entries */
	icon?: string;
	/** Object name that owns this entry */
	objectName?: string;
	/** DB entry ID */
	entryId?: string;
	/** Default view for objects (table or kanban) */
	defaultView?: "table" | "kanban";
};

const SKIP_DIRS = new Set([
	"node_modules",
	".git",
	".Trash",
	"__pycache__",
	".cache",
	".DS_Store",
]);

/** List entries in a directory, sorted folders-first then alphabetically. */
function listDir(
	absDir: string,
	filter?: string,
): SuggestItem[] {
	let entries: Dirent[];
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return [];
	}

	const lowerFilter = filter?.toLowerCase();
	const sorted = entries
		.filter((e) => !e.name.startsWith("."))
		.filter((e) => !(e.isDirectory() && SKIP_DIRS.has(e.name)))
		.filter((e) => !lowerFilter || e.name.toLowerCase().includes(lowerFilter))
		.toSorted((a, b) => {
			if (a.isDirectory() && !b.isDirectory()) {return -1;}
			if (!a.isDirectory() && b.isDirectory()) {return 1;}
			return a.name.localeCompare(b.name);
		});

	const items: SuggestItem[] = [];
	for (const entry of sorted) {
		if (items.length >= 30) {break;}
		const absPath = join(absDir, entry.name);

		if (entry.isDirectory()) {
			items.push({ name: entry.name, path: absPath, type: "folder" });
		} else if (entry.isFile()) {
			const ext = entry.name.split(".").pop()?.toLowerCase();
			const isDocument = ext === "md" || ext === "mdx";
			const isDatabase =
				ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db";
			items.push({
				name: entry.name,
				path: absPath,
				type: isDatabase ? "database" : isDocument ? "document" : "file",
			});
		}
	}
	return items;
}

/** Recursively search for files matching a query, up to a limit. */
function searchFiles(
	absDir: string,
	query: string,
	results: SuggestItem[],
	maxResults: number,
	depth = 0,
): void {
	if (depth > 6 || results.length >= maxResults) {return;}

	let entries: Dirent[];
	try {
		entries = readdirSync(absDir, { withFileTypes: true });
	} catch {
		return;
	}

	const lowerQuery = query.toLowerCase();
	for (const entry of entries) {
		if (results.length >= maxResults) {return;}
		if (entry.name.startsWith(".")) {continue;}
		if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {continue;}

		const absPath = join(absDir, entry.name);

		if (entry.isFile() && entry.name.toLowerCase().includes(lowerQuery)) {
			const ext = entry.name.split(".").pop()?.toLowerCase();
			const isDocument = ext === "md" || ext === "mdx";
			const isDatabase =
				ext === "duckdb" || ext === "sqlite" || ext === "sqlite3" || ext === "db";
			results.push({
				name: entry.name,
				path: absPath,
				type: isDatabase ? "database" : isDocument ? "document" : "file",
			});
		} else if (
			entry.isDirectory() &&
			entry.name.toLowerCase().includes(lowerQuery)
		) {
			results.push({ name: entry.name, path: absPath, type: "folder" });
		}

		if (entry.isDirectory()) {
			searchFiles(absPath, query, results, maxResults, depth + 1);
		}
	}
}

/**
 * Resolve a user-typed path query into a directory to list and an optional filter.
 *
 * Examples:
 *   "../"        → list parent of workspace root
 *   "/"          → list filesystem root
 *   "~/"         → list home dir
 *   "~/Doc"      → list home dir, filter "Doc"
 *   "src/utils"  → list <workspace>/src, filter "utils"
 *   "foo.ts"     → search by filename
 */
function resolvePath(
	raw: string,
	workspaceRoot: string,
): { dir: string; filter?: string } | null {
	const home = homedir();

	if (raw.startsWith("~/")) {
		const rest = raw.slice(2);
		if (!rest || rest.endsWith("/")) {
			// List the directory
			const dir = rest ? resolve(home, rest) : home;
			return { dir };
		}
		// Has a trailing segment → list parent, filter by segment
		const dir = resolve(home, dirname(rest));
		return { dir, filter: basename(rest) };
	}

	if (raw.startsWith("/")) {
		if (raw === "/") {return { dir: "/" };}
		if (raw.endsWith("/")) {
			return { dir: resolve(raw) };
		}
		const dir = dirname(resolve(raw));
		return { dir, filter: basename(raw) };
	}

	if (raw.startsWith("../") || raw === "..") {
		const resolved = resolve(workspaceRoot, raw);
		if (raw.endsWith("/") || raw === "..") {
			return { dir: resolved };
		}
		return { dir: dirname(resolved), filter: basename(resolved) };
	}

	if (raw.startsWith("./")) {
		const rest = raw.slice(2);
		if (!rest || rest.endsWith("/")) {
			const dir = rest ? resolve(workspaceRoot, rest) : workspaceRoot;
			return { dir };
		}
		const dir = resolve(workspaceRoot, dirname(rest));
		return { dir, filter: basename(rest) };
	}

	// Contains a slash → treat as relative path from workspace
	if (raw.includes("/")) {
		if (raw.endsWith("/")) {
			return { dir: resolve(workspaceRoot, raw) };
		}
		const dir = resolve(workspaceRoot, dirname(raw));
		return { dir, filter: basename(raw) };
	}

	// No path separator → this is a filename search
	return null;
}

// ---------------------------------------------------------------------------
// DuckDB object & entry search
// ---------------------------------------------------------------------------

type ObjectRow = {
	id: string;
	name: string;
	description?: string;
	display_field?: string;
	default_view?: string;
};

type FieldRow = {
	id: string;
	name: string;
	type: string;
	sort_order?: number;
};

function sqlEscape(s: string): string {
	return s.replace(/'/g, "''");
}

function resolveDisplayField(obj: ObjectRow, fields: FieldRow[]): string {
	if (obj.display_field) {return obj.display_field;}
	const nameField = fields.find(
		(f) => /\bname\b/i.test(f.name) || /\btitle\b/i.test(f.name),
	);
	if (nameField) {return nameField.name;}
	const textField = fields.find((f) => f.type === "text");
	if (textField) {return textField.name;}
	return fields[0]?.name ?? "id";
}

export async function GET(req: Request) {
	const url = new URL(req.url);
	const pathQuery = url.searchParams.get("path");
	const searchQuery = url.searchParams.get("q");
	const workspaceRoot = resolveWorkspaceRoot() ?? homedir();

	// Search mode: find files, objects, and entries by name
	if (searchQuery) {
		// File search: workspace only (skip expensive home dir traversal)
		const fileResults: SuggestItem[] = [];
		searchFiles(workspaceRoot, searchQuery, fileResults, 15);

		const objectResults = await searchPostgresObjects(searchQuery, 10);
		const entryResults = await searchPostgresEntries(searchQuery, 15);

		// Deduplicate: if an object matches, remove the duplicate folder
		const objectNames = new Set(objectResults.map((o) => o.name));
		const dedupedFiles = fileResults.filter(
			(f) => !(f.type === "folder" && objectNames.has(f.name)),
		);

		// Merge: objects first, then entries, then files
		const items = [...objectResults, ...entryResults, ...dedupedFiles].slice(0, 30);
		return Response.json({ items });
	}

	// Browse mode: resolve path and list directory
	if (pathQuery) {
		const resolved = resolvePath(pathQuery, workspaceRoot);
		if (!resolved) {
			const results: SuggestItem[] = [];
			searchFiles(workspaceRoot, pathQuery, results, 20);
			return Response.json({ items: results });
		}
		const items = listDir(resolved.dir, resolved.filter);
		return Response.json({ items });
	}

	// Default: list workspace root + all objects
	const fileItems = listDir(workspaceRoot);
	const objectItems = await searchPostgresObjects("", 20);
	// Deduplicate: if an object also appears as a folder, keep the object version
	const objectNames = new Set(objectItems.map((o) => o.name));
	const dedupedFiles = fileItems.filter(
		(f) => !(f.type === "folder" && objectNames.has(f.name)),
	);
	return Response.json({ items: [...objectItems, ...dedupedFiles] });
}
