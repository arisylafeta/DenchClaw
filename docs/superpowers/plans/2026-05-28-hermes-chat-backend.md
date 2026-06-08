# Hermes Chat Backend Feature Flag Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install Hermes separately and add a Dench feature flag that routes CRM chat prompts to Hermes while preserving OpenClaw as the default fallback.

**Architecture:** Keep the CRM UI and existing `/api/gateway/chat` SSE contract unchanged. Add a small backend selector and Hermes HTTP client in `apps/web/lib`, then route chat POSTs to Hermes when `DENCH_AGENT_BACKEND=hermes`; otherwise use the current OpenClaw `active-runs` path. Hermes runs separately on localhost with its API server enabled.

**Tech Stack:** Next.js 15 route handlers, TypeScript, Vitest, Hermes Agent API server, systemd user services, Nginx unchanged.

---

## File Structure

- Modify: `/root/.config/systemd/user/dench-web-runtime.service`
  - Add feature flag and Hermes API env variables after code is implemented.
- Create: `/root/.config/systemd/user/hermes-gateway-dench.service`
  - Runs Hermes gateway/API server independently from OpenClaw.
- Create: `apps/web/lib/agent-backend.ts`
  - Owns feature flag parsing and backend selection.
- Create: `apps/web/lib/hermes-client.ts`
  - Owns Hermes HTTP calls and SSE parsing. No Dench route logic.
- Create: `apps/web/lib/hermes-client.test.ts`
  - Tests request shape, auth header, streaming event parsing, and error handling.
- Create: `apps/web/lib/agent-backend.test.ts`
  - Tests default OpenClaw behavior and Hermes opt-in behavior.
- Modify: `apps/web/app/api/gateway/chat/route.ts`
  - Branches between current OpenClaw run path and Hermes run path. Keeps response format as `text/event-stream`.
- Create or modify: `apps/web/app/api/gateway/chat/route.test.ts`
  - Tests route selection without needing a live Hermes server.

## Environment Contract

Use these environment variables:

```bash
DENCH_AGENT_BACKEND=openclaw
HERMES_API_BASE_URL=http://127.0.0.1:8642
HERMES_API_KEY=local-dench-hermes-key
HERMES_MODEL=hermes-agent
```

Rules:

- Missing `DENCH_AGENT_BACKEND` means `openclaw`.
- Only exact lowercase `hermes` activates Hermes.
- Hermes API base URL excludes `/v1`; code appends endpoint paths.
- `HERMES_API_KEY` is required only when `DENCH_AGENT_BACKEND=hermes`.
- If Hermes returns an error, the route returns an SSE error event instead of falling through to OpenClaw. This avoids silently sending prompts to the wrong backend.

---

### Task 1: Install And Configure Hermes Separately

**Files:**
- Create: `/root/.config/systemd/user/hermes-gateway-dench.service`
- Modify: `/root/.hermes/.env`

- [ ] **Step 1: Install Hermes**

Run:

```bash
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash
```

Expected:

```text
hermes
```

is installed under root's user environment, usually available from `~/.local/bin/hermes` after shell reload.

- [ ] **Step 2: Verify Hermes binary**

Run:

```bash
command -v hermes || command -v /root/.local/bin/hermes
```

Expected: one path is printed, for example:

```text
/root/.local/bin/hermes
```

- [ ] **Step 3: Create Hermes API env file**

Create or update `/root/.hermes/.env` with these lines:

```bash
API_SERVER_ENABLED=true
API_SERVER_HOST=127.0.0.1
API_SERVER_PORT=8642
API_SERVER_KEY=local-dench-hermes-key
API_SERVER_MODEL_NAME=hermes-agent
```

If `/root/.hermes/.env` already exists, append only missing keys and do not overwrite unrelated provider/model credentials.

- [ ] **Step 4: Create Hermes systemd user service**

Create `/root/.config/systemd/user/hermes-gateway-dench.service`:

```ini
[Unit]
Description=Hermes Gateway for Dench CRM
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
Type=simple
WorkingDirectory=/root
ExecStart=/root/.local/bin/hermes gateway
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
SuccessExitStatus=0 143
KillMode=control-group
Environment=HOME=/root
Environment=HERMES_HOME=/root/.hermes
Environment=PATH=/root/.local/bin:/usr/local/bin:/usr/bin:/bin

[Install]
WantedBy=default.target
```

- [ ] **Step 5: Enable and start Hermes service**

Run:

```bash
systemctl --user daemon-reload
systemctl --user enable --now hermes-gateway-dench.service
```

Expected:

```text
Created symlink ... hermes-gateway-dench.service
```

or no output if already enabled.

- [ ] **Step 6: Verify Hermes health**

Run:

```bash
curl -sS -H 'Authorization: Bearer local-dench-hermes-key' http://127.0.0.1:8642/health
```

Expected:

```json
{"status":"ok"}
```

- [ ] **Step 7: Verify models endpoint**

Run:

```bash
curl -sS -H 'Authorization: Bearer local-dench-hermes-key' http://127.0.0.1:8642/v1/models
```

Expected: JSON containing `hermes-agent`. If this fails due to missing provider setup, keep the service installed and complete code work; model/provider setup can be done after feature flag wiring.

---

### Task 2: Add Backend Feature Flag Parser

**Files:**
- Create: `apps/web/lib/agent-backend.ts`
- Create: `apps/web/lib/agent-backend.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/agent-backend.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";

const ORIGINAL_ENV = { ...process.env };

describe("agent backend selection", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("defaults to openclaw when DENCH_AGENT_BACKEND is missing", async () => {
    delete process.env.DENCH_AGENT_BACKEND;
    const { resolveAgentBackend } = await import("./agent-backend");
    expect(resolveAgentBackend()).toBe("openclaw");
  });

  it("uses hermes only for exact hermes flag", async () => {
    process.env.DENCH_AGENT_BACKEND = "hermes";
    const { resolveAgentBackend } = await import("./agent-backend");
    expect(resolveAgentBackend()).toBe("hermes");
  });

  it("falls back to openclaw for unknown values", async () => {
    process.env.DENCH_AGENT_BACKEND = "anything-else";
    const { resolveAgentBackend } = await import("./agent-backend");
    expect(resolveAgentBackend()).toBe("openclaw");
  });

  it("returns Hermes config from environment", async () => {
    process.env.HERMES_API_BASE_URL = "http://127.0.0.1:8642/";
    process.env.HERMES_API_KEY = "secret";
    process.env.HERMES_MODEL = "crm-agent";
    const { resolveHermesConfig } = await import("./agent-backend");
    expect(resolveHermesConfig()).toEqual({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "secret",
      model: "crm-agent",
    });
  });

  it("uses safe Hermes defaults for base URL and model", async () => {
    delete process.env.HERMES_API_BASE_URL;
    delete process.env.HERMES_MODEL;
    process.env.HERMES_API_KEY = "secret";
    const { resolveHermesConfig } = await import("./agent-backend");
    expect(resolveHermesConfig()).toEqual({
      baseUrl: "http://127.0.0.1:8642",
      apiKey: "secret",
      model: "hermes-agent",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run lib/agent-backend.test.ts
```

Expected: FAIL with module not found for `./agent-backend`.

- [ ] **Step 3: Implement feature flag parser**

Create `apps/web/lib/agent-backend.ts`:

```ts
export type AgentBackend = "openclaw" | "hermes";

export type HermesConfig = {
  baseUrl: string;
  apiKey: string | null;
  model: string;
};

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export function resolveAgentBackend(env: NodeJS.ProcessEnv = process.env): AgentBackend {
  return env.DENCH_AGENT_BACKEND === "hermes" ? "hermes" : "openclaw";
}

export function resolveHermesConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig {
  return {
    baseUrl: trimTrailingSlash(env.HERMES_API_BASE_URL?.trim() || "http://127.0.0.1:8642"),
    apiKey: env.HERMES_API_KEY?.trim() || null,
    model: env.HERMES_MODEL?.trim() || "hermes-agent",
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run lib/agent-backend.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git -C /root/.openclaw-dench/source/DenchClaw status --short
git -C /root/.openclaw-dench/source/DenchClaw add apps/web/lib/agent-backend.ts apps/web/lib/agent-backend.test.ts
git -C /root/.openclaw-dench/source/DenchClaw commit -m "feat: add agent backend feature flag"
```

Expected: commit succeeds. If the repository is intentionally not committing in this environment, record the dirty files and continue.

---

### Task 3: Add Hermes Client

**Files:**
- Create: `apps/web/lib/hermes-client.ts`
- Create: `apps/web/lib/hermes-client.test.ts`

- [ ] **Step 1: Write failing tests**

Create `apps/web/lib/hermes-client.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHermesChatStream } from "./hermes-client";

const ORIGINAL_FETCH = globalThis.fetch;

async function readStreamText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  out += decoder.decode();
  return out;
}

describe("hermes-client", () => {
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
  });

  it("posts to Hermes runs API with bearer auth and session key", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ run_id: "run_1", status: "started" }), { status: 202 }));
    globalThis.fetch = fetchMock as typeof fetch;

    await createHermesChatStream({
      sessionKey: "agent:main:web:abc",
      message: "hello",
      config: { baseUrl: "http://127.0.0.1:8642", apiKey: "secret", model: "hermes-agent" },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:8642/v1/runs",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer secret",
          "Content-Type": "application/json",
          "X-Hermes-Session-Key": "agent:main:web:abc",
        }),
      }),
    );
    const body = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(body).toEqual({
      input: "hello",
      session_id: "agent:main:web:abc",
      model: "hermes-agent",
    });
  });

  it("returns an SSE stream that emits a start event when run starts", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ run_id: "run_1", status: "started" }), { status: 202 })) as typeof fetch;
    const stream = await createHermesChatStream({
      sessionKey: "agent:main:web:abc",
      message: "hello",
      config: { baseUrl: "http://127.0.0.1:8642", apiKey: "secret", model: "hermes-agent" },
    });
    const text = await readStreamText(stream);
    expect(text).toContain('"type":"hermes-run-started"');
    expect(text).toContain('"runId":"run_1"');
  });

  it("returns an SSE stream with an error event when Hermes rejects the run", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad key", { status: 401 })) as typeof fetch;
    const stream = await createHermesChatStream({
      sessionKey: "agent:main:web:abc",
      message: "hello",
      config: { baseUrl: "http://127.0.0.1:8642", apiKey: "secret", model: "hermes-agent" },
    });
    const text = await readStreamText(stream);
    expect(text).toContain('"type":"error"');
    expect(text).toContain("Hermes request failed: 401 bad key");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run lib/hermes-client.test.ts
```

Expected: FAIL with module not found for `./hermes-client`.

- [ ] **Step 3: Implement Hermes client**

Create `apps/web/lib/hermes-client.ts`:

```ts
import type { HermesConfig } from "./agent-backend";

export type HermesChatStreamParams = {
  sessionKey: string;
  message: string;
  config: HermesConfig;
};

function encodeSse(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function errorStream(message: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encodeSse({ type: "error", errorText: message }));
      controller.close();
    },
  });
}

export async function createHermesChatStream(params: HermesChatStreamParams): Promise<ReadableStream<Uint8Array>> {
  const { sessionKey, message, config } = params;
  if (!config.apiKey) {
    return errorStream("HERMES_API_KEY is required when DENCH_AGENT_BACKEND=hermes");
  }

  try {
    const response = await fetch(`${config.baseUrl}/v1/runs`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "X-Hermes-Session-Key": sessionKey,
      },
      body: JSON.stringify({
        input: message,
        session_id: sessionKey,
        model: config.model,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      return errorStream(`Hermes request failed: ${response.status} ${body}`.trim());
    }

    const payload = await response.json() as { run_id?: unknown; status?: unknown };
    const runId = typeof payload.run_id === "string" ? payload.run_id : "";

    return new ReadableStream({
      start(controller) {
        controller.enqueue(encodeSse({
          type: "hermes-run-started",
          runId,
          status: typeof payload.status === "string" ? payload.status : "started",
        }));
        controller.close();
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return errorStream(`Hermes request failed: ${message}`);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run lib/hermes-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git -C /root/.openclaw-dench/source/DenchClaw status --short
git -C /root/.openclaw-dench/source/DenchClaw add apps/web/lib/hermes-client.ts apps/web/lib/hermes-client.test.ts
git -C /root/.openclaw-dench/source/DenchClaw commit -m "feat: add Hermes chat client"
```

Expected: commit succeeds, or dirty files are recorded if commits are not being made here.

---

### Task 4: Route Chat POST To Hermes Behind Feature Flag

**Files:**
- Modify: `apps/web/app/api/gateway/chat/route.ts`
- Create: `apps/web/app/api/gateway/chat/route.test.ts`

- [ ] **Step 1: Write failing route tests**

Create `apps/web/app/api/gateway/chat/route.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/chat-image-attachments", () => ({
  buildChatImageHydrationErrorMessage: () => null,
  hydrateMessageImageAttachments: () => ({ attachments: [], skipped: [] }),
}));

vi.mock("@/lib/active-runs", () => ({
  getActiveRun: vi.fn(() => undefined),
  reactivateSubscribeRun: vi.fn(),
  startSubscribeRun: vi.fn(() => ({ status: "running" })),
  subscribeToRun: vi.fn((_sessionKey, callback) => {
    callback({ type: "openclaw-event" });
    callback(null);
    return () => {};
  }),
}));

vi.mock("@/lib/hermes-client", () => ({
  createHermesChatStream: vi.fn(async () => new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"hermes-event"}\n\n'));
      controller.close();
    },
  })),
}));

const ORIGINAL_ENV = { ...process.env };

async function readResponseText(response: Response): Promise<string> {
  return await response.text();
}

describe("POST /api/gateway/chat", () => {
  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
    vi.resetModules();
  });

  it("uses OpenClaw path by default", async () => {
    delete process.env.DENCH_AGENT_BACKEND;
    const { POST } = await import("./route");
    const response = await POST(new Request("http://test/api/gateway/chat", {
      method: "POST",
      body: JSON.stringify({ sessionKey: "agent:main:web:abc", message: "hello" }),
    }));
    const text = await readResponseText(response);
    expect(text).toContain('"type":"openclaw-event"');
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("uses Hermes path when DENCH_AGENT_BACKEND=hermes", async () => {
    process.env.DENCH_AGENT_BACKEND = "hermes";
    process.env.HERMES_API_KEY = "secret";
    const { POST } = await import("./route");
    const response = await POST(new Request("http://test/api/gateway/chat", {
      method: "POST",
      body: JSON.stringify({ sessionKey: "agent:main:web:abc", message: "hello" }),
    }));
    const text = await readResponseText(response);
    expect(text).toContain('"type":"hermes-event"');
    expect(response.headers.get("Content-Type")).toContain("text/event-stream");
    expect(response.headers.get("X-Agent-Backend")).toBe("hermes");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run app/api/gateway/chat/route.test.ts
```

Expected: FAIL because the route does not yet branch to Hermes or set `X-Agent-Backend`.

- [ ] **Step 3: Modify chat route**

Update `apps/web/app/api/gateway/chat/route.ts` so the top imports include:

```ts
import { resolveAgentBackend, resolveHermesConfig } from "@/lib/agent-backend";
import { createHermesChatStream } from "@/lib/hermes-client";
```

Then add this branch after message validation and image hydration, before `getActiveRun(sessionKey)`:

```ts
  const backend = resolveAgentBackend();
  if (backend === "hermes") {
    const stream = await createHermesChatStream({
      sessionKey,
      message,
      config: resolveHermesConfig(),
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Agent-Backend": "hermes",
      },
    });
  }
```

Keep the existing OpenClaw code unchanged below that branch.

- [ ] **Step 4: Run route test to verify it passes**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run app/api/gateway/chat/route.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run existing agent-runner tests to verify OpenClaw path is intact**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run lib/agent-runner.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

Run:

```bash
git -C /root/.openclaw-dench/source/DenchClaw status --short
git -C /root/.openclaw-dench/source/DenchClaw add apps/web/app/api/gateway/chat/route.ts apps/web/app/api/gateway/chat/route.test.ts
git -C /root/.openclaw-dench/source/DenchClaw commit -m "feat: route chat to Hermes behind flag"
```

Expected: commit succeeds, or dirty files are recorded if commits are not being made here.

---

### Task 5: Improve Hermes Streaming To Relay Run Events

**Files:**
- Modify: `apps/web/lib/hermes-client.ts`
- Modify: `apps/web/lib/hermes-client.test.ts`

- [ ] **Step 1: Add failing streaming test**

Append this test to `apps/web/lib/hermes-client.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run lib/hermes-client.test.ts
```

Expected: FAIL because `createHermesChatStream` does not fetch `/v1/runs/{run_id}/events` yet.

- [ ] **Step 3: Implement event proxying**

Update `apps/web/lib/hermes-client.ts` by adding helpers:

```ts
function mapHermesEvent(raw: Record<string, unknown>): Record<string, unknown> | null {
  if (raw.type === "response.output_text.delta" && typeof raw.delta === "string") {
    return { type: "text-delta", textDelta: raw.delta };
  }
  if (raw.type === "response.completed" || raw.type === "run.completed") {
    return { type: "finish" };
  }
  if (typeof raw.type === "string" && raw.type.includes("tool")) {
    return { type: "tool-progress", data: raw };
  }
  return null;
}

function parseSseDataChunks(text: string): Record<string, unknown>[] {
  const chunks: Record<string, unknown>[] = [];
  for (const block of text.split("\n\n")) {
    const dataLines = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trim());
    if (dataLines.length === 0) continue;
    const data = dataLines.join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        chunks.push(parsed as Record<string, unknown>);
      }
    } catch {
      chunks.push({ type: "hermes.raw", text: data });
    }
  }
  return chunks;
}
```

Then replace the started-only stream body with a stream that fetches run events:

```ts
    return new ReadableStream({
      async start(controller) {
        controller.enqueue(encodeSse({
          type: "hermes-run-started",
          runId,
          status: typeof payload.status === "string" ? payload.status : "started",
        }));

        if (!runId) {
          controller.enqueue(encodeSse({ type: "error", errorText: "Hermes did not return run_id" }));
          controller.close();
          return;
        }

        const eventsResponse = await fetch(`${config.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "X-Hermes-Session-Key": sessionKey,
          },
        });

        if (!eventsResponse.ok) {
          const body = await eventsResponse.text().catch(() => "");
          controller.enqueue(encodeSse({ type: "error", errorText: `Hermes events failed: ${eventsResponse.status} ${body}`.trim() }));
          controller.close();
          return;
        }

        const text = await eventsResponse.text();
        for (const raw of parseSseDataChunks(text)) {
          const mapped = mapHermesEvent(raw);
          if (mapped) {
            controller.enqueue(encodeSse(mapped));
          }
        }
        controller.close();
      },
    });
```

- [ ] **Step 4: Run Hermes client tests**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run lib/hermes-client.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run:

```bash
git -C /root/.openclaw-dench/source/DenchClaw status --short
git -C /root/.openclaw-dench/source/DenchClaw add apps/web/lib/hermes-client.ts apps/web/lib/hermes-client.test.ts
git -C /root/.openclaw-dench/source/DenchClaw commit -m "feat: stream Hermes run events"
```

Expected: commit succeeds, or dirty files are recorded if commits are not being made here.

---

### Task 6: Wire Runtime Feature Flag

**Files:**
- Modify: `/root/.config/systemd/user/dench-web-runtime.service`

- [ ] **Step 1: Keep OpenClaw as default after deploy**

Before enabling Hermes routing, verify the service either lacks `DENCH_AGENT_BACKEND` or explicitly sets OpenClaw:

```ini
Environment=DENCH_AGENT_BACKEND=openclaw
Environment=HERMES_API_BASE_URL=http://127.0.0.1:8642
Environment=HERMES_API_KEY=local-dench-hermes-key
Environment=HERMES_MODEL=hermes-agent
```

- [ ] **Step 2: Reload Dench runtime with OpenClaw default**

Run:

```bash
systemctl --user daemon-reload
systemctl --user restart dench-web-runtime.service
```

Expected: service restarts.

- [ ] **Step 3: Verify CRM UI still loads**

Run:

```bash
curl -I --max-time 20 https://crm.rebattery.io
```

Expected: `HTTP/1.1 200 OK` and `X-Denchclaw-Version` header.

- [ ] **Step 4: Enable Hermes routing only after health passes**

Change the service env line to:

```ini
Environment=DENCH_AGENT_BACKEND=hermes
```

Then run:

```bash
systemctl --user daemon-reload
systemctl --user restart dench-web-runtime.service
```

Expected: Dench runtime restarts with Hermes backend enabled.

- [ ] **Step 5: Verify runtime env**

Run:

```bash
systemctl --user show dench-web-runtime.service --property=Environment
```

Expected: output includes:

```text
DENCH_AGENT_BACKEND=hermes
HERMES_API_BASE_URL=http://127.0.0.1:8642
```

---

### Task 7: Final Verification

**Files:**
- No code files.

- [ ] **Step 1: Run focused tests**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web vitest run lib/agent-backend.test.ts lib/hermes-client.test.ts app/api/gateway/chat/route.test.ts lib/agent-runner.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run web test suite if focused tests pass**

Run:

```bash
pnpm --dir /root/.openclaw-dench/source/DenchClaw/apps/web test
```

Expected: PASS. If unrelated tests fail, record exact failures and do not claim the full suite passes.

- [ ] **Step 3: Verify Hermes health**

Run:

```bash
curl -sS -H 'Authorization: Bearer local-dench-hermes-key' http://127.0.0.1:8642/health
```

Expected:

```json
{"status":"ok"}
```

- [ ] **Step 4: Verify Dench HTTP health**

Run:

```bash
curl -I --max-time 20 https://crm.rebattery.io
```

Expected: `HTTP/1.1 200 OK`.

- [ ] **Step 5: Verify chat route backend marker with a synthetic request**

Run:

```bash
curl -i --max-time 60 https://crm.rebattery.io/api/gateway/chat \
  -H 'Content-Type: application/json' \
  --data '{"sessionKey":"agent:main:web:manual-hermes-test","message":"Reply with one short sentence."}'
```

Expected headers include:

```text
Content-Type: text/event-stream
X-Agent-Backend: hermes
```

Expected body includes at least one SSE `data:` frame. If Hermes model/provider is not configured, expected body includes a controlled `type:error` SSE event explaining the Hermes failure.

- [ ] **Step 6: Document rollback**

Rollback command:

```bash
perl -0pi -e 's/Environment=DENCH_AGENT_BACKEND=hermes/Environment=DENCH_AGENT_BACKEND=openclaw/' /root/.config/systemd/user/dench-web-runtime.service
systemctl --user daemon-reload
systemctl --user restart dench-web-runtime.service
```

Expected: Dench runtime returns to OpenClaw routing without uninstalling Hermes.

---

## Self-Review

- Spec coverage: The plan installs Hermes, runs it separately, adds a feature flag, defaults to OpenClaw, routes chat to Hermes when enabled, and includes rollback.
- Placeholder scan: No placeholder-only tasks remain. Provider/model setup is explicitly allowed to remain separate because the user approved install-only/no-model-setup first.
- Type consistency: `AgentBackend`, `HermesConfig`, `resolveAgentBackend`, `resolveHermesConfig`, and `createHermesChatStream` are introduced before use.
- Scope check: This plan implements minimal chat backend only. It intentionally does not migrate Dench tools, CRM-aware tools, Composio, Exa, Apollo, profile mapping, or OpenClaw gateway emulation.
