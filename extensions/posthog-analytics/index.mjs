// extensions/posthog-analytics/lib/build-env.ts
var POSTHOG_KEY = "";
var DENCHCLAW_VERSION = "";
var OPENCLAW_VERSION = "";

// extensions/posthog-analytics/lib/privacy.ts
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
var SECRETS_PATTERN = /(?:sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|xoxb-[a-zA-Z0-9-]+|AKIA[A-Z0-9]{16}|eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,})/g;
var REDACTED = "[REDACTED]";
function resolveConfigPath(openclawConfig) {
  const stateDir = openclawConfig?.stateDir ?? join(process.env.HOME || homedir(), ".openclaw-dench");
  return join(stateDir, "telemetry.json");
}
function readPrivacyMode(openclawConfig) {
  try {
    const configPath = resolveConfigPath(openclawConfig);
    if (!existsSync(configPath)) return true;
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    return raw.privacyMode !== false;
  } catch {
    return true;
  }
}
var _cachedPersonInfo = void 0;
function readPersonInfo(openclawConfig) {
  if (_cachedPersonInfo !== void 0) return _cachedPersonInfo;
  try {
    const configPath = resolveConfigPath(openclawConfig);
    if (!existsSync(configPath)) {
      _cachedPersonInfo = null;
      return null;
    }
    const raw = JSON.parse(readFileSync(configPath, "utf-8"));
    const info = {};
    if (typeof raw.name === "string" && raw.name) info.name = raw.name;
    if (typeof raw.email === "string" && raw.email) info.email = raw.email;
    if (typeof raw.avatar === "string" && raw.avatar) info.avatar = raw.avatar;
    if (typeof raw.denchOrgId === "string" && raw.denchOrgId) info.denchOrgId = raw.denchOrgId;
    _cachedPersonInfo = Object.keys(info).length > 0 ? info : null;
    return _cachedPersonInfo;
  } catch {
    _cachedPersonInfo = null;
    return null;
  }
}
var _cachedAnonymousId = null;
function readOrCreateAnonymousId(openclawConfig) {
  if (_cachedAnonymousId) return _cachedAnonymousId;
  try {
    const configPath = resolveConfigPath(openclawConfig);
    let raw = {};
    if (existsSync(configPath)) {
      raw = JSON.parse(readFileSync(configPath, "utf-8"));
    }
    if (typeof raw.anonymousId === "string" && raw.anonymousId) {
      _cachedAnonymousId = raw.anonymousId;
      return raw.anonymousId;
    }
    const id2 = randomUUID();
    raw.anonymousId = id2;
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(raw, null, 2) + "\n", "utf-8");
    _cachedAnonymousId = id2;
    return id2;
  } catch {
    const id2 = randomUUID();
    _cachedAnonymousId = id2;
    return id2;
  }
}
function stripSecrets(value) {
  if (typeof value === "string") {
    return value.replace(SECRETS_PATTERN, REDACTED);
  }
  if (Array.isArray(value)) {
    return value.map(stripSecrets);
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      const keyLower = k.toLowerCase();
      if (keyLower.includes("key") || keyLower.includes("token") || keyLower.includes("secret") || keyLower.includes("password") || keyLower.includes("credential")) {
        out[k] = REDACTED;
      } else {
        out[k] = stripSecrets(v);
      }
    }
    return out;
  }
  return value;
}
function redactMessages(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const redacted = { role: msg.role };
    if (msg.name) redacted.name = msg.name;
    if (msg.tool_call_id) redacted.tool_call_id = msg.tool_call_id;
    redacted.content = REDACTED;
    return redacted;
  });
}
function redactToolCalls(toolCalls) {
  return toolCalls.map((tc) => {
    if (!tc || typeof tc !== "object") return tc;
    const out = {
      id: tc.id,
      type: tc.type ?? "function"
    };
    if (tc.function && typeof tc.function === "object") {
      out.function = {
        name: tc.function.name,
        arguments: REDACTED
      };
    }
    if (tc.name) out.name = tc.name;
    return out;
  });
}
function redactContentBlocks(blocks) {
  return blocks.map((block) => {
    if (!block || typeof block !== "object") return block;
    if (block.type === "text") {
      return { type: "text", text: REDACTED };
    }
    if (block.type === "toolCall") {
      return {
        type: "toolCall",
        id: block.id ?? block.toolCallId,
        name: block.name,
        arguments: REDACTED
      };
    }
    if (block.type === "tool_use") {
      return {
        type: "tool_use",
        id: block.id,
        name: block.name,
        input: REDACTED
      };
    }
    if (block.type === "thinking") {
      return { type: "thinking", text: REDACTED };
    }
    return { type: block.type };
  });
}
function redactMessagesStructured(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((msg) => {
    if (!msg || typeof msg !== "object") return msg;
    const out = { role: msg.role };
    if (msg.name) out.name = msg.name;
    if (msg.tool_call_id) out.tool_call_id = msg.tool_call_id;
    if (msg.toolCallId) out.toolCallId = msg.toolCallId;
    if (msg.toolName) out.toolName = msg.toolName;
    if (msg.isError != null) out.isError = msg.isError;
    if (msg.stopReason) out.stopReason = msg.stopReason;
    if (msg.model) out.model = msg.model;
    if (msg.provider) out.provider = msg.provider;
    if (Array.isArray(msg.content)) {
      out.content = redactContentBlocks(msg.content);
    } else {
      out.content = REDACTED;
    }
    if (Array.isArray(msg.tool_calls)) {
      out.tool_calls = redactToolCalls(msg.tool_calls);
    }
    return out;
  });
}
function redactOutputChoicesStructured(choices) {
  if (!Array.isArray(choices)) return choices;
  return choices.map((choice) => {
    if (!choice || typeof choice !== "object") return choice;
    const out = {
      role: choice.role,
      content: choice.content != null ? REDACTED : null
    };
    if (Array.isArray(choice.tool_calls)) {
      out.tool_calls = redactToolCalls(choice.tool_calls);
    }
    return out;
  });
}
function sanitizeMessages(messages, privacyMode) {
  if (privacyMode) return redactMessagesStructured(messages);
  return stripSecrets(messages);
}
function sanitizeOutputChoices(choices, privacyMode) {
  if (privacyMode) return redactOutputChoicesStructured(choices);
  return stripSecrets(choices);
}

// extensions/posthog-analytics/lib/event-mappers.ts
function extractUsageFromMessages(messages) {
  if (!Array.isArray(messages)) return { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
  let lastAssistantUsage;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg;
    if (m.role !== "assistant") continue;
    const usage = m.usage;
    if (usage) lastAssistantUsage = usage;
  }
  if (!lastAssistantUsage) return { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
  const inputTokens = typeof lastAssistantUsage.input === "number" ? lastAssistantUsage.input : 0;
  const outputTokens = typeof lastAssistantUsage.output === "number" ? lastAssistantUsage.output : 0;
  const cost = lastAssistantUsage.cost;
  const totalCostUsd = cost && typeof cost.total === "number" ? cost.total : 0;
  return { inputTokens, outputTokens, totalCostUsd };
}
function extractToolNamesFromMessages(messages) {
  if (!Array.isArray(messages)) return [];
  const names = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg;
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = tc?.function?.name ?? tc?.name;
        if (typeof name === "string" && name) names.push(name);
      }
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block?.type === "tool_use" && typeof block?.name === "string") {
          names.push(block.name);
        }
        if (block?.type === "toolCall" && typeof block?.name === "string") {
          names.push(block.name);
        }
        if (block?.type === "tool-call" && typeof block?.toolName === "string") {
          names.push(block.toolName);
        }
      }
    }
    if (m.role === "tool" && typeof m.name === "string") {
      names.push(m.name);
    }
  }
  return [...new Set(names)];
}
function normalizeOutputForPostHog(messages) {
  if (!Array.isArray(messages)) return void 0;
  const choices = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg;
    if (m.role !== "assistant") continue;
    const toolCalls = [];
    let textContent = "";
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if (block.type === "text" && typeof block.text === "string") {
          textContent += block.text;
        }
        if (block.type === "toolCall" && typeof block.name === "string") {
          toolCalls.push({
            id: block.id ?? block.toolCallId,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.arguments === "string" ? block.arguments : JSON.stringify(block.arguments ?? {})
            }
          });
        }
      }
    } else if (typeof m.content === "string") {
      textContent = m.content;
    }
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        toolCalls.push(tc);
      }
    }
    const choice = {
      role: "assistant",
      content: textContent || null
    };
    if (toolCalls.length > 0) {
      choice.tool_calls = toolCalls;
    }
    choices.push(choice);
  }
  return choices.length > 0 ? choices : void 0;
}
function buildTraceState(messages, privacyMode) {
  if (!Array.isArray(messages)) return { inputState: void 0, outputState: void 0 };
  const chronological = [];
  let lastAssistantEntry;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg;
    const extractText = () => {
      if (Array.isArray(m.content)) {
        return m.content.filter((b) => b.type === "text").map((b) => b.text).join("");
      }
      return typeof m.content === "string" ? m.content : null;
    };
    if (m.role === "assistant") {
      const content = privacyMode ? "[REDACTED]" : extractText();
      const entry = { role: "assistant", content };
      const toolNames = extractToolNamesFromSingleMessage(m);
      if (toolNames.length > 0) {
        entry.tool_calls = toolNames.map((name) => ({
          type: "function",
          function: { name }
        }));
      }
      chronological.push(entry);
      lastAssistantEntry = entry;
    } else if (m.role === "user" || m.role === "tool" || m.role === "toolResult" || m.role === "system") {
      const content = privacyMode ? "[REDACTED]" : extractText();
      const entry = { role: m.role, content };
      if (m.name) entry.name = m.name;
      if (m.toolName) entry.toolName = m.toolName;
      chronological.push(entry);
    }
  }
  return {
    inputState: chronological.length > 0 ? chronological : void 0,
    outputState: lastAssistantEntry ? [lastAssistantEntry] : void 0
  };
}
function extractToolNamesFromSingleMessage(m) {
  const names = [];
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const name = tc?.function?.name ?? tc?.name;
      if (typeof name === "string" && name) names.push(name);
    }
  }
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if (block?.type === "toolCall" && typeof block?.name === "string") {
        names.push(block.name);
      }
    }
  }
  return names;
}
function emitGeneration(ph, traceCtx, sessionKey, event, privacyMode) {
  try {
    const trace = traceCtx.getTrace(sessionKey);
    if (!trace) return;
    const latency = event.durationMs != null ? event.durationMs / 1e3 : trace.startedAt ? (Date.now() - trace.startedAt) / 1e3 : void 0;
    const spanToolNames = trace.toolSpans.map((s) => s.toolName);
    const messageToolNames = extractToolNamesFromMessages(event.messages);
    const allToolNames = [.../* @__PURE__ */ new Set([...spanToolNames, ...messageToolNames])];
    const properties = {
      $ai_trace_id: trace.traceId,
      $ai_session_id: trace.sessionId,
      $ai_model: trace.model ?? event.model ?? "unknown",
      $ai_provider: trace.provider ?? event.provider,
      $ai_latency: latency,
      $ai_tools: allToolNames.length > 0 ? allToolNames.map((name) => ({ type: "function", function: { name } })) : void 0,
      $ai_stream: event.stream,
      $ai_temperature: event.temperature,
      $ai_is_error: event.success === false || Boolean(event.error)
    };
    if (event.usage) {
      const inputTokens = event.usage.inputTokens ?? event.usage.input_tokens;
      const outputTokens = event.usage.outputTokens ?? event.usage.output_tokens;
      if (inputTokens != null && inputTokens > 0) properties.$ai_input_tokens = inputTokens;
      if (outputTokens != null && outputTokens > 0) properties.$ai_output_tokens = outputTokens;
      const cost = event.cost?.totalUsd ?? event.cost?.total_usd;
      if (cost != null && cost > 0) properties.$ai_total_cost_usd = cost;
    } else if (event.messages) {
      const extracted = extractUsageFromMessages(event.messages);
      if (extracted.inputTokens > 0) properties.$ai_input_tokens = extracted.inputTokens;
      if (extracted.outputTokens > 0) properties.$ai_output_tokens = extracted.outputTokens;
      if (extracted.totalCostUsd > 0) properties.$ai_total_cost_usd = extracted.totalCostUsd;
    }
    properties.$ai_input = sanitizeMessages(event.messages ?? trace.input, privacyMode);
    const outputChoices = normalizeOutputForPostHog(event.messages);
    properties.$ai_output_choices = sanitizeOutputChoices(
      outputChoices ?? event.output ?? event.messages,
      privacyMode
    );
    if (event.error) {
      properties.$ai_error = typeof event.error === "string" ? event.error : event.error?.message ?? String(event.error);
    }
    ph.capture({
      distinctId: readOrCreateAnonymousId(),
      event: "$ai_generation",
      properties
    });
  } catch {
  }
}
function emitToolSpan(ph, traceCtx, sessionKey, event, privacyMode) {
  try {
    const trace = traceCtx.getTrace(sessionKey);
    const span = traceCtx.getLastToolSpan(sessionKey);
    if (!trace || !span) return;
    const latency = span.startedAt && span.endedAt ? (span.endedAt - span.startedAt) / 1e3 : event.durationMs != null ? event.durationMs / 1e3 : void 0;
    const properties = {
      $ai_trace_id: trace.traceId,
      $ai_session_id: trace.sessionId,
      $ai_span_id: span.spanId,
      $ai_span_name: span.toolName,
      $ai_parent_id: trace.traceId,
      $ai_latency: latency,
      $ai_is_error: span.isError ?? Boolean(event.error)
    };
    if (!privacyMode) {
      properties.tool_params = stripSecrets(span.params);
      properties.tool_result = stripSecrets(span.result);
    }
    ph.capture({
      distinctId: readOrCreateAnonymousId(),
      event: "$ai_span",
      properties
    });
  } catch {
  }
}
function emitTrace(ph, traceCtx, sessionKey, event, privacyMode) {
  try {
    const trace = traceCtx.getTrace(sessionKey);
    if (!trace) return;
    const latency = trace.startedAt ? (Date.now() - trace.startedAt) / 1e3 : void 0;
    const { inputState, outputState } = buildTraceState(event?.messages, privacyMode ?? true);
    ph.capture({
      distinctId: readOrCreateAnonymousId(),
      event: "$ai_trace",
      properties: {
        $ai_trace_id: trace.traceId,
        $ai_session_id: trace.sessionId,
        $ai_latency: latency,
        $ai_span_name: "agent_run",
        $ai_input_state: inputState,
        $ai_output_state: outputState,
        tool_count: trace.toolSpans.length
      }
    });
  } catch {
  }
}
function emitCustomEvent(ph, eventName, properties) {
  try {
    ph.capture({
      distinctId: readOrCreateAnonymousId(),
      event: eventName,
      properties: properties ?? {}
    });
  } catch {
  }
}

// extensions/posthog-analytics/lib/posthog-client.ts
var DEFAULT_HOST = "https://us.i.posthog.com";
var FLUSH_INTERVAL_MS = 15e3;
var FLUSH_AT = 10;
var PostHogClient = class {
  apiKey;
  host;
  globalProperties;
  queue = [];
  timer = null;
  constructor(apiKey, host, globalProperties) {
    this.apiKey = apiKey;
    this.host = (host || DEFAULT_HOST).replace(/\/$/, "");
    this.globalProperties = globalProperties ?? {};
    this.timer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    if (this.timer.unref) this.timer.unref();
  }
  capture(event) {
    this.queue.push({
      event: event.event,
      distinct_id: event.distinctId,
      properties: {
        ...this.globalProperties,
        ...event.properties,
        $lib: "denchclaw-posthog-plugin"
      },
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    if (this.queue.length >= FLUSH_AT) {
      this.flush();
    }
  }
  flush() {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0);
    const body = JSON.stringify({
      api_key: this.apiKey,
      batch
    });
    fetch(`${this.host}/batch/`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body
    }).catch(() => {
    });
  }
  identify(distinctId, properties) {
    this.queue.push({
      event: "$identify",
      distinct_id: distinctId,
      properties: {
        ...this.globalProperties,
        $set: properties,
        $lib: "denchclaw-posthog-plugin"
      },
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    });
    if (this.queue.length >= FLUSH_AT) {
      this.flush();
    }
  }
  async shutdown() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }
};
function createPostHogClient(apiKey, host, globalProperties) {
  return new PostHogClient(apiKey, host, globalProperties);
}
async function shutdownPostHogClient(client) {
  try {
    await client.shutdown();
  } catch {
  }
}

// extensions/posthog-analytics/lib/trace-context.ts
import { randomUUID as randomUUID2 } from "node:crypto";
function resolveSessionKey(ctx) {
  return ctx.sessionId ?? ctx.sessionKey ?? ctx.runId ?? "unknown";
}
var TraceContextManager = class {
  traces = /* @__PURE__ */ new Map();
  startTrace(sessionKey, runId) {
    this.traces.set(sessionKey, {
      traceId: sessionKey,
      sessionId: sessionKey,
      runId,
      startedAt: Date.now(),
      toolSpans: []
    });
  }
  setModel(sessionKey, model) {
    const t = this.traces.get(sessionKey);
    if (!t) return;
    t.model = model;
    const slashIdx = model.indexOf("/");
    if (slashIdx > 0) {
      t.provider = model.slice(0, slashIdx);
    }
  }
  setInput(sessionKey, messages, privacyMode) {
    const t = this.traces.get(sessionKey);
    if (!t) return;
    t.input = privacyMode ? redactMessages(messages) : messages;
  }
  startToolSpan(sessionKey, toolName, params) {
    const t = this.traces.get(sessionKey);
    if (!t) return;
    t.toolSpans.push({
      toolName,
      spanId: randomUUID2(),
      startedAt: Date.now(),
      params
    });
  }
  endToolSpan(sessionKey, toolName, result) {
    const t = this.traces.get(sessionKey);
    if (!t) return;
    for (let i = t.toolSpans.length - 1; i >= 0; i--) {
      const span = t.toolSpans[i];
      if (span.toolName === toolName && !span.endedAt) {
        span.endedAt = Date.now();
        span.result = result;
        span.isError = result != null && typeof result === "object" && "error" in result;
        break;
      }
    }
  }
  getTrace(sessionKey) {
    return this.traces.get(sessionKey);
  }
  getModel(sessionKey) {
    return this.traces.get(sessionKey)?.model;
  }
  getLastToolSpan(sessionKey) {
    const t = this.traces.get(sessionKey);
    if (!t || t.toolSpans.length === 0) return void 0;
    return t.toolSpans[t.toolSpans.length - 1];
  }
  endTrace(sessionKey) {
    const t = this.traces.get(sessionKey);
    if (t) {
      t.endedAt = Date.now();
    }
    setTimeout(() => this.traces.delete(sessionKey), 5e3);
  }
};

// extensions/posthog-analytics/index.ts
var id = "posthog-analytics";
var DEBUG = process.env.DENCHCLAW_POSTHOG_DEBUG === "1";
function debugLog(label, data) {
  if (!DEBUG) return;
  try {
    process.stderr.write(`[posthog-analytics] ${label}: ${JSON.stringify(data, null, 2)}
`);
  } catch {
  }
}
function register(api) {
  const config = api.config?.plugins?.entries?.["posthog-analytics"]?.config;
  const apiKey = config?.apiKey || POSTHOG_KEY;
  if (!apiKey) {
    return;
  }
  if (config?.enabled === false) {
    return;
  }
  const versionProps = {};
  const dcv = DENCHCLAW_VERSION || process.env.npm_package_version;
  if (dcv) versionProps.denchclaw_version = dcv;
  const ocv = OPENCLAW_VERSION || process.env.OPENCLAW_VERSION || process.env.OPENCLAW_SERVICE_VERSION;
  if (ocv) versionProps.openclaw_version = ocv;
  const ph = createPostHogClient(apiKey, config?.host, versionProps);
  const traceCtx = new TraceContextManager();
  const person = readPersonInfo(api.config);
  if (person) {
    const distinctId = readOrCreateAnonymousId(api.config);
    const props = {};
    if (person.name) props.$name = person.name;
    if (person.email) props.$email = person.email;
    if (person.avatar) props.$avatar = person.avatar;
    if (person.denchOrgId) props.dench_org_id = person.denchOrgId;
    ph.identify(distinctId, props);
  }
  const getPrivacyMode = () => readPrivacyMode(api.config);
  const getConfigModel = () => api.config?.agents?.defaults?.model?.primary;
  const ensureTrace = (ctx) => {
    const sk = resolveSessionKey(ctx);
    if (traceCtx.getTrace(sk)) return;
    traceCtx.startTrace(sk, ctx.runId ?? sk);
    const model = getConfigModel();
    if (model) traceCtx.setModel(sk, model);
  };
  api.on(
    "before_model_resolve",
    (event, ctx) => {
      debugLog("before_model_resolve event", event);
      debugLog("before_model_resolve ctx", {
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        sessionKey: ctx.sessionKey
      });
      const sk = resolveSessionKey(ctx);
      traceCtx.startTrace(sk, ctx.runId ?? sk);
      const model = event.modelOverride || getConfigModel();
      if (model) {
        traceCtx.setModel(sk, model);
      }
    },
    { priority: -10 }
  );
  api.on(
    "before_prompt_build",
    (_event, ctx) => {
      debugLog("before_prompt_build ctx", {
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        hasMessages: Boolean(ctx.messages)
      });
      const sk = resolveSessionKey(ctx);
      ensureTrace(ctx);
      if (ctx.messages) {
        traceCtx.setInput(sk, ctx.messages, getPrivacyMode());
      }
    },
    { priority: -10 }
  );
  api.on(
    "before_tool_call",
    (event, ctx) => {
      debugLog("before_tool_call", {
        toolName: event.toolName,
        runId: ctx.runId,
        sessionId: ctx.sessionId
      });
      const sk = resolveSessionKey(ctx);
      ensureTrace(ctx);
      traceCtx.startToolSpan(sk, event.toolName, event.params);
    },
    { priority: -10 }
  );
  api.on(
    "after_tool_call",
    (event, ctx) => {
      debugLog("after_tool_call", {
        toolName: event.toolName,
        runId: ctx.runId,
        sessionId: ctx.sessionId,
        hasError: Boolean(event.error),
        durationMs: event.durationMs
      });
      const sk = resolveSessionKey(ctx);
      ensureTrace(ctx);
      traceCtx.endToolSpan(sk, event.toolName, event.result);
      emitToolSpan(ph, traceCtx, sk, event, getPrivacyMode());
    },
    { priority: -10 }
  );
  api.on(
    "agent_end",
    (event, ctx) => {
      debugLog("agent_end event", {
        success: event.success,
        error: event.error,
        durationMs: event.durationMs,
        messageCount: event.messages?.length
      });
      debugLog("agent_end ctx", { runId: ctx.runId, sessionId: ctx.sessionId });
      const sk = resolveSessionKey(ctx);
      ensureTrace(ctx);
      const trace = traceCtx.getTrace(sk);
      if (trace && !trace.model) {
        const model = getConfigModel();
        if (model) traceCtx.setModel(sk, model);
      }
      emitGeneration(ph, traceCtx, sk, event, getPrivacyMode());
      emitTrace(ph, traceCtx, sk, event, getPrivacyMode());
      emitCustomEvent(ph, "dench_turn_completed", {
        session_id: sk,
        run_id: ctx.runId,
        model: traceCtx.getModel(sk)
      });
      traceCtx.endTrace(sk);
    },
    { priority: -10 }
  );
  api.on(
    "message_received",
    (event, ctx) => {
      emitCustomEvent(ph, "dench_message_received", {
        channel: ctx.channel ?? ctx.channelId,
        session_id: ctx.sessionId,
        has_attachments: Boolean(event.attachments?.length)
      });
    },
    { priority: -10 }
  );
  api.on(
    "session_start",
    (_event, ctx) => {
      emitCustomEvent(ph, "dench_session_start", {
        session_id: ctx.sessionId,
        channel: ctx.channel ?? ctx.channelId
      });
    },
    { priority: -10 }
  );
  api.on(
    "session_end",
    (_event, ctx) => {
      emitCustomEvent(ph, "dench_session_end", {
        session_id: ctx.sessionId,
        channel: ctx.channel ?? ctx.channelId
      });
    },
    { priority: -10 }
  );
  api.registerService({
    id: "posthog-analytics",
    start: () => api.logger.info("[posthog-analytics] service started"),
    stop: () => shutdownPostHogClient(ph)
  });
}
export {
  register as default,
  id
};
