import type { PathOrFileDescriptor } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentBackend as backendForCutover } from "@/lib/agent-backend";
import { nativeFetch } from "@/lib/hermes-native";
import { POST as bridgeSubmit } from "./route";
vi.mock("@/lib/hermes-native", () => ({ hermesProfiles: () => ["alpha"], nativeFetch: vi.fn(async () => Response.json({ session: { id: "native-existing" } })) }));

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

vi.mock("@/lib/auth", () => ({
	currentUser: vi.fn(async () => ({
		id: "11111111-1111-4111-8111-111111111111",
		email: "ari@rebattery.io",
		displayName: "Ari",
	})),
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

  it("blocks all legacy Hermes submissions without probing session existence",async()=>{
    vi.mocked(backendForCutover).mockReturnValue("hermes");vi.mocked(nativeFetch).mockClear();
    for(const sessionKey of ["native-existing","unknown","other-private-session"]){
      const response=await bridgeSubmit(new Request("http://local/api/gateway/chat",{method:"POST",body:JSON.stringify({sessionKey,message:"[Attached files: /root/private.png]"})}));
      expect(response.status).toBe(409);expect(await response.json()).toEqual({error:"gateway_transport_required"});
    }
    expect(nativeFetch).not.toHaveBeenCalled();
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

	it("requires login even when the legacy Hermes bridge is disabled",async()=>{
      const {resolveAgentBackend}=await import("@/lib/agent-backend");const {currentUser}=await import("@/lib/auth");
      const {createHermesChatStream}=await import("@/lib/hermes-client");vi.mocked(resolveAgentBackend).mockReturnValue("hermes");vi.mocked(currentUser).mockResolvedValueOnce(null);
      const {POST}=await import("./route.js");const response=await POST(new Request("http://local",{method:"POST",body:"{}"}));
      expect(response.status).toBe(401);expect(createHermesChatStream).not.toHaveBeenCalled();
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
