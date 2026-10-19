import type { HermesConfig } from "./agent-backend";
import { readActiveProfileName } from "./workspace";
import type { ImageAttachment } from "./agent-runner";

export type HermesChatStreamParams = {
  sessionKey: string;
  message: string;
  userId: string;
  config: HermesConfig;
  /** Images attached to this turn (base64 content), forwarded as inline
   *  `image_url` content parts so Hermes's multimodal normalizer picks
   *  them up — same as `/v1/chat/completions` and `/v1/responses`. */
  images?: ImageAttachment[];
};

/** Build the `message` field for the chat/stream request body. Plain
 *  string when there are no images (unchanged legacy shape); otherwise
 *  a content-parts array so the Hermes multimodal normalizer attaches
 *  the images to this turn instead of silently dropping them. */
function buildHermesMessagePayload(
  message: string,
  images?: ImageAttachment[],
): string | Array<Record<string, unknown>> {
  if (!images || images.length === 0) {
    return message;
  }
  const parts: Array<Record<string, unknown>> = [{ type: "text", text: message }];
  for (const image of images) {
    parts.push({
      type: "image_url",
      image_url: { url: `data:${image.mimeType};base64,${image.content}` },
    });
  }
  return parts;
}

/** Hermes gateway error bodies are sometimes an HTML page (proxy/500
 *  overlay) rather than the documented JSON error shape. Surfacing that
 *  raw markup verbatim in the chat looks like a broken page and leaves
 *  the turn stuck, so collapse anything HTML-shaped to a short message
 *  instead of forwarding it to the client as-is. */
function sanitizeUpstreamErrorBody(body: string, status: number): string {
  const trimmed = body.trim();
  const looksLikeHtml = /^<(!doctype|html)/i.test(trimmed) || /<\/html>\s*$/i.test(trimmed);
  if (!trimmed || looksLikeHtml) {
    return `Hermes backend returned an unexpected error (HTTP ${status}). Please try again.`;
  }
  try {
    const parsed = JSON.parse(trimmed) as { error?: { message?: string }; message?: string };
    return parsed.error?.message ?? parsed.message ?? trimmed;
  } catch {
    return trimmed;
  }
}

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
  delta?: string;
  content?: string;
  message?: string;
  tool_name?: string;
  preview?: string;
  args?: unknown;
};

function nextId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function createHermesChatStream(
  params: HermesChatStreamParams,
): Promise<ReadableStream<Uint8Array>> {
  const { sessionKey, message, config, images } = params;

  if (!config.apiKey) {
    return errorStream("Missing Hermes API key");
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let textId: string | null = null;
      let reasoningId: string | null = null;
      let toolCallId: string | null = null;
      let toolPreview: string | null = null;
      let finished = false;
      let receivedText = false;

      function emit(data: Record<string, unknown>) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      }

      try {
        // Native session chat loads persisted history; /v1/runs with only
        // session_id does not. Both native endpoints route profiles by URL.
        const profile = readActiveProfileName();
        const baseUrl = config.baseUrl.replace(/\/+$/, "");
        const sessionUrl = `${baseUrl}${profile ? `/p/${encodeURIComponent(profile)}` : ""}/api/sessions`;
        const headers = {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
          "X-Hermes-Session-Key": sessionKey,
        };
        const sessionRes = await fetch(sessionUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ id: sessionKey, model: config.model }),
        });

        if (!sessionRes.ok) {
          const body = await sessionRes.text();
          let alreadyExists = false;
          if (sessionRes.status === 409) {
            try {
              alreadyExists = JSON.parse(body)?.error?.code === "session_exists";
            } catch {
              // Only the documented duplicate-session conflict is safe to resume.
            }
          }
          if (!alreadyExists) {
            emit({
              type: "error",
              errorText: sanitizeUpstreamErrorBody(body, sessionRes.status),
              status: sessionRes.status,
            });
            controller.close();
            return;
          }
        }

        const eventsRes = await fetch(
          `${sessionUrl}/${encodeURIComponent(sessionKey)}/chat/stream`,
          {
            method: "POST",
            headers: { ...headers, Accept: "text/event-stream" },
            body: JSON.stringify({
              message: buildHermesMessagePayload(message, images),
              model: config.model,
            }),
          },
        );

        if (!eventsRes.ok) {
          const body = await eventsRes.text();
          emit({
            type: "error",
            errorText: `Events stream failed: ${sanitizeUpstreamErrorBody(body, eventsRes.status)}`,
            status: eventsRes.status,
          });
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
        function handleEvent(name: string, event: HermesSseEvent) {
          if (finished) {
            return;
          }
          switch (name) {
            case "assistant.completed":
              // Some providers only return final text. Do not repeat deltas.
              if (receivedText || !event.content) {
                break;
              }
              event = { delta: event.content };
            // falls through
            case "assistant.delta": {
              if (event.delta) {
                receivedText = true;
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

            case "tool.progress": {
              if (event.tool_name === "_thinking" && event.delta) {
                if (!reasoningId) {
                  reasoningId = nextId("reasoning");
                  emit({ type: "reasoning-start", id: reasoningId });
                }
                emit({ type: "reasoning-delta", id: reasoningId, delta: event.delta });
              }
              break;
            }

            case "tool.started": {
              if (reasoningId) {
                emit({ type: "reasoning-end", id: reasoningId });
                reasoningId = null;
              }
              // Close any open text block before tool call
              if (textId) {
                emit({ type: "text-end", id: textId });
                textId = null;
              }
              toolCallId = nextId("tool");
              receivedText = false;
              toolPreview = event.preview ?? null;
              emit({
                type: "tool-input-start",
                toolCallId,
                toolName: event.tool_name ?? "unknown",
              });
              if (event.args != null || event.preview) {
                emit({
                  type: "tool-input-available",
                  toolCallId,
                  toolName: event.tool_name ?? "unknown",
                  input: event.args ?? event.preview,
                });
              }
              break;
            }

            case "tool.completed":
            case "tool.failed": {
              if (toolCallId) {
                const outputLabel = toolPreview
                  ? `Done: ${toolPreview}`
                  : (event.tool_name ?? "completed");
                if (name === "tool.failed") {
                  emit({
                    type: "tool-output-error",
                    toolCallId,
                    errorText: event.preview || "Tool execution failed",
                  });
                } else {
                  emit({
                    type: "tool-output-available",
                    toolCallId,
                    output: outputLabel,
                  });
                }
                toolCallId = null;
                toolPreview = null;
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

            case "error": {
              // Hermes redacts provider errors before publishing this event.
              if (textId) {
                emit({ type: "text-end", id: textId });
                textId = null;
              }
              if (reasoningId) {
                emit({ type: "reasoning-end", id: reasoningId });
                reasoningId = null;
              }
              const errorText =
                typeof event.message === "string" && event.message.trim()
                  ? event.message
                  : "Hermes run failed";
              finished = true;
              emit({ type: "error", errorText });
              break;
            }
          }
        }

        let buffer = "";
        let eventName = "";
        let dataLines: string[] = [];
        function processLine(line: string) {
          if (line === "") {
            if (dataLines.length) {
              // Native SSE carries the name on its own line, not in JSON.
              const event = JSON.parse(dataLines.join("\n")) as HermesSseEvent;
              handleEvent(eventName, event);
            }
            eventName = "";
            dataLines = [];
          } else if (line.startsWith("event:")) {
            eventName = line.slice(6).replace(/^ /, "");
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""));
          }
        }

        try {
          while (true) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let newlineIdx: number;
            while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
              processLine(buffer.slice(0, newlineIdx).replace(/\r$/, ""));
              buffer = buffer.slice(newlineIdx + 1);
            }
            if (done) {
              break;
            }
          }
        } finally {
          await reader.cancel();
          reader.releaseLock();
        }

        // Ensure stream is properly closed
        if (textId) {
          emit({ type: "text-end", id: textId });
        }
        if (reasoningId) {
          emit({ type: "reasoning-end", id: reasoningId });
        }
        if (!finished) {
          emit({ type: "error", errorText: "Hermes stream ended before run.completed" });
        }

        controller.close();
      } catch (err) {
        if (textId) {
          emit({ type: "text-end", id: textId });
        }
        if (reasoningId) {
          emit({ type: "reasoning-end", id: reasoningId });
        }
        const msg = err instanceof Error ? err.message : "Unknown error";
        emit({ type: "error", errorText: msg });
        controller.close();
      }
    },
  });

  return stream;
}
