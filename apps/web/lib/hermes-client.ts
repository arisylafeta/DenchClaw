import type { HermesConfig } from "./agent-backend";

export type HermesChatStreamParams = {
  sessionKey: string;
  message: string;
  config: HermesConfig;
};

export function encodeSse(data: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n`);
}

export function errorStream(message: string, status?: number): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encodeSse({ type: "hermes-error", message, status }));
      controller.close();
    },
  });
}

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

export function createHermesChatStream(
  params: HermesChatStreamParams,
): ReadableStream<Uint8Array> {
  const { sessionKey, message, config } = params;

  if (!config.apiKey) {
    return errorStream("Missing Hermes API key");
  }

  const stream = new ReadableStream({
    async start(controller) {
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
          const body = await response.text();
          controller.enqueue(
            encodeSse({ type: "hermes-error", status: response.status, message: body }),
          );
          controller.close();
          return;
        }

        const data = (await response.json()) as { run_id: string; status: string };
        controller.enqueue(
          encodeSse({ type: "hermes-run-started", runId: data.run_id, status: data.status }),
        );

        if (!data.run_id) {
          controller.enqueue(encodeSse({ type: "hermes-error", message: "No run ID returned" }));
          controller.close();
          return;
        }

        try {
          const eventsResponse = await fetch(`${config.baseUrl}/v1/runs/${data.run_id}/events`, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${config.apiKey}`,
              "X-Hermes-Session-Key": sessionKey,
            },
          });

          if (!eventsResponse.ok) {
            const body = await eventsResponse.text();
            controller.enqueue(
              encodeSse({ type: "hermes-error", status: eventsResponse.status, message: body }),
            );
            controller.close();
            return;
          }

          const eventsText = await eventsResponse.text();
          const chunks = parseSseDataChunks(eventsText);
          
          for (const chunk of chunks) {
            const mapped = mapHermesEvent(chunk);
            if (mapped) {
              controller.enqueue(encodeSse(mapped));
            }
          }
        } catch (eventsErr) {
          const eventsMsg = eventsErr instanceof Error ? eventsErr.message : "Failed to fetch events";
          controller.enqueue(encodeSse({ type: "hermes-error", message: eventsMsg }));
        }

        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encodeSse({ type: "hermes-error", message: msg }));
        controller.close();
      }
    },
  });

  return stream;
}
