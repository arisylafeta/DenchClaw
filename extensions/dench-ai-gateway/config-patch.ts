import {
  buildDenchCloudAgentModelEntries,
  buildDenchCloudProviderModels,
  buildDenchGatewayApiBaseUrl,
  type DenchCloudCatalogModel,
} from "./models.js";

export type DenchCloudProviderConfig = {
  baseUrl: string;
  apiKey: string;
  api: "openai-completions" | "openai-responses";
  models: ReturnType<typeof buildDenchCloudProviderModels>;
};

export type ComposioMcpServerConfig = {
  url: string;
  transport: "streamable-http";
  headers: {
    Authorization: string;
  };
};

const DENCH_COMPOSIO_WRAPPER_TOOLS = [
  "dench_search_integrations",
  "dench_execute_integrations",
] as const;
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
  ...DENCH_COMPOSIO_WRAPPER_TOOLS,
] as const;

export function buildComposioMcpServerConfig(
  gatewayUrl: string,
  apiKey: string,
): ComposioMcpServerConfig {
  return {
    url: `${gatewayUrl}/v1/composio/mcp`,
    transport: "streamable-http",
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  };
}

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
      alsoAllow: [...DENCH_COMPOSIO_WRAPPER_TOOLS],
      byProvider: {
        "dench-cloud": {
          allow: [...DENCH_CLOUD_TOOL_ALLOWLIST],
        },
      },
    },
  };
}
