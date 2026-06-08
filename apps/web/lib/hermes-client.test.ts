import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HermesConfig } from "./agent-backend";

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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ run_id: "run_123", status: "started" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { createHermesChatStream } = await import("./hermes-client");
    const stream = createHermesChatStream({
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ run_id: "run_456", status: "started" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const { createHermesChatStream } = await import("./hermes-client");
    const stream = createHermesChatStream({
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

    const { createHermesChatStream } = await import("./hermes-client");
    const stream = createHermesChatStream({
      sessionKey: "sess_xyz",
      message: "Hi",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("hermes-error");
    expect(events[0].status).toBe(401);
  });

  it("returns an SSE stream with an error event when no apiKey is provided", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const { createHermesChatStream } = await import("./hermes-client");
    const stream = createHermesChatStream({
      sessionKey: "sess_xyz",
      message: "Hi",
      config: { ...config, apiKey: "" },
    });

    const events = await readSseEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("hermes-error");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("returns an SSE stream with an error event on fetch failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network error"),
    );

    const { createHermesChatStream } = await import("./hermes-client");
    const stream = createHermesChatStream({
      sessionKey: "sess_xyz",
      message: "Hi",
      config,
    });

    const events = await readSseEvents(stream);
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("hermes-error");
  });
});
