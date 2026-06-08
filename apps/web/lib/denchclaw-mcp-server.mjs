#!/usr/bin/env node
/**
 * DenchClaw MCP Server
 *
 * Exposes DenchClaw tools (Exa search, Apollo enrichment, Composio integrations)
 * as MCP tools over stdio via the direct Composio API (backend.composio.dev).
 *
 * No Dench Cloud gateway key required — uses COMPOSIO_API_KEY + COMPOSIO_USER_ID
 * from environment, with connected accounts from composio.json.
 *
 * Usage (Hermes config.yaml):
 *   mcp_servers:
 *     denchclaw:
 *       command: node
 *       args: ["apps/web/lib/denchclaw-mcp-server.mjs"]
 *       cwd: /root/.openclaw-dench/source/DenchClaw
 *       env:
 *         COMPOSIO_API_KEY: "ak_..."
 *         COMPOSIO_USER_ID: "rebattery-default"
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

// ─── Config ──────────────────────────────────────────────────────────────────

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3";
const composioApiKey = (process.env.COMPOSIO_API_KEY || "").trim();
const composioUserId = (process.env.COMPOSIO_USER_ID || "").trim();

function readComposioJson() {
  const candidates = [
    join(process.cwd(), "composio.json"),
    "/root/.openclaw-dench/composio.json",
    join(process.env.OPENCLAW_STATE_DIR || "", "composio.json"),
  ];
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
    } catch { /* ignore */ }
  }
  return {};
}

const composioConfig = readComposioJson();
const connectedAccounts = composioConfig.connectedAccounts || {};

// ─── HTTP helpers ────────────────────────────────────────────────────────────

async function composioGet(path) {
  const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    method: "GET",
    headers: { accept: "application/json", "x-api-key": composioApiKey },
  });
  const text = await response.text();
  if (!response.ok) return { error: `HTTP ${response.status}: ${text.slice(0, 500)}` };
  try { return JSON.parse(text); } catch { return text; }
}

async function composioPost(path, body) {
  const response = await fetch(`${COMPOSIO_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "x-api-key": composioApiKey,
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) return { error: `HTTP ${response.status}: ${text.slice(0, 500)}` };
  try { return JSON.parse(text); } catch { return text; }
}

function jsonText(payload) {
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

// ─── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: "exa_search",
    description:
      "Search the web through Exa. Supports neural, fast, deep search types with optional text extraction, highlights, and summary generation.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        numResults: { type: "number", description: "Maximum number of results." },
        text: { type: "boolean", description: "Include extracted page text." },
        highlights: { type: "boolean", description: "Include highlights." },
        summary: { type: "boolean", description: "Include a summary." },
      },
      required: ["query"],
    },
  },
  {
    name: "exa_get_contents",
    description: "Fetch page contents for one or more URLs through Exa.",
    inputSchema: {
      type: "object",
      properties: {
        urls: { type: "array", items: { type: "string" }, description: "URLs to fetch." },
        text: { type: "boolean", description: "Include extracted page text." },
      },
      required: ["urls"],
    },
  },
  {
    name: "exa_answer",
    description: "Ask Exa for a citation-backed answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Question to answer." },
      },
      required: ["query"],
    },
  },
  {
    name: "apollo_enrich",
    description:
      'Look up Apollo people, companies, or people search results. Use action "people" for an individual profile, "company" for company enrichment by domain, or "people_search" to search people with filters.',
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["people", "company", "people_search"], description: "Action to perform." },
        email: { type: "string", description: "Email for people enrichment." },
        linkedin_url: { type: "string", description: "LinkedIn URL." },
        first_name: { type: "string", description: "First name." },
        last_name: { type: "string", description: "Last name." },
        domain: { type: "string", description: "Company domain." },
        organization_name: { type: "string", description: "Organization name." },
        person_titles: { type: "array", items: { type: "string" }, description: "Job titles for search." },
        person_locations: { type: "array", items: { type: "string" }, description: "Locations for search." },
        organization_domains: { type: "array", items: { type: "string" }, description: "Org domains for search." },
      },
      required: ["action"],
    },
  },
  {
    name: "dench_search_integrations",
    description:
      "Search available integration tools by natural language query. Returns tool slugs, input schemas, and connection status for 500+ integrations (Gmail, Slack, GitHub, Notion, Calendar, Linear, Stripe, etc.).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language description of the action needed." },
        toolkit: { type: "string", description: "Optional toolkit slug to narrow search (e.g. gmail, github, slack)." },
        limit: { type: "integer", description: "Max results. Defaults to 20." },
      },
      required: ["query"],
    },
  },
  {
    name: "dench_execute_integrations",
    description:
      "Execute an integration tool by its slug. Use dench_search_integrations first to find the tool_slug and input schema.",
    inputSchema: {
      type: "object",
      properties: {
        tool_slug: { type: "string", description: "Tool slug from search (e.g. GMAIL_FETCH_EMAILS)." },
        arguments: { type: "object", additionalProperties: true, description: "Arguments matching the tool's input_schema." },
        connected_account_id: { type: "string", description: "Optional connected account ID for multi-account toolkits." },
      },
      required: ["tool_slug"],
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────

function getConnectedAccountId(toolkit) {
  const normalized = toolkit.toLowerCase().replace(/-/g, "");
  const account = connectedAccounts[normalized];
  return account?.connectedAccountId || null;
}

async function executeTool(name, args) {
  let result;

  switch (name) {
    case "exa_search": {
      const connectedAccountId = getConnectedAccountId("exa");
      if (!connectedAccountId) {
        result = { error: "Exa is not connected. Connect it in the Integrations panel." };
        break;
      }
      const inputArgs = { query: args.query };
      if (args.numResults) inputArgs.numResults = args.numResults;
      if (args.text) inputArgs.text = args.text;
      if (args.highlights) inputArgs.highlights = args.highlights;
      if (args.summary) inputArgs.summary = args.summary;
      result = await composioPost(`/tools/execute/EXA_SEARCH`, {
        user_id: composioUserId,
        connected_account_id: connectedAccountId,
        arguments: inputArgs,
      });
      break;
    }

    case "exa_get_contents": {
      const connectedAccountId = getConnectedAccountId("exa");
      if (!connectedAccountId) {
        result = { error: "Exa is not connected. Connect it in the Integrations panel." };
        break;
      }
      const urls = Array.isArray(args.urls) ? args.urls : [];
      if (urls.length === 0) {
        result = { error: "At least one URL is required." };
        break;
      }
      result = await composioPost(`/tools/execute/EXA_GET_CONTENTS`, {
        user_id: composioUserId,
        connected_account_id: connectedAccountId,
        arguments: { urls, text: args.text ?? true },
      });
      break;
    }

    case "exa_answer": {
      const connectedAccountId = getConnectedAccountId("exa");
      if (!connectedAccountId) {
        result = { error: "Exa is not connected. Connect it in the Integrations panel." };
        break;
      }
      result = await composioPost(`/tools/execute/EXA_ANSWER`, {
        user_id: composioUserId,
        connected_account_id: connectedAccountId,
        arguments: { query: args.query },
      });
      break;
    }

    case "apollo_enrich": {
      const connectedAccountId = getConnectedAccountId("apollo");
      if (!connectedAccountId) {
        result = { error: "Apollo is not connected. Connect it in the Integrations panel." };
        break;
      }
      const action = args.action;
      const toolArgs = {};
      if (action === "people") {
        if (args.email) toolArgs.email = args.email;
        if (args.linkedin_url) toolArgs.linkedin_url = args.linkedin_url;
        if (args.first_name) toolArgs.first_name = args.first_name;
        if (args.last_name) toolArgs.last_name = args.last_name;
        if (args.domain) toolArgs.domain = args.domain;
        if (args.organization_name) toolArgs.organization_name = args.organization_name;
        if (!toolArgs.email && !toolArgs.linkedin_url && !toolArgs.first_name && !toolArgs.last_name) {
          result = { error: "People enrichment requires at least an email, LinkedIn URL, or person name." };
          break;
        }
        result = await composioPost(`/tools/execute/APOLLO_PEOPLE_ENRICHMENT`, {
          user_id: composioUserId,
          connected_account_id: connectedAccountId,
          arguments: toolArgs,
        });
      } else if (action === "company") {
        if (!args.domain) {
          result = { error: "Company enrichment requires a domain." };
          break;
        }
        result = await composioPost(`/tools/execute/APOLLO_COMPANY_ENRICHMENT`, {
          user_id: composioUserId,
          connected_account_id: connectedAccountId,
          arguments: { domain: args.domain },
        });
      } else if (action === "people_search") {
        if (args.person_titles) toolArgs.person_titles = args.person_titles;
        if (args.person_locations) toolArgs.person_locations = args.person_locations;
        if (args.organization_domains) toolArgs.organization_domains = args.organization_domains;
        result = await composioPost(`/tools/execute/APOLLO_PEOPLE_SEARCH`, {
          user_id: composioUserId,
          connected_account_id: connectedAccountId,
          arguments: toolArgs,
        });
      } else {
        result = { error: `Unknown action "${String(action)}". Use "people", "company", or "people_search".` };
      }
      break;
    }

    case "dench_search_integrations": {
      const params = new URLSearchParams();
      if (args.query) params.set("search", args.query);
      const toolkit = (args.toolkit || "").toLowerCase().replace(/-/g, "");
      if (toolkit) params.set("toolkit_slug", toolkit);
      params.set("limit", String(args.limit || 20));
      result = await composioGet(`/tools?${params.toString()}`);
      break;
    }

    case "dench_execute_integrations": {
      const toolSlug = typeof args.tool_slug === "string" ? args.tool_slug.trim() : "";
      if (!toolSlug) {
        result = { error: "tool_slug is required. Use dench_search_integrations first." };
        break;
      }
      const body = {
        user_id: composioUserId,
        arguments: typeof args.arguments === "object" && args.arguments !== null ? args.arguments : {},
      };
      if (typeof args.connected_account_id === "string" && args.connected_account_id.trim()) {
        body.connected_account_id = args.connected_account_id.trim();
      }
      result = await composioPost(`/tools/execute/${encodeURIComponent(toolSlug)}`, body);
      break;
    }

    default:
      result = { error: `Unknown tool: ${name}` };
  }

  return {
    content: [{ type: "text", text: jsonText(result) }],
  };
}

// ─── MCP JSON-RPC server ─────────────────────────────────────────────────────

const SERVER_INFO = { name: "denchclaw", version: "1.0.0" };
const CAPABILITIES = { tools: {} };

async function handleRequest(request) {
  const method = request.method;
  const id = request.id;

  switch (method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: CAPABILITIES,
          serverInfo: SERVER_INFO,
        },
      };

    case "notifications/initialized":
      return null;

    case "tools/list":
      return { jsonrpc: "2.0", id, result: { tools: TOOLS } };

    case "tools/call": {
      const params = request.params || {};
      const toolName = params.name;
      const toolArgs = params.arguments || {};

      if (!toolName) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: "Error: tool name is required." }],
            isError: true,
          },
        };
      }

      try {
        const result = await executeTool(toolName, toolArgs);
        return { jsonrpc: "2.0", id, result };
      } catch (err) {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: `Tool execution failed: ${err.message || String(err)}` }],
            isError: true,
          },
        };
      }
    }

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    default:
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

// ─── Main loop ───────────────────────────────────────────────────────────────

if (!composioApiKey) {
  console.error("[denchclaw-mcp] No COMPOSIO_API_KEY found. Set it in environment.");
  process.exit(1);
}
if (!composioUserId) {
  console.error("[denchclaw-mcp] No COMPOSIO_USER_ID found. Set it in environment.");
  process.exit(1);
}

console.error(`[denchclaw-mcp] Starting MCP server. Composio API: ${COMPOSIO_API_BASE}`);
console.error(`[denchclaw-mcp] Connected accounts: ${Object.keys(connectedAccounts).join(", ")}`);

const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;

  try {
    const request = JSON.parse(trimmed);
    const response = await handleRequest(request);
    if (response !== null) {
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  } catch (err) {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: `Parse error: ${err.message || String(err)}` },
    }) + "\n");
  }
});

rl.on("close", () => {
  console.error("[denchclaw-mcp] Server stopped.");
});
