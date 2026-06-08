import type { PathOrFileDescriptor } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/active-runs", () => ({
	startSubscribeRun: vi.fn(() => ({ status: "completed" })),
	getActiveRun: vi.fn(),
	subscribeToRun: vi.fn(() => () => {}),
	reactivateSubscribeRun: vi.fn(() => true),
}));

vi.mock("@/lib/agent-backend", () => ({
	resolveAgentBackend: vi.fn(() => "openclaw"),
	resolveHermesConfig: vi.fn(() => ({
		baseUrl: "http://127.0.0.1:8642",
		apiKey: "sk-test",
		model: "hermes-agent",
	})),
}));

vi.mock("@/lib/hermes-client", () => ({
	createHermesChatStream: vi.fn(async () => {
		const encoder = new TextEncoder();
		return new ReadableStream({
			start(controller) {
				controller.enqueue(encoder.encode('data: {"type":"hermes-event"}\n'));
				controller.close();
			},
		});
	}),
}));

vi.mock("@/lib/workspace", () => ({
	resolveWorkspaceRoot: vi.fn(() => "/home/testuser/.openclaw-dench/workspace"),
}));

vi.mock("node:fs", () => ({
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn((_path: PathOrFileDescriptor, options?: unknown) =>
		typeof options === "string" ? "{}" : Buffer.from(""),
	),
}));

describe("POST /api/gateway/chat", () => {
	beforeEach(async () => {
		vi.resetModules();
		const { getActiveRun, subscribeToRun, startSubscribeRun, reactivateSubscribeRun } = await import("@/lib/active-runs");
		vi.mocked(getActiveRun).mockReset();
		vi.mocked(getActiveRun).mockReturnValue(undefined);
		vi.mocked(subscribeToRun).mockReset();
		vi.mocked(subscribeToRun).mockReturnValue(() => {});
		vi.mocked(startSubscribeRun).mockReset();
		vi.mocked(startSubscribeRun).mockReturnValue({ status: "completed" } as never);
		vi.mocked(reactivateSubscribeRun).mockReset();
		vi.mocked(reactivateSubscribeRun).mockReturnValue(true);

		const { resolveAgentBackend, resolveHermesConfig } = await import("@/lib/agent-backend");
		vi.mocked(resolveAgentBackend).mockReset();
		vi.mocked(resolveAgentBackend).mockReturnValue("openclaw");
		vi.mocked(resolveHermesConfig).mockReset();
		vi.mocked(resolveHermesConfig).mockReturnValue({
			baseUrl: "http://127.0.0.1:8642",
			apiKey: "sk-test",
			model: "hermes-agent",
		});

		const { createHermesChatStream } = await import("@/lib/hermes-client");
		vi.mocked(createHermesChatStream).mockReset();
		vi.mocked(createHermesChatStream).mockImplementation(async () => {
			const encoder = new TextEncoder();
			return new ReadableStream({
				start(controller) {
					controller.enqueue(encoder.encode('data: {"type":"hermes-event"}\n'));
					controller.close();
				},
			});
		});

		const { existsSync, readFileSync } = await import("node:fs");
		vi.mocked(existsSync).mockReset();
		vi.mocked(existsSync).mockReturnValue(false);
		vi.mocked(readFileSync).mockReset();
		vi.mocked(readFileSync).mockImplementation((_path: PathOrFileDescriptor, options?: unknown) =>
			typeof options === "string" ? "{}" : Buffer.from(""),
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("hydrates attached images before reactivating the gateway run", async () => {
		const { getActiveRun, reactivateSubscribeRun } = await import("@/lib/active-runs");
		vi.mocked(getActiveRun).mockReturnValue({ status: "completed" } as never);

		const { existsSync, readFileSync } = await import("node:fs");
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((_path: PathOrFileDescriptor, options?: unknown) =>
			typeof options === "string" ? "{}" : Buffer.from("gateway-image")
		);

		const { POST } = await import("./route.js");
		const req = new Request("http://localhost/api/gateway/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionKey: "gateway-thread",
				message: "[Attached files: assets/gateway.png]\n\nread this",
			}),
		});

		const res = await POST(req);

		expect(res.status).toBe(200);
		expect(reactivateSubscribeRun).toHaveBeenCalledWith(
			"gateway-thread",
			expect.stringContaining("assets/gateway.png"),
			[
				expect.objectContaining({
					fileName: "gateway.png",
					mimeType: "image/png",
					content: Buffer.from("gateway-image").toString("base64"),
				}),
			],
		);
	});

	it("uses OpenClaw path by default when DENCH_AGENT_BACKEND is not set", async () => {
		const { resolveAgentBackend } = await import("@/lib/agent-backend");
		vi.mocked(resolveAgentBackend).mockReturnValue("openclaw");

		const { POST } = await import("./route.js");
		const req = new Request("http://localhost/api/gateway/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionKey: "test-session",
				message: "Hello OpenClaw",
			}),
		});

		const res = await POST(req);

		expect(res.status).toBe(200);
		expect(res.headers.get("X-Agent-Backend")).toBeNull();

		const { getActiveRun } = await import("@/lib/active-runs");
		expect(getActiveRun).toHaveBeenCalledWith("test-session");
	});

	it("uses Hermes path when DENCH_AGENT_BACKEND is hermes", async () => {
		const { resolveAgentBackend } = await import("@/lib/agent-backend");
		vi.mocked(resolveAgentBackend).mockReturnValue("hermes");

		const { createHermesChatStream } = await import("@/lib/hermes-client");

		const { POST } = await import("./route.js");
		const req = new Request("http://localhost/api/gateway/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionKey: "hermes-session",
				message: "Hello Hermes",
			}),
		});

		const res = await POST(req);

		expect(res.status).toBe(200);
		expect(res.headers.get("X-Agent-Backend")).toBe("hermes");
		expect(res.headers.get("Content-Type")).toBe("text/event-stream");
		expect(createHermesChatStream).toHaveBeenCalledWith({
			sessionKey: "hermes-session",
			message: "Hello Hermes",
			config: expect.objectContaining({
				baseUrl: "http://127.0.0.1:8642",
				apiKey: "sk-test",
				model: "hermes-agent",
			}),
		});

		const text = await res.text();
		expect(text).toContain("hermes-event");
	});

	it("rejects oversized gateway image attachments", async () => {
		const { existsSync, readFileSync } = await import("node:fs");
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(readFileSync).mockImplementation((_path: PathOrFileDescriptor, options?: unknown) =>
			typeof options === "string" ? "{}" : Buffer.alloc(5 * 1024 * 1024 + 1)
		);

		const { reactivateSubscribeRun } = await import("@/lib/active-runs");
		const { POST } = await import("./route.js");
		const req = new Request("http://localhost/api/gateway/chat", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				sessionKey: "gateway-thread",
				message: "[Attached files: assets/too-large.png]",
			}),
		});

		const res = await POST(req);

		expect(res.status).toBe(400);
		await expect(res.text()).resolves.toContain("exceeds the 5 MB limit");
		expect(reactivateSubscribeRun).not.toHaveBeenCalled();
	});
});
