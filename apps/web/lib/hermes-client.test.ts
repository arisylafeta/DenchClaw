import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesConfig } from "./agent-backend";
import { createHermesChatStream } from "./hermes-client";

const config: HermesConfig = {
  baseUrl: "https://hermes.example.com",
  apiKey: "sk-test-key",
  model: "hermes-agent",
};

function sseBody(...events: Array<Record<string, unknown>>): string {
  return events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
}

async function readSseEvents(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const events: Record<string, unknown>[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) {break;}
    const text = decoder.decode(value, { stream: true });
    for (const line of text.split("\n")) {
      if (line.startsWith("data: ")) {
        const json = line.slice(6).trim();
        if (json && json !== "[DONE]") {
          events.push(JSON.parse(json));
        }
      }
    }
  }

  return events;
}

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("createHermesChatStream", () => {
  it("posts to Hermes runs API with bearer auth and session key", async () => {
    const fetchSpy = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ run_id: "run_123", status: "started" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/runs/run_123/events")) {
        return new Response(
          sseBody(
            { event: "message.delta", delta: "done" },
            { event: "run.completed", output: "done" },
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "sess_abc",
      message: "Hello Hermes",
      config,
    });

    await readSseEvents(stream);

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://hermes.example.com/v1/runs");
    expect(init?.method).toBe("POST");

    const headers = new Headers(init?.headers as HeadersInit);
    expect(headers.get("authorization")).toBe("Bearer sk-test-key");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("x-hermes-session-key")).toBe("sess_abc");

    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({
      input: "Hello Hermes",
      session_id: "sess_abc",
      model: "hermes-agent",
    });
  });

  it("streams text deltas from Hermes SSE events", async () => {
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(
          JSON.stringify({ run_id: "run_456", status: "started" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/runs/run_456/events")) {
        return new Response(
          sseBody(
            { event: "message.delta", delta: "Hello" },
            { event: "message.delta", delta: " world" },
            { event: "run.completed", output: "Hello world" },
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "sess_xyz",
      message: "Hi",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toEqual([
      { type: "text-start", id: expect.any(String) },
      { type: "text-delta", id: expect.any(String), delta: "Hello" },
      { type: "text-delta", id: expect.any(String), delta: " world" },
      { type: "text-end", id: expect.any(String) },
      { type: "finish" },
    ]);
    // All text events share the same id
    const textId = events[0].id;
    expect(events[1].id).toBe(textId);
    expect(events[2].id).toBe(textId);
    expect(events[3].id).toBe(textId);
  });

  it("streams tool calls from Hermes SSE events", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/runs")) {
        return new Response(
          JSON.stringify({ run_id: "run_tools", status: "started" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/runs/run_tools/events")) {
        return new Response(
          sseBody(
            { event: "tool.started", tool: "exa_search", preview: "test query" },
            { event: "tool.completed", tool: "exa_search", duration: 0.5, error: false },
            { event: "message.delta", delta: "Found results" },
            { event: "run.completed", output: "Found results" },
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "sess_tools",
      message: "search for test",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toEqual([
      { type: "tool-input-start", toolCallId: expect.any(String), toolName: "exa_search" },
      { type: "tool-input-available", toolCallId: expect.any(String), toolName: "exa_search", input: "test query" },
      { type: "tool-output-available", toolCallId: expect.any(String), output: "exa_search" },
      { type: "text-start", id: expect.any(String) },
      { type: "text-delta", id: expect.any(String), delta: "Found results" },
      { type: "text-end", id: expect.any(String) },
      { type: "finish" },
    ]);
  });

  it("streams reasoning from Hermes SSE events", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/runs")) {
        return new Response(
          JSON.stringify({ run_id: "run_think", status: "started" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (url.includes("/v1/runs/run_think/events")) {
        return new Response(
          sseBody(
            { event: "reasoning.available", text: "Let me think..." },
            { event: "message.delta", delta: "Here is my answer" },
            { event: "run.completed", output: "Here is my answer" },
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("", { status: 404 });
    }) as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "sess_think",
      message: "think about this",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toEqual([
      { type: "reasoning-start", id: expect.any(String) },
      { type: "reasoning-delta", id: expect.any(String), delta: "Let me think..." },
      { type: "reasoning-end", id: expect.any(String) },
      { type: "text-start", id: expect.any(String) },
      { type: "text-delta", id: expect.any(String), delta: "Here is my answer" },
      { type: "text-end", id: expect.any(String) },
      { type: "finish" },
    ]);
  });

  it("returns an SSE stream with an error event when Hermes rejects the run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: "Invalid API key" }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    const stream = await createHermesChatStream({
      sessionKey: "sess_xyz",
      message: "Hi",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(events[0].status).toBe(401);
  });

  it("returns an SSE stream with an error event when no apiKey is provided", async () => {
    const fetchSpy = vi.fn();
    globalThis.fetch = fetchSpy as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "sess_xyz",
      message: "Hi",
      config: { ...config, apiKey: null },
    });

    const events = await readSseEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns an SSE stream with an error event on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network error"),
    );

    const stream = await createHermesChatStream({
      sessionKey: "sess_xyz",
      message: "Hi",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("error");
  });

  it("calls the events endpoint for streaming", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/v1/runs") && init?.method === "POST") {
        return new Response(JSON.stringify({ run_id: "run_1", status: "started" }), { status: 202 });
      }
      if (url.includes("/v1/runs/run_1/events")) {
        return new Response(
          sseBody(
            { event: "message.delta", delta: "Hello world!" },
            { event: "run.completed", output: "Hello world!" },
          ),
          { status: 200, headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "agent:main:web:abc",
      message: "hello",
      config: { baseUrl: "http://127.0.0.1:8642", apiKey: "secret", model: "hermes-agent" },
    });
    const events = await readSseEvents(stream);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/v1/runs/run_1/events",
      expect.objectContaining({ method: "GET" }),
    );
    expect(events).toEqual([
      { type: "text-start", id: expect.any(String) },
      { type: "text-delta", id: expect.any(String), delta: "Hello world!" },
      { type: "text-end", id: expect.any(String) },
      { type: "finish" },
    ]);
  });
});
