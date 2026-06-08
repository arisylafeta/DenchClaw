export type AgentBackend = "openclaw" | "hermes";

export interface HermesConfig {
  baseUrl: string;
  apiKey: string | null;
  model: string;
}

export function resolveAgentBackend(env: NodeJS.ProcessEnv = process.env): AgentBackend {
  return env.DENCH_AGENT_BACKEND === "hermes" ? "hermes" : "openclaw";
}

export function resolveHermesConfig(env: NodeJS.ProcessEnv = process.env): HermesConfig {
  const rawUrl = env.HERMES_API_BASE_URL ?? "http://127.0.0.1:8642";
  const baseUrl = rawUrl.replace(/\/+$/, "");

  return {
    baseUrl,
    apiKey: env.HERMES_API_KEY ?? null,
    model: env.HERMES_MODEL ?? "hermes-agent",
  };
}
