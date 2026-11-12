import { describe, expect, it } from "vitest";
import { buildAgentMessage } from "./agent-message";
import type { TableSelectionContext } from "./table-selection";

describe("buildAgentMessage", () => {
	it("returns userText unchanged when no context is provided", () => {
		expect(buildAgentMessage({ userText: "hello" })).toBe("hello");
	});

	it("does not touch [Attached files: ...] already in userText", () => {
		// [Attached files: ...] stays in the message text (chat-message.tsx
		// parses it for the AttachedFilesCard); buildAgentMessage only
		// layers agent-only prefixes on top.
		expect(
			buildAgentMessage({
				userText: "[Attached files: a.md]\n\nsummarize",
			}),
		).toBe("[Attached files: a.md]\n\nsummarize");
	});

	it("prepends [Context: workspace file '...'] when filePath is provided", () => {
		expect(
			buildAgentMessage({
				userText: "what is this?",
				workspaceContext: { filePath: "doc.md", isDirectory: false },
			}),
		).toBe("[Context: workspace file 'doc.md']\n\nwhat is this?");
	});

	it("uses 'directory' label for directory contexts", () => {
		expect(
			buildAgentMessage({
				userText: "list everyone",
				workspaceContext: { filePath: "~crm/people", isDirectory: true },
			}),
		).toBe(
			"[Context: workspace directory '~crm/people']\n\nlist everyone",
		);
	});

	it("applies the workspace prefix to file context paths", () => {
		expect(
			buildAgentMessage({
				userText: "ok",
				workspaceContext: { filePath: "doc.md", isDirectory: false },
				workspacePrefix: "/home/user/.openclaw/work",
			}),
		).toBe(
			"[Context: workspace file '/home/user/.openclaw/work/doc.md']\n\nok",
		);
	});

	it("applies the workspace prefix to real (relative) directory paths", () => {
		// Real workspace directories are relative to the workspace root, so
		// the agent needs the absolute path to operate on them.
		expect(
			buildAgentMessage({
				userText: "list",
				workspaceContext: { filePath: "subdir", isDirectory: true },
				workspacePrefix: "/home/user/.openclaw/work",
			}),
		).toBe(
			"[Context: workspace directory '/home/user/.openclaw/work/subdir']\n\nlist",
		);
	});

	it("does NOT apply the workspace prefix to virtual (~...) directory paths", () => {
		// Virtual surfaces like `~crm/people`, `~cloud`, `~skills` are
		// handled by tool routing on the agent side. Prefixing them would
		// produce nonsensical paths like `<wsRoot>/~crm/people`.
		expect(
			buildAgentMessage({
				userText: "list",
				workspaceContext: { filePath: "~crm/people", isDirectory: true },
				workspacePrefix: "/home/user/.openclaw/work",
			}),
		).toBe("[Context: workspace directory '~crm/people']\n\nlist");

		expect(
			buildAgentMessage({
				userText: "open",
				workspaceContext: { filePath: "~cloud", isDirectory: true },
				workspacePrefix: "/home/user/.openclaw/work",
			}),
		).toBe("[Context: workspace directory '~cloud']\n\nopen");
	});

	it("does NOT double-prefix already-absolute paths", () => {
		// Some legacy chats persisted absolute paths in fileContext.path
		// (e.g. `/Users/me/.openclaw-dench/openclaw.json`). Double-prefixing
		// them would produce paths like `<wsRoot>//Users/me/...`.
		expect(
			buildAgentMessage({
				userText: "what is this?",
				workspaceContext: {
					filePath: "/Users/me/.openclaw-dench/openclaw.json",
					isDirectory: false,
				},
				workspacePrefix: "/home/user/.openclaw/work",
			}),
		).toBe(
			"[Context: workspace file '/Users/me/.openclaw-dench/openclaw.json']\n\nwhat is this?",
		);
	});

	it("prepends a [Selected table ...] block when tableSelection is provided", () => {
		const selection: TableSelectionContext = {
			objectName: "people",
			kind: "rows",
			rowCount: 1,
			columnCount: 2,
			columns: ["name", "email"],
			rows: [
				{
					rowIndex: 0,
					entryId: "p1",
					values: { name: "Ada", email: "ada@example.com" },
				},
			],
			updatedAt: 0,
		};
		const out = buildAgentMessage({
			userText: "anything weird?",
			workspaceContext: { tableSelection: selection },
		});
		expect(out).toContain("[Selected table rows: people]");
		expect(out).toContain("anything weird?");
	});

	it("orders prefixes: tableSelection > filePath > attachedFiles in userText", () => {
		const selection: TableSelectionContext = {
			objectName: "people",
			kind: "cells",
			rowCount: 1,
			columnCount: 1,
			columns: ["email"],
			cells: [
				{ rowIndex: 0, entryId: "p1", fieldName: "email", value: "x" },
			],
			updatedAt: 0,
		};
		// userText carries the attachments prefix that the client builds
		// inline; buildAgentMessage layers Context + Selected table on top.
		const out = buildAgentMessage({
			userText: "[Attached files: a.md]\n\ngo",
			workspaceContext: {
				filePath: "doc.md",
				isDirectory: false,
				tableSelection: selection,
			},
		});

		const tableIdx = out.indexOf("[Selected table");
		const ctxIdx = out.indexOf("[Context: workspace");
		const attIdx = out.indexOf("[Attached files:");
		const goIdx = out.indexOf("go");

		expect(tableIdx).toBeGreaterThanOrEqual(0);
		expect(tableIdx).toBeLessThan(ctxIdx);
		expect(ctxIdx).toBeLessThan(attIdx);
		expect(attIdx).toBeLessThan(goIdx);
	});
});

describe("attached file paths", () => {
	it("gives the agent absolute paths for relative uploads and strips them back", async () => {
		const { stripAgentMessageContext } = await import("./agent-message");
		const user = "[Attached files: assets/1-cv.pdf, /abs/x.png, ~crm/p]\n\nread it";
		const sent = buildAgentMessage({ userText: user, workspacePrefix: "/ws/root/" });
		expect(sent).toBe("[Attached files: /ws/root/assets/1-cv.pdf, /abs/x.png, ~crm/p]\n\nread it");
		expect(stripAgentMessageContext(sent, "/ws/root")).toBe(user);
	});
});
