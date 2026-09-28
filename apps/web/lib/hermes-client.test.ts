import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesConfig } from "./agent-backend";
import { createHermesChatStream, type HermesChatStreamParams } from "./hermes-client";
import { readActiveProfileName } from "./workspace";

vi.mock("./workspace", () => ({ readActiveProfileName: vi.fn(() => null) }));

const config: HermesConfig = {
  baseUrl: "https://hermes.example.com",
  apiKey: "test-key",
  model: "hermes-agent",
};
const sessionKey = "agent:main:web:abc";
const sessionsUrl = `${config.baseUrl}/api/sessions`;
const chatUrl = `${sessionsUrl}/${encodeURIComponent(sessionKey)}/chat/stream`;

// Mirrors api_server.py _sse_frame: native event names are NOT inside JSON.
function frame(name: string, payload: Record<string, unknown> = {}): string {
  return `event: ${name}\ndata: ${JSON.stringify(payload)}\n\n`;
}
function success(text = "Hello"): string {
  return (
    frame("assistant.delta", { delta: text }) +
    frame("assistant.completed", { content: text }) +
    frame("run.completed", { completed: true }) +
    frame("done")
  );
}
function created(): Response {
  return Response.json({ object: "hermes.session", session: { id: sessionKey } }, { status: 201 });
}
function exists(): Response {
  return Response.json(
    { error: { message: `Session already exists: ${sessionKey}`, code: "session_exists" } },
    { status: 409 },
  );
}
function mockStream(body: BodyInit | null, creation = created()) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(creation)
    .mockResolvedValueOnce(
      new Response(body, { headers: { "content-type": "text/event-stream" } }),
    );
}
async function chat(overrides: Partial<HermesChatStreamParams> = {}) {
  const stream = await createHermesChatStream({
    sessionKey,
    message: "Hi",
    userId: "test-user",
    config,
    ...overrides,
  });
  const text = await new Response(stream).text();
  return text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
}
function answer(events: Record<string, unknown>[]): string {
  return events
    .filter((event) => event.type === "text-delta")
    .map((event) => event.delta)
    .join("");
}

beforeEach(() => {
  vi.mocked(readActiveProfileName).mockReset().mockReturnValue(null);
});
afterEach(() => vi.restoreAllMocks());

describe("createHermesChatStream persisted sessions", () => {
  it.each([null, "default", "sales profile"])(
    "routes create and chat to the same profile %s with auth",
    async (profile) => {
      vi.mocked(readActiveProfileName).mockReturnValue(profile);
      const fetchSpy = mockStream(success());
      const events = await chat({ config: { ...config, baseUrl: `${config.baseUrl}/` } });
      const prefix = `${config.baseUrl}${profile ? `/p/${encodeURIComponent(profile)}` : ""}/api/sessions`;
      expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual([
        prefix,
        `${prefix}/${encodeURIComponent(sessionKey)}/chat/stream`,
      ]);
      expect(readActiveProfileName).toHaveBeenCalledTimes(1);
      for (const [, init] of fetchSpy.mock.calls) {
        expect(init?.method).toBe("POST");
        const headers = new Headers(init?.headers);
        expect(headers.get("authorization")).toBe("Bearer test-key");
        expect(headers.get("content-type")).toBe("application/json");
        expect(headers.get("x-hermes-session-key")).toBe(sessionKey);
      }
      expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toEqual({
        id: sessionKey,
        model: config.model,
      });
      expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body))).toEqual({
        message: "Hi",
        model: config.model,
      });
      expect(events.at(-1)).toEqual({ type: "finish" });
    },
  );

  it("resumes an existing session without resetting or replacing its history", async () => {
    const fetchSpy = mockStream(success("Resumed"), exists());
    expect(answer(await chat())).toBe("Resumed");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[1][0]).toBe(chatUrl);
  });

  it.each([
    [401, '{"error":"Unauthorized"}'],
    [404, '{"error":"Unknown or unconfigured profile"}'],
    [503, '{"error":{"code":"session_db_unavailable"}}'],
    [409, '{"error":{"code":"other_conflict"}}'],
    [409, "not JSON"],
  ])("fails closed on session creation %s without any stateless fallback", async (status, body) => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(body, { status }));
    expect(await chat()).toEqual([{ type: "error", errorText: body, status }]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it.each([400, 404, 429, 503])(
    "surfaces native chat HTTP %s without retrying statelessly",
    async (status) => {
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValueOnce(exists())
        .mockResolvedValueOnce(new Response("Chat rejected", { status }));
      expect(await chat()).toEqual([
        { type: "error", errorText: "Events stream failed: Chat rejected", status },
      ]);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      expect(fetchSpy.mock.calls[1][0]).toBe(chatUrl);
    },
  );
});

describe("native SSE translation", () => {
  it("preserves UI text ids and does not duplicate assistant.completed or finish on done", async () => {
    mockStream(
      frame("run.started") +
        frame("message.started") +
        frame("assistant.delta", { delta: "Hello" }) +
        frame("assistant.delta", { delta: " world" }) +
        frame("assistant.completed", { content: "Hello world" }) +
        frame("run.completed") +
        frame("done"),
    );
    const events = await chat();
    const id = events[0].id;
    expect(events).toEqual([
      { type: "text-start", id },
      { type: "text-delta", id, delta: "Hello" },
      { type: "text-delta", id, delta: " world" },
      { type: "text-end", id },
      { type: "finish" },
    ]);
    expect(id).toEqual(expect.any(String));
  });

  it("renders a final-only response", async () => {
    mockStream(
      frame("assistant.completed", { content: "Final only" }) +
        frame("run.completed") +
        frame("done"),
    );
    expect(answer(await chat())).toBe("Final only");
  });

  it("parses byte-split UTF-8, event/data lines, CRLF, comments and multiline data", async () => {
    const bytes = new TextEncoder().encode(
      ': keepalive\r\n\r\nevent: assistant.delta\r\ndata: {\r\ndata: "delta":"héllo 🦦"}\r\n\r\n' +
        frame("run.completed") +
        frame("done"),
    );
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) {
          controller.enqueue(new Uint8Array([byte]));
        }
        controller.close();
      },
    });
    mockStream(body);
    const events = await chat();
    expect(answer(events)).toBe("héllo 🦦");
    expect(events.at(-1)).toEqual({ type: "finish" });
  });

  it("maps native reasoning and tool payloads while closing UI blocks", async () => {
    mockStream(
      frame("tool.progress", { tool_name: "_thinking", delta: "Thinking" }) +
        frame("tool.started", { tool_name: "search", preview: "query", args: { q: "test" } }) +
        frame("tool.completed", { tool_name: "search" }) +
        frame("assistant.delta", { delta: "Found" }) +
        frame("tool.started", { tool_name: "read", preview: "file" }) +
        frame("tool.failed", { tool_name: "read", preview: "Permission denied" }) +
        frame("tool.progress", { tool_name: "_thinking", delta: "Reconsidering" }) +
        frame("assistant.delta", { delta: "Answer" }) +
        frame("run.completed") +
        frame("done"),
    );
    const events = await chat();
    expect(events.map((e) => e.type)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "tool-input-start",
      "tool-input-available",
      "tool-output-available",
      "text-start",
      "text-delta",
      "text-end",
      "tool-input-start",
      "tool-input-available",
      "tool-output-error",
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
      "finish",
    ]);
    expect(events[1]).toMatchObject({ id: events[0].id, delta: "Thinking" });
    expect(events[2].id).toBe(events[0].id);
    expect(events[4]).toMatchObject({
      toolCallId: events[3].toolCallId,
      toolName: "search",
      input: { q: "test" },
    });
    expect(events[5]).toMatchObject({ toolCallId: events[3].toolCallId, output: "Done: query" });
    expect(events[10]).toMatchObject({ toolCallId: events[9].toolCallId, input: "file" });
    expect(events[11]).toMatchObject({
      toolCallId: events[9].toolCallId,
      errorText: "Permission denied",
    });
  });

  it("closes reasoning on completion even without text", async () => {
    mockStream(
      frame("tool.progress", { tool_name: "_thinking", delta: "Thinking" }) +
        frame("run.completed") +
        frame("done"),
    );
    expect((await chat()).map((e) => e.type)).toEqual([
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "finish",
    ]);
  });

  it("preserves the native root error, closes blocks and does not finish on done", async () => {
    mockStream(
      frame("assistant.delta", { delta: "Partial" }) +
        frame("error", { message: "HTTP 429: The usage limit has been reached" }) +
        frame("done"),
    );
    const events = await chat();
    expect(events.map((e) => e.type)).toEqual(["text-start", "text-delta", "text-end", "error"]);
    expect(events.at(-1)).toEqual({
      type: "error",
      errorText: "HTTP 429: The usage limit has been reached",
    });
  });

  it.each([
    "",
    frame("done"),
    frame("assistant.delta", { delta: "Partial" }),
    "event: run.completed\ndata: {}",
  ])("does not report successful finish on a truncated stream %#", async (body) => {
    mockStream(body);
    const events = await chat();
    expect(events.at(-1)).toEqual({
      type: "error",
      errorText: "Hermes stream ended before run.completed",
    });
    expect(events.some((event) => event.type === "finish")).toBe(false);
  });

  it("surfaces malformed event JSON rather than silently losing content", async () => {
    mockStream("event: assistant.delta\ndata: invalid\n\n" + frame("run.completed"));
    const events = await chat();
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("reports a missing response body", async () => {
    mockStream(null);
    expect(await chat()).toEqual([{ type: "error", errorText: "No response body" }]);
  });

  it("does not fetch without an API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(await chat({ config: { ...config, apiKey: null } })).toEqual([
      { type: "error", errorText: "Missing Hermes API key" },
    ]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it.each(["create", "chat"])("surfaces a network failure during %s", async (step) => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    if (step === "chat") {
      fetchSpy.mockResolvedValueOnce(created());
    }
    fetchSpy.mockRejectedValueOnce(new Error("Network error"));
    expect(await chat()).toEqual([{ type: "error", errorText: "Network error" }]);
  });
});
