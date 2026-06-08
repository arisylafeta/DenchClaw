// extensions/shared/dench-auth.ts
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
var DEFAULT_GATEWAY_URL = "https://gateway.merseoriginals.com";
var AUTH_PROFILES_REL = path.join("agents", "main", "agent", "auth-profiles.json");
function readDenchAuthProfileKey() {
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (stateDir) {
    const key = readKeyFromAuthProfiles(path.join(stateDir, AUTH_PROFILES_REL));
    if (key) return key;
  }
  return envFallback();
}
function readKeyFromAuthProfiles(authPath) {
  try {
    if (!existsSync(authPath)) return void 0;
    const raw = JSON.parse(readFileSync(authPath, "utf-8"));
    const key = raw?.profiles?.["dench-cloud:default"]?.key;
    return typeof key === "string" && key.trim() ? key.trim() : void 0;
  } catch {
    return void 0;
  }
}
function envFallback() {
  return process.env.DENCH_CLOUD_API_KEY?.trim() || process.env.DENCH_API_KEY?.trim() || void 0;
}
function resolveDenchGatewayUrl(pluginConfig) {
  const configured = pluginConfig?.gatewayUrl;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return process.env.DENCH_GATEWAY_URL?.trim() || DEFAULT_GATEWAY_URL;
}

// extensions/exa-search/index.ts
var id = "exa-search";
function asRecord(value) {
  return value && typeof value === "object" ? value : void 0;
}
function readTrimmedString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : void 0;
}
function readStringList(value) {
  if (!Array.isArray(value)) {
    return void 0;
  }
  const items = value.map((item) => readTrimmedString(item)).filter((item) => Boolean(item));
  return items.length > 0 ? items : void 0;
}
function jsonResult(payload) {
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    details: payload
  };
}
var SEARCH_TYPES = ["auto", "neural", "fast", "deep", "deep-reasoning", "instant"];
var SEARCH_CATEGORIES = [
  "company",
  "research paper",
  "news",
  "personal site",
  "financial report",
  "people"
];
var ExaSearchParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Search query." },
    searchType: { type: "string", enum: [...SEARCH_TYPES], description: "Exa search type." },
    category: { type: "string", enum: [...SEARCH_CATEGORIES], description: "Exa search category." },
    numResults: { type: "number", description: "Maximum number of results." },
    includeDomains: {
      type: "array",
      items: { type: "string" },
      description: "Only search these domains."
    },
    excludeDomains: {
      type: "array",
      items: { type: "string" },
      description: "Exclude these domains."
    },
    startPublishedDate: { type: "string", description: "ISO date lower bound for published date." },
    endPublishedDate: { type: "string", description: "ISO date upper bound for published date." },
    text: { type: "boolean", description: "Include extracted page text." },
    textMaxCharacters: { type: "number", description: "Maximum characters of extracted text." },
    highlights: { type: "boolean", description: "Include highlights." },
    highlightsMaxCharacters: { type: "number", description: "Maximum characters in highlights." },
    summary: { type: "boolean", description: "Include a summary." },
    summaryQuery: { type: "string", description: "Summary query prompt to send upstream." }
  },
  required: ["query"]
};
var ExaContentsParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    urls: { type: "array", items: { type: "string" }, description: "URLs to fetch content for." },
    text: { type: "boolean", description: "Include extracted page text." },
    textMaxCharacters: { type: "number", description: "Maximum characters of extracted text." },
    highlights: { type: "boolean", description: "Include highlights." },
    highlightsMaxCharacters: { type: "number", description: "Maximum characters in highlights." },
    summary: { type: "boolean", description: "Include a summary." },
    summaryQuery: { type: "string", description: "Summary query prompt to send upstream." }
  },
  required: ["urls"]
};
var ExaAnswerParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: { type: "string", description: "Question to answer." },
    text: { type: "boolean", description: "Include extra answer text fields." }
  },
  required: ["query"]
};
function buildTextOption(params) {
  if (typeof params.textMaxCharacters === "number") {
    return { maxCharacters: params.textMaxCharacters };
  }
  if (params.text === true) {
    return true;
  }
  return void 0;
}
function buildHighlightsOption(params) {
  if (typeof params.highlightsMaxCharacters === "number") {
    return { maxCharacters: params.highlightsMaxCharacters };
  }
  if (params.highlights === true) {
    return true;
  }
  return void 0;
}
function buildSummaryOption(params) {
  const query = readTrimmedString(params.summaryQuery);
  if (query) {
    return { query };
  }
  if (params.summary === true) {
    return {};
  }
  return void 0;
}
function buildSearchBody(params) {
  const body = {
    query: params.query
  };
  const searchType = readTrimmedString(params.searchType);
  const category = readTrimmedString(params.category);
  const includeDomains = readStringList(params.includeDomains);
  const excludeDomains = readStringList(params.excludeDomains);
  const startPublishedDate = readTrimmedString(params.startPublishedDate);
  const endPublishedDate = readTrimmedString(params.endPublishedDate);
  const text = buildTextOption(params);
  const highlights = buildHighlightsOption(params);
  const summary = buildSummaryOption(params);
  const contents = {};
  if (searchType) {
    body.type = searchType;
  }
  if (category) {
    body.category = category;
  }
  if (typeof params.numResults === "number") {
    body.numResults = params.numResults;
  }
  if (includeDomains) {
    body.includeDomains = includeDomains;
  }
  if (excludeDomains) {
    body.excludeDomains = excludeDomains;
  }
  if (startPublishedDate) {
    body.startPublishedDate = startPublishedDate;
  }
  if (endPublishedDate) {
    body.endPublishedDate = endPublishedDate;
  }
  if (text !== void 0) {
    contents.text = text;
  }
  if (highlights !== void 0) {
    contents.highlights = highlights;
  }
  if (summary !== void 0) {
    contents.summary = summary;
  }
  if (Object.keys(contents).length > 0) {
    body.contents = contents;
  }
  return body;
}
function buildContentsBody(params) {
  const urls = readStringList(params.urls);
  const body = {
    urls: urls ?? []
  };
  const text = buildTextOption(params);
  const highlights = buildHighlightsOption(params);
  const summary = buildSummaryOption(params);
  if (text !== void 0) {
    body.text = text;
  }
  if (highlights !== void 0) {
    body.highlights = highlights;
  }
  if (summary !== void 0) {
    body.summary = summary;
  }
  return body;
}
async function parseResponse(response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}
async function postJson(params) {
  const response = await fetch(`${params.gatewayUrl}${params.path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${params.apiKey}`
    },
    body: JSON.stringify(params.body)
  });
  if (!response.ok) {
    const detail = await parseResponse(response).catch(() => "");
    return jsonResult({
      error: `Search request failed (HTTP ${response.status}).`,
      detail: detail || void 0
    });
  }
  return jsonResult(await parseResponse(response));
}
function createExaSearchTool(gatewayUrl, apiKey) {
  return {
    name: "exa_search",
    label: "Exa Search",
    description: "Search the web through Exa via the Dench Cloud gateway, with optional text extraction, highlights, and summary generation.",
    parameters: ExaSearchParameters,
    execute: async (_toolCallId, params) => {
      try {
        return await postJson({
          gatewayUrl,
          apiKey,
          path: "/v1/search",
          body: buildSearchBody(params)
        });
      } catch (err) {
        return jsonResult({
          error: "Search request failed.",
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    }
  };
}
function createExaContentsTool(gatewayUrl, apiKey) {
  return {
    name: "exa_get_contents",
    label: "Exa Get Contents",
    description: "Fetch page contents for one or more URLs through Exa via the Dench Cloud gateway.",
    parameters: ExaContentsParameters,
    execute: async (_toolCallId, params) => {
      try {
        const urls = readStringList(params.urls);
        if (!urls) {
          return jsonResult({ error: "At least one URL is required." });
        }
        return await postJson({
          gatewayUrl,
          apiKey,
          path: "/v1/search/contents",
          body: buildContentsBody({ ...params, urls })
        });
      } catch (err) {
        return jsonResult({
          error: "Contents request failed.",
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    }
  };
}
function createExaAnswerTool(gatewayUrl, apiKey) {
  return {
    name: "exa_answer",
    label: "Exa Answer",
    description: "Ask Exa for a citation-backed answer through the Dench Cloud gateway.",
    parameters: ExaAnswerParameters,
    execute: async (_toolCallId, params) => {
      try {
        return await postJson({
          gatewayUrl,
          apiKey,
          path: "/v1/search/answer",
          body: {
            query: params.query,
            ...params.text === true ? { text: true } : {}
          }
        });
      } catch (err) {
        return jsonResult({
          error: "Answer request failed.",
          detail: err instanceof Error ? err.message : String(err)
        });
      }
    }
  };
}
function register(api) {
  const rootConfig = asRecord(api.config);
  const pluginEntries = asRecord(asRecord(rootConfig?.plugins)?.entries);
  const pluginConfig = asRecord(asRecord(pluginEntries?.[id])?.config);
  if (pluginConfig?.enabled === false) {
    return;
  }
  const gwPluginConfig = asRecord(asRecord(pluginEntries?.["dench-ai-gateway"])?.config);
  const gatewayUrl = resolveDenchGatewayUrl(gwPluginConfig);
  const apiKey = readDenchAuthProfileKey();
  if (!apiKey) {
    api.logger?.info?.("[exa-search] No Dench Cloud API key found; tools will not be registered.");
    return;
  }
  api.registerTool(createExaSearchTool(gatewayUrl, apiKey));
  api.registerTool(createExaContentsTool(gatewayUrl, apiKey));
  api.registerTool(createExaAnswerTool(gatewayUrl, apiKey));
}
export {
  register as default,
  id
};
