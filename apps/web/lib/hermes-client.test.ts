import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesConfig } from "./agent-backend";
import { createHermesChatStream } from "./hermes-client";

const config: HermesConfig = {
  baseUrl: "https://hermes.example.com",
  apiKey: "sk-test-key",
  model: "hermes-agent",
};

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
        events.push(JSON.parse(line.slice(6)));
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
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/runs")) {
        return new Response(
          JSON.stringify({ run_id: "run_123", status: "started" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    });
    globalThis.fetch = fetchSpy as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "sess_abc",
      message: "Hello Hermes",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toHaveLength(1);

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

  it("returns an SSE stream that emits a start event when run starts", async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/runs")) {
        return new Response(
          JSON.stringify({ run_id: "run_456", status: "started" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
    }) as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "sess_xyz",
      message: "Hi",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toEqual([
      { type: "hermes-run-started", runId: "run_456", status: "started" },
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

  it("proxies Hermes run events after creating a run", async () => {
    const eventsBody = [
      "event: message",
      'data: {"type":"response.output_text.delta","delta":"Hi"}',
      "",
      "event: message",
      'data: {"type":"response.completed"}',
      "",
    ].join("\n");

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith("/v1/runs")) {
        return new Response(JSON.stringify({ run_id: "run_1", status: "started" }), { status: 202 });
      }
      return new Response(eventsBody, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const stream = await createHermesChatStream({
      sessionKey: "agent:main:web:abc",
      message: "hello",
      config: { baseUrl: "http://127.0.0.1:8642", apiKey: "secret", model: "hermes-agent" },
    });
    const text = await readStreamText(stream);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/v1/runs/run_1/events",
      expect.objectContaining({ method: "GET" }),
    );
    expect(text).toContain('"type":"text-delta"');
    expect(text).toContain('"textDelta":"Hi"');
    expect(text).toContain('"type":"finish"');
  });
});

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}
