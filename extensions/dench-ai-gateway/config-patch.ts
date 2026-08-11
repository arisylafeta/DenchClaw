import {
  buildDenchCloudAgentModelEntries,
  buildDenchCloudProviderModels,
  buildDenchGatewayApiBaseUrl,
  type DenchCloudCatalogModel,
} from "./models.js";

const DENCH_CLOUD_TOOL_ALLOWLIST = [
  "read",
  "write",
  "edit",
  "apply_patch",
  "exec",
  "process",
  "code_execution",
  "web_fetch",
  "x_search",
  "memory_search",
  "memory_get",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "sessions_yield",
  "subagents",
  "session_status",
  "cron",
  "update_plan",
  "image",
  "image_generate",
  "music_generate",
  "video_generate",
] as const;

export type DenchCloudProviderConfig = {
  baseUrl: string;
  apiKey: string;
  api: "openai-completions" | "openai-responses";
  models: ReturnType<typeof buildDenchCloudProviderModels>;
};

export function buildDenchCloudProviderConfig(params: {
  gatewayUrl: string;
  apiKey: string;
  models: DenchCloudCatalogModel[];
}): DenchCloudProviderConfig {
  return {
    baseUrl: buildDenchGatewayApiBaseUrl(params.gatewayUrl),
    apiKey: params.apiKey,
    api: "openai-responses",
    models: buildDenchCloudProviderModels(params.models),
  };
}

export function buildDenchCloudConfigPatch(params: {
  gatewayUrl: string;
  apiKey: string;
  models: DenchCloudCatalogModel[];
}) {
  return {
    models: {
      mode: "merge" as const,
      providers: {
        "dench-cloud": buildDenchCloudProviderConfig(params),
      },
    },
    agents: {
      defaults: {
        models: buildDenchCloudAgentModelEntries(params.models),
      },
    },
    messages: {
      tts: {
        provider: "elevenlabs",
        providers: {
          elevenlabs: {
            baseUrl: params.gatewayUrl,
            apiKey: params.apiKey,
          },
        },
      },
    },
    tools: {
      byProvider: {
        "dench-cloud": {
          allow: [...DENCH_CLOUD_TOOL_ALLOWLIST],
        },
      },
    },
  };
}
