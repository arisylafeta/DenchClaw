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

type HermesRunResult = {
  run_id: string;
  status: string;
  output?: string;
};

async function pollRunCompletion(
  config: HermesConfig,
  runId: string,
  sessionKey: string,
): Promise<HermesRunResult> {
  const maxAttempts = 60;
  const delayMs = 1000;

  for (let i = 0; i < maxAttempts; i++) {
    const res = await fetch(`${config.baseUrl}/v1/runs/${encodeURIComponent(runId)}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "X-Hermes-Session-Key": sessionKey,
      },
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Hermes run status failed: ${res.status} ${body}`.trim());
    }

    const run = (await res.json()) as HermesRunResult;
    if (run.status === "completed" || run.status === "failed") {
      return run;
    }

    await new Promise((r) => setTimeout(r, delayMs));
  }

  throw new Error("Hermes run timed out");
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
            encodeSse({ type: "error", errorText: body, status: response.status }),
          );
          controller.close();
          return;
        }

        const data = (await response.json()) as { run_id: string; status: string };

        if (!data.run_id) {
          controller.enqueue(encodeSse({ type: "error", errorText: "No run ID returned" }));
          controller.close();
          return;
        }

        try {
          const runResult = await pollRunCompletion(config, data.run_id, sessionKey);
          if (runResult.output) {
            controller.enqueue(encodeSse({ type: "text-start", id: data.run_id }));
            controller.enqueue(
              encodeSse({ type: "text-delta", id: data.run_id, delta: runResult.output }),
            );
            controller.enqueue(encodeSse({ type: "text-end", id: data.run_id }));
          }
          controller.enqueue(encodeSse({ type: "finish" }));
        } catch (pollErr) {
          const pollMsg = pollErr instanceof Error ? pollErr.message : "Failed to get run result";
          controller.enqueue(encodeSse({ type: "error", errorText: pollMsg }));
        }

        controller.close();
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(encodeSse({ type: "error", errorText: msg }));
        controller.close();
      }
    },
  });

  return stream;
}
