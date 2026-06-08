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
