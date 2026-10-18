import {
	formatTableSelectionContext,
	type TableSelectionContext,
} from "@/lib/table-selection";

/**
 * Workspace context attached to a chat message in addition to the user's
 * typed text. The client sends this as a separate body field on POST /api/chat
 * so these agent-only signals (`[Context: ...]`, `[Selected table ...]`)
 * never get baked into the persisted user message — that's what produced
 * ugly chat titles in the sidebar like `[Context: workspace file 'company']`.
 *
 * Note that `[Attached files: ...]` is intentionally NOT here: it stays in
 * the user message text because chat-message.tsx parses that prefix to
 * render the AttachedFilesCard. The session-title cleaner strips it.
 *
 * Each field is optional — clients only include a piece when it should
 * actually be announced to the agent on this turn (e.g. `filePath` is
 * omitted on subsequent turns once the path was already announced).
 */
export type WorkspaceContext = {
	/** Path of the active workspace file/directory the user is viewing. */
	filePath?: string;
	/** True when `filePath` is a directory or virtual surface (~crm/...). */
	isDirectory?: boolean;
	/** Snapshot of selected table rows/cells, formatted into prompt text. */
	tableSelection?: TableSelectionContext;
};

/**
 * Build the prompt the agent actually sees, by prepending the same
 * bracketed metadata blocks the client used to assemble inline. Order
 * matches the legacy client implementation so behavior is identical from
 * the agent's perspective.
 *
 * `[Attached files: ...]` (when present) is already in `userText`; this
 * helper only layers on the agent-only prefixes from `workspaceContext`.
 */
export function buildAgentMessage(args: {
	userText: string;
	workspaceContext?: WorkspaceContext;
	/** Optional workspace-root prefix (e.g. /home/ubuntu/.openclaw/work). */
	workspacePrefix?: string | null;
}): string {
	const { userText, workspaceContext, workspacePrefix } = args;
	let message = userText;

	const ctx = workspaceContext;
	if (!ctx) {
		return message;
	}

	if (ctx.filePath) {
		const label = ctx.isDirectory ? "directory" : "file";
		// Apply the workspace prefix to relative paths only — both files and
		// real workspace directories benefit from the absolute path, but:
		//   - virtual surfaces like `~crm/people`, `~cloud`, `~skills` are
		//     handled by tool routing on the agent side and would become
		//     nonsensical paths if we prefixed them (`<wsRoot>/~crm/people`).
		//   - already-absolute paths must not be double-prefixed.
		// The legacy server regex only matched `workspace file '...'` so
		// directories used to silently slip through unprefixed; this is the
		// path-shape-aware version that does the right thing for both.
		const isVirtual = ctx.filePath.startsWith("~");
		const isAbsolute = ctx.filePath.startsWith("/");
		const shouldPrefix = workspacePrefix && !isVirtual && !isAbsolute;
		const fullPath = shouldPrefix
			? `${workspacePrefix}/${ctx.filePath}`
			: ctx.filePath;
		message = `[Context: workspace ${label} '${fullPath}']\n\n${message}`;
	}

	if (ctx.tableSelection) {
		message = `${formatTableSelectionContext(ctx.tableSelection)}\n\n${message}`;
	}

	return message;
}

/** Undo only the agent-only blocks emitted by buildAgentMessage; preserve attachment cards. */
export function stripAgentMessageContext(text: string): string {
	let remaining = text;
	// Match the generated header, count, columns and preview lines, only at offset zero.
	const table = /^\[Selected table (rows|cells): [^\n]+\]\n\d+ rows?(?: x \d+ columns?)? selected\.\nColumns: [^\n]*(?:\n- (?:row \d+ \([^\n]*|\.\.\.\d+ more selected (?:rows|cells)))*\n\n/;
	remaining = remaining.replace(table, "");
	return remaining.replace(/^\[Context: workspace (?:file|directory) '[^\n]*'\]\n\n/, "");
}
