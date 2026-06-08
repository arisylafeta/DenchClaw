import type { HermesConfig } from "./agent-backend";

export type HermesChatStreamParams = {
  sessionKey: string;
  message: string;
  config: HermesConfig;
};

export function encodeSse(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export function errorStream(message: string, status?: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encodeSse({ type: "error", errorText: message, status }));
      controller.close();
    },
  });
}

type HermesSseEvent = {
  event: string;
  run_id?: string;
  timestamp?: number;
  delta?: string;
  text?: string;
  tool?: string;
  preview?: string;
  duration?: number;
  error?: boolean;
  output?: string;
  usage?: Record<string, unknown>;
};

function nextId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function createHermesChatStream(
  params: HermesChatStreamParams,
): Promise<ReadableStream<Uint8Array>> {
  const { sessionKey, message, config } = params;

  if (!config.apiKey) {
    return errorStream("Missing Hermes API key");
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let textId: string | null = null;
      let reasoningId: string | null = null;
      let toolCallId: string | null = null;
      let finished = false;

      function emit(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // 1. Create the run
        const runRes = await fetch(`${config.baseUrl}/v1/runs`, {
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

        if (!runRes.ok) {
          const body = await runRes.text();
          emit({ type: "error", errorText: body, status: runRes.status });
          controller.close();
          return;
        }

        const runData = (await runRes.json()) as { run_id: string; status: string };
        const runId = runData.run_id;

        if (!runId) {
          emit({ type: "error", errorText: "No run ID returned" });
          controller.close();
          return;
        }

        // 2. Stream events from /v1/runs/{id}/events
        const eventsRes = await fetch(`${config.baseUrl}/v1/runs/${encodeURIComponent(runId)}/events`, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${config.apiKey}`,
            "X-Hermes-Session-Key": sessionKey,
          },
        });

        if (!eventsRes.ok) {
          const body = await eventsRes.text();
          emit({ type: "error", errorText: `Events stream failed: ${body}`, status: eventsRes.status });
          controller.close();
          return;
        }

        const reader = eventsRes.body?.getReader();
        if (!reader) {
          emit({ type: "error", errorText: "No response body" });
          controller.close();
          return;
        }

        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });

          // Process complete SSE lines
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);

            if (!line.startsWith("data: ")) continue;
            const jsonStr = line.slice(6).trim();
            if (!jsonStr || jsonStr === "[DONE]") continue;

            try {
              const event = JSON.parse(jsonStr) as HermesSseEvent;

              switch (event.event) {
                case "message.delta": {
                  if (event.delta) {
                    // Close reasoning block before starting text
                    if (reasoningId) {
                      emit({ type: "reasoning-end", id: reasoningId });
                      reasoningId = null;
                    }
                    if (!textId) {
                      textId = nextId("text");
                      emit({ type: "text-start", id: textId });
                    }
                    emit({ type: "text-delta", id: textId, delta: event.delta });
                  }
                  break;
                }

                case "reasoning.available": {
                  if (event.text) {
                    if (!reasoningId) {
                      reasoningId = nextId("reasoning");
                      emit({ type: "reasoning-start", id: reasoningId });
                    }
                    emit({ type: "reasoning-delta", id: reasoningId, delta: event.text });
                  }
                  break;
                }

                case "tool.started": {
                  // Close any open text block before tool call
                  if (textId) {
                    emit({ type: "text-end", id: textId });
                    textId = null;
                  }
                  toolCallId = nextId("tool");
                  emit({
                    type: "tool-input-start",
                    toolCallId,
                    toolName: event.tool ?? "unknown",
                  });
                  if (event.preview) {
                    emit({
                      type: "tool-input-available",
                      toolCallId,
                      toolName: event.tool ?? "unknown",
                      input: event.preview,
                    });
                  }
                  break;
                }

                case "tool.completed": {
                  if (toolCallId) {
                    emit({
                      type: event.error ? "tool-output-error" : "tool-output-available",
                      toolCallId,
                      output: event.output ?? event.tool ?? "completed",
                    });
                    toolCallId = null;
                  }
                  break;
                }

                case "run.completed": {
                  // Close any open blocks
                  if (textId) {
                    emit({ type: "text-end", id: textId });
                    textId = null;
                  }
                  if (reasoningId) {
                    emit({ type: "reasoning-end", id: reasoningId });
                    reasoningId = null;
                  }
                  if (!finished) {
                    finished = true;
                    emit({ type: "finish" });
                  }
                  break;
                }
              }
            } catch {
              // ignore non-JSON lines
            }
          }
        }

        // Ensure stream is properly closed
        if (textId) emit({ type: "text-end", id: textId });
        if (reasoningId) emit({ type: "reasoning-end", id: reasoningId });
        if (!finished) emit({ type: "finish" });

        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        emit({ type: "error", errorText: msg });
        controller.close();
      }
    },
  });

  return stream;
}
