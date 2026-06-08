import { beforeEach, describe, expect, it, vi } from "vitest";

const startTerminalServer = vi.hoisted(() => vi.fn());
const startChatAgentGc = vi.hoisted(() => vi.fn());
const ensureLatestSchema = vi.hoisted(() => vi.fn());

vi.mock("../lib/terminal-server", () => ({ startTerminalServer }));
vi.mock("../lib/chat-agent-registry", () => ({ startChatAgentGc }));
vi.mock("../lib/workspace-schema-migrations", () => ({ ensureLatestSchema }));

describe("instrumentation register", () => {
	beforeEach(() => {
		vi.resetModules();
		startTerminalServer.mockReset();
		startChatAgentGc.mockReset();
		ensureLatestSchema.mockReset();
		process.env.NEXT_RUNTIME = "nodejs";
		delete process.env.CRM_DB_BACKEND;
	});

	it("skips DuckDB workspace migrations when Postgres backend is enabled", async () => {
		process.env.CRM_DB_BACKEND = "postgres";
		const { register } = await import("../instrumentation");

		await register();

		expect(startTerminalServer).toHaveBeenCalled();
		expect(startChatAgentGc).toHaveBeenCalled();
		expect(ensureLatestSchema).not.toHaveBeenCalled();
	});
});
