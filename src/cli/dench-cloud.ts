export const DEFAULT_DENCH_CLOUD_GATEWAY_URL = "https://gateway.merseoriginals.com";

export type DenchCloudCatalogCost = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

export type DenchCloudCatalogModel = {
  id: string;
  stableId: string;
  displayName: string;
  provider: string;
  transportProvider: string;
  api: "openai-completions" | "openai-responses";
  input: Array<"text" | "image">;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  supportsStreaming: boolean;
  supportsImages: boolean;
  supportsResponses: boolean;
  supportsReasoning: boolean;
  cost: DenchCloudCatalogCost;
};

export type DenchCloudCatalogSource = "live" | "fallback";

export type DenchCloudCatalogLoadResult = {
  models: DenchCloudCatalogModel[];
  source: DenchCloudCatalogSource;
  detail?: string;
};

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function readString(input: UnknownRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

function readNumber(input: UnknownRecord, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return undefined;
}

function readBoolean(input: UnknownRecord, ...keys: string[]): boolean | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function normalizeInputKinds(input: unknown, supportsImages: boolean): Array<"text" | "image"> {
  if (!Array.isArray(input)) {
    return supportsImages ? ["text", "image"] : ["text"];
  }

  const kinds = new Set<"text" | "image">();
  for (const value of input) {
    if (value === "text" || value === "image") {
      kinds.add(value);
    }
  }

  if (!kinds.has("text")) {
    kinds.add("text");
  }
  if (supportsImages) {
    kinds.add("image");
  }
  return [...kinds];
}

function stripTrailingSlashes(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* / */) {
    end -= 1;
  }
  return end === url.length ? url : url.slice(0, end);
}

export function normalizeDenchGatewayUrl(value: string | undefined): string {
  const raw = (value || DEFAULT_DENCH_CLOUD_GATEWAY_URL).trim();
  const withProtocol =
    raw.startsWith("http://") || raw.startsWith("https://") ? raw : `https://${raw}`;
  let base = stripTrailingSlashes(withProtocol);
  if (base.endsWith("/v1")) {
    base = stripTrailingSlashes(base.slice(0, -3));
  }
  return base;
}

export function buildDenchGatewayApiBaseUrl(gatewayUrl: string | undefined): string {
  return `${normalizeDenchGatewayUrl(gatewayUrl)}/v1`;
}

export function buildDenchGatewayCatalogUrl(gatewayUrl: string | undefined): string {
  return `${normalizeDenchGatewayUrl(gatewayUrl)}/v1/public/models`;
}

export const RECOMMENDED_DENCH_CLOUD_MODEL_ID = "claude-sonnet-4.6";
export const DENCH_COMPOSIO_WRAPPER_TOOLS = [
  "dench_search_integrations",
  "dench_execute_integrations",
] as const;
export const DENCH_CLOUD_TOOL_ALLOWLIST = [
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

// Fallback list used only when the live gateway catalog is unreachable.
// Live pricing always comes from the gateway's /v1/public/models response.
export const FALLBACK_DENCH_CLOUD_MODELS: DenchCloudCatalogModel[] = [
  {
    id: "kimi-k2.5",
    stableId: "moonshotai.kimi-k2.5",
    displayName: "Kimi K2.5",
    provider: "moonshot",
    transportProvider: "bedrock",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 262000,
    maxTokens: 64000,
    supportsStreaming: true,
    supportsImages: true,
    supportsResponses: true,
    supportsReasoning: true,
    cost: {
      input: 0.81,
      output: 4.05,
      cacheRead: 0,
      cacheWrite: 0,
    },
  },
  {
    id: "claude-opus-4.6",
    stableId: "anthropic.claude-opus-4-6-v1",
    displayName: "Claude Opus 4.6",
    provider: "anthropic",
    transportProvider: "bedrock",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 971000,
    maxTokens: 128000,
    supportsStreaming: true,
    supportsImages: true,
    supportsResponses: true,
    supportsReasoning: true,
    cost: {
      input: 6.75,
      output: 33.75,
      cacheRead: 0.675,
      cacheWrite: 8.4375,
    },
  },
  {
    id: "gpt-5.4",
    stableId: "gpt-5.4",
    displayName: "GPT-5.4",
    provider: "openai",
    transportProvider: "openai",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 971000,
    maxTokens: 128000,
    supportsStreaming: true,
    supportsImages: true,
    supportsResponses: true,
    supportsReasoning: true,
    cost: {
      input: 3.375,
      output: 20.25,
      cacheRead: 0.3375,
      cacheWrite: 0,
    },
  },
  {
    id: "claude-sonnet-4.6",
    stableId: "anthropic.claude-sonnet-4-6-v1",
    displayName: "Claude Sonnet 4.6",
    provider: "anthropic",
    transportProvider: "bedrock",
    api: "openai-responses",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 971000,
    maxTokens: 64000,
    supportsStreaming: true,
    supportsImages: true,
    supportsResponses: true,
    supportsReasoning: true,
    cost: {
      input: 4.05,
      output: 20.25,
      cacheRead: 0.405,
      cacheWrite: 5.0625,
    },
  },
];

export function cloneFallbackDenchCloudModels(): DenchCloudCatalogModel[] {
  return FALLBACK_DENCH_CLOUD_MODELS.map((model) => ({
    ...model,
    input: [...model.input],
    cost: { ...model.cost },
  }));
}

export function normalizeDenchCloudCatalogModel(input: unknown): DenchCloudCatalogModel | null {
  const record = asRecord(input);
  if (!record) {
    return null;
  }

  const publicId = readString(record, "id", "publicId", "public_id");
  const stableId = readString(record, "stableId", "stable_id") || publicId;
  const displayName = readString(record, "name", "displayName", "display_name");
  const provider = readString(record, "provider");
  const transportProvider = readString(record, "transportProvider", "transport_provider");
  if (
    !publicId ||
    !stableId ||
    !displayName ||
    !isNonEmptyString(provider) ||
    !isNonEmptyString(transportProvider)
  ) {
    return null;
  }

  const supportsImages = readBoolean(record, "supportsImages", "supports_images") ?? false;
  const supportsStreaming = readBoolean(record, "supportsStreaming", "supports_streaming") ?? true;
  const supportsResponses = readBoolean(record, "supportsResponses", "supports_responses") ?? true;
  const supportsReasoning =
    readBoolean(record, "supportsReasoning", "supports_reasoning") ??
    readBoolean(record, "reasoning") ??
    false;
  const contextWindow = readNumber(record, "contextWindow", "context_window") ?? 200000;
  const maxTokens =
    readNumber(record, "maxTokens", "max_tokens", "maxOutputTokens", "max_output_tokens") ?? 64000;

  const costRecord = asRecord(record.cost) ?? {};
  const inputCost = readNumber(costRecord, "input") ?? 0;
  const outputCost = readNumber(costRecord, "output") ?? 0;
  const cacheRead = readNumber(costRecord, "cacheRead", "cache_read") ?? 0;
  const cacheWrite = readNumber(costRecord, "cacheWrite", "cache_write") ?? 0;

  return {
    id: publicId,
    stableId,
    displayName,
    provider,
    transportProvider,
    api: record.api === "openai-completions" ? "openai-completions" : "openai-responses",
    input: normalizeInputKinds(record.input, supportsImages),
    reasoning: supportsReasoning,
    contextWindow,
    maxTokens,
    supportsStreaming,
    supportsImages,
    supportsResponses,
    supportsReasoning,
    cost: {
      input: inputCost,
      output: outputCost,
      cacheRead,
      cacheWrite,
    },
  };
}

export function normalizeDenchCloudCatalogResponse(payload: unknown): DenchCloudCatalogModel[] {
  const root = asRecord(payload);
  const data = root?.data;
  if (!Array.isArray(data)) {
    return [];
  }

  const models: DenchCloudCatalogModel[] = [];
  const seen = new Set<string>();
  for (const entry of data) {
    const normalized = normalizeDenchCloudCatalogModel(entry);
    if (!normalized || seen.has(normalized.stableId)) {
      continue;
    }
    seen.add(normalized.stableId);
    models.push(normalized);
  }
  return models;
}

export async function fetchDenchCloudCatalog(
  gatewayUrl: string,
): Promise<DenchCloudCatalogLoadResult> {
  try {
    const response = await fetch(buildDenchGatewayCatalogUrl(gatewayUrl));
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const payload = await response.json().catch(() => null);
    const models = normalizeDenchCloudCatalogResponse(payload);
    if (!models.length) {
      throw new Error("response did not contain any usable models");
    }

    return {
      models,
      source: "live",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      models: cloneFallbackDenchCloudModels(),
      source: "fallback",
      detail,
    };
  }
}

export async function validateDenchCloudApiKey(gatewayUrl: string, apiKey: string): Promise<void> {
  const response = await fetch(`${buildDenchGatewayApiBaseUrl(gatewayUrl)}/models`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  if (response.ok) {
    return;
  }

  const message =
    response.status === 401 || response.status === 403
      ? "Invalid Dench Cloud API key."
      : `Dench Cloud validation failed with HTTP ${response.status}.`;
  throw new Error(`${message} Check your key at dench.com/settings.`);
}

export function buildDenchCloudProviderModels(models: DenchCloudCatalogModel[]) {
  return models.map((model) => ({
    id: model.stableId,
    name: `${model.displayName} (Dench Cloud)`,
    reasoning: model.reasoning,
    input: [...model.input],
    cost: {
      input: model.cost.input,
      output: model.cost.output,
      cacheRead: model.cost.cacheRead,
      cacheWrite: model.cost.cacheWrite,
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  }));
}

export function buildDenchCloudAgentModelEntries(models: DenchCloudCatalogModel[]) {
  return Object.fromEntries(
    models.map((model) => [
      `dench-cloud/${model.stableId}`,
      { alias: `${model.displayName} (Dench Cloud)` },
    ]),
  );
}

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

export function resolveDenchCloudModel(
  models: DenchCloudCatalogModel[],
  requestedId: string | undefined,
): DenchCloudCatalogModel | undefined {
  const normalized = requestedId?.trim();
  if (!normalized) {
    return models.find((model) => model.id === RECOMMENDED_DENCH_CLOUD_MODEL_ID) || models[0];
  }

  return models.find((model) => model.id === normalized || model.stableId === normalized);
}

export function formatDenchCloudModelHint(model: DenchCloudCatalogModel): string {
  const parts: string[] = [model.provider];
  if (model.reasoning) parts.push("reasoning");
  if (model.id === RECOMMENDED_DENCH_CLOUD_MODEL_ID) parts.push("recommended");
  return parts.join(" · ");
}

export function readConfiguredDenchCloudSettings(rawConfig: Record<string, unknown> | undefined): {
  gatewayUrl?: string;
  apiKey?: string;
  selectedModel?: string;
  ttsElevenLabsBaseUrl?: string;
} {
  const provider = asRecord(asRecord(asRecord(rawConfig?.models)?.providers)?.["dench-cloud"]);
  const defaults = asRecord(asRecord(rawConfig?.agents)?.defaults);
  const modelValue = defaults?.model;
  const modelSetting = asRecord(modelValue);
  const modelPrimary =
    typeof modelValue === "string"
      ? modelValue
      : typeof modelSetting?.primary === "string"
        ? modelSetting.primary
        : undefined;

  const selectedModel =
    typeof modelPrimary === "string" && modelPrimary.startsWith("dench-cloud/")
      ? modelPrimary.slice("dench-cloud/".length)
      : undefined;

  const baseUrl = readString(provider ?? {}, "baseUrl", "base_url");
  const tts = asRecord(asRecord(rawConfig?.messages)?.tts);
  const ttsElevenlabs = asRecord(tts?.elevenlabs) ?? asRecord(asRecord(tts?.providers)?.elevenlabs);
  return {
    gatewayUrl: baseUrl ? normalizeDenchGatewayUrl(baseUrl) : undefined,
    apiKey: readString(provider ?? {}, "apiKey", "api_key"),
    selectedModel,
    ttsElevenLabsBaseUrl: readString(ttsElevenlabs ?? {}, "baseUrl", "base_url"),
  };
}
