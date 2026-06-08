export type AgentBackend = "openclaw" | "hermes";

export interface HermesConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export function resolveAgentBackend(): AgentBackend {
  return process.env.DENCH_AGENT_BACKEND === "hermes" ? "hermes" : "openclaw";
}

export function resolveHermesConfig(): HermesConfig {
  const rawUrl = process.env.HERMES_API_BASE_URL ?? "http://127.0.0.1:8642";
  const baseUrl = rawUrl.replace(/\/+$/, "");

  return {
    baseUrl,
    apiKey: process.env.HERMES_API_KEY ?? "",
    model: process.env.HERMES_MODEL ?? "hermes-agent",
  };
}
