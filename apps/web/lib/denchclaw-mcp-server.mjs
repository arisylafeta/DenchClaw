#!/usr/bin/env node
/**
 * ReBattery CRM MCP Server
 *
 * Exposes DenchClaw tools (Exa search, Apollo enrichment, Composio integrations,
 * and a curated CRM DB tool layer) as MCP tools over stdio via the direct
 * Composio API (backend.composio.dev).
 *
 * No ReBattery Cloud gateway key required — uses COMPOSIO_API_KEY + COMPOSIO_USER_ID
 * from environment, with connected accounts from composio.json.
 *
 * CRM DB layer:
 *   - Curated tools (crm_schema_overview, crm_get_company_profile,
 *     crm_get_person_profile, crm_search_companies, crm_search_people,
 *     crm_create_company, crm_create_person, crm_update_company,
 *     crm_update_person) are the preferred path for agents.
 *   - crm_query / crm_tables remain as read helpers.
 *   - crm_execute is an escape hatch for one-off mutations/DDL.
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
import { homedir } from "node:os";
import { join, resolve, isAbsolute } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import pg from "pg";

// ─── Config ──────────────────────────────────────────────────────────────────

const COMPOSIO_API_BASE = "https://backend.composio.dev/api/v3";
const composioApiKey = (process.env.COMPOSIO_API_KEY || "").trim();
const composioUserId = (process.env.COMPOSIO_USER_ID || "").trim();

function readComposioJson() {
  const candidates = [
    process.env.OPENCLAW_STATE_DIR ? join(process.env.OPENCLAW_STATE_DIR, "composio.json") : null,
    join(process.env.DENCH_HOME || homedir(), ".openclaw-dench", "composio.json"),
    process.env.DENCH_HOME ? join(process.env.DENCH_HOME, "composio.json") : null,
    process.env.DENCH_HOME ? join(process.env.DENCH_HOME, "profiles", "default", "composio.json") : null,
  ].filter(Boolean);
  for (const p of candidates) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"));
    } catch { /* ignore */ }
  }
  return {};
}

const composioConfig = readComposioJson();
const connectedAccounts = composioConfig.connectedAccounts || {};

// ─── PostgreSQL ───────────────────────────────────────────────────────────────

let _pgPool = null;
function pgPool() {
  if (!_pgPool) {
    const config = process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : { host: "/var/run/postgresql", database: "denchclaw" };
    _pgPool = new pg.Pool({ ...config, max: 5, idleTimeoutMillis: 30_000 });
  }
  return _pgPool;
}

// Test hook: allow injecting a fake pool. When set, pgPool() returns this.
let _injectedPool = null;
export function __setPgPoolForTests(pool) {
  _injectedPool = pool;
  _pgPool = null;
}
export function __resetPgPoolForTests() {
  _injectedPool = null;
  _pgPool = null;
}

// ─── Enrichment PostgreSQL ───────────────────────────────────────────────────

let _pgEnrichmentPool = null;
function pgEnrichmentPool() {
  if (!_pgEnrichmentPool) {
    const config = process.env.ENRICHMENT_DATABASE_URL
      ? { connectionString: process.env.ENRICHMENT_DATABASE_URL }
      : { host: "/var/run/postgresql", database: "denchclaw_enrichment_copy" };
    _pgEnrichmentPool = new pg.Pool({ ...config, max: 5, idleTimeoutMillis: 30_000 });
  }
  return _pgEnrichmentPool;
}

async function queryPgEnrichment(sql, params) {
  const result = await pgEnrichmentPool().query(sql, params ?? []);
  return result.rows;
}
function resolvePgPool() {
  return _injectedPool || pgPool();
}

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

// ─── CRM curated layer: allowlists & helpers ─────────────────────────────────

// Hard allowlists for writable fields. id/created_at/updated_at are NEVER
// writable through curated tools (they are server-managed).
const COMPANY_WRITABLE_FIELDS = Object.freeze([
  "name",
  "domain",
  "website",
  "phone",
  "linkedin_url",
  "country",
  "city",
  "notes",
  "tags",
]);

const PERSON_WRITABLE_FIELDS = Object.freeze([
  "full_name",
  "first_name",
  "last_name",
  "email",
  "company_id",
  "phone",
  "job_title",
  "linkedin_url",
  "tags",
  "notes",
  "email_opted_out",
]);

const FORBIDDEN_WRITABLE_FIELDS = Object.freeze(new Set([
  "id", "created_at", "updated_at",
]));

// Create-time required fields. Updates never require these.
const COMPANY_REQUIRED_FIELDS = Object.freeze(["name"]);
const PERSON_REQUIRED_FIELDS = Object.freeze([]);

const SEARCH_HARD_LIMIT = 50;
const USER_SCOPED_TABLE_PATTERN =
  /(^|[^a-z0-9_])(crm_email_threads|crm_email_messages|crm_email_thread_participants|crm_email_message_recipients|crm_interactions|crm_relation_links|work_tasks)([^a-z0-9_]|$)/i;

function referencesUserScopedData(sql) {
  return USER_SCOPED_TABLE_PATTERN.test(sql);
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a fields payload against an allowlist.
 * Returns { ok: true, fields } on success, or { ok: false, error } on failure.
 *
 * By default no fields are required (update-safe). Pass { require } to enforce
 * create-time required fields.
 */
export function validateWritableFields(rawFields, allowlist, { require = [] } = {}) {
  if (!isPlainObject(rawFields)) {
    return { ok: false, error: "fields must be a JSON object." };
  }
  const allow = new Set(allowlist);
  const cleaned = {};
  for (const [key, value] of Object.entries(rawFields)) {
    if (FORBIDDEN_WRITABLE_FIELDS.has(key)) {
      return { ok: false, error: `Field "${key}" is server-managed and cannot be written directly.` };
    }
    if (!allow.has(key)) {
      return { ok: false, error: `Unknown field "${key}". Allowed fields: ${[...allowlist].join(", ")}.` };
    }
    cleaned[key] = value;
  }
  if (Object.keys(cleaned).length === 0) {
    return { ok: false, error: "At least one writable field must be provided." };
  }
  for (const req of require) {
    if (cleaned[req] === undefined || cleaned[req] === null || cleaned[req] === "") {
      return { ok: false, error: `Required field "${req}" is missing or empty.` };
    }
  }
  return { ok: true, fields: cleaned };
}

// Default (no required fields) — safe for updates.
export function validateCompanyFields(rawFields, { require = [] } = {}) {
  return validateWritableFields(rawFields, COMPANY_WRITABLE_FIELDS, { require });
}

export function validatePersonFields(rawFields, { require = [] } = {}) {
  return validateWritableFields(rawFields, PERSON_WRITABLE_FIELDS, { require });
}

// Create-specific validators enforce required fields.
export function validateCompanyCreateFields(rawFields) {
  return validateCompanyFields(rawFields, { require: COMPANY_REQUIRED_FIELDS });
}
export function validatePersonCreateFields(rawFields) {
  return validatePersonFields(rawFields, { require: PERSON_REQUIRED_FIELDS });
}

// ─── CRM curated layer: SQL builders ────────────────────────────────────────

// crm_companies / crm_people use text PKs with no DB-side default, so curated
// create tools generate the id server-side (UUID v4). The id is never accepted
// from the caller — validateWritableFields rejects it.
function buildInsertSql(table, fields) {
  const id = randomUUID();
  const columns = ["id", ...Object.keys(fields)];
  const values = [id, ...Object.values(fields)];
  const colSql = columns.map(quoteIdentifier).join(", ");
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `insert into ${quoteIdentifier(table)} (${colSql}) values (${placeholders}) returning *`;
  return { sql, params: values, id };
}

function buildUpdateSql(table, fields, idValue) {
  const columns = Object.keys(fields);
  const values = Object.values(fields);
  const assignments = columns.map((col, i) => `${quoteIdentifier(col)} = $${i + 1}`).join(", ");
  const sql = `update ${quoteIdentifier(table)} set ${assignments}, updated_at = now() where id = $${values.length + 1} returning *`;
  return { sql, params: [...values, idValue] };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export const TOOLS = [
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
  {
    name: "crm_schema_overview",
    description:
      "Get a curated overview of the denchclaw CRM database schema: core tables, key columns, and notes. This is the recommended first stop for agents learning the schema. Prefer this and the other curated crm_* tools over raw SQL.",
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
  {
    name: "crm_get_company_profile",
    description:
      "Fetch a single company profile by id, including core attributes and a summary of related people. Preferred over crm_query for company lookups.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Company id (crm_companies.id)." },
      },
      required: ["id"],
    },
  },
  {
    name: "crm_get_person_profile",
    description:
      "Fetch a single person profile by id, including core attributes and their company (if linked). Preferred over crm_query for person lookups.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Person id (crm_people.id)." },
      },
      required: ["id"],
    },
  },
  {
    name: "crm_search_companies",
    description:
      "Search companies by name, domain, country, or free-text query. Returns up to 50 rows. Preferred over crm_query for company search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search across name and domain (case-insensitive)." },
        name: { type: "string", description: "Filter by company name (case-insensitive substring)." },
        domain: { type: "string", description: "Filter by domain (case-insensitive substring)." },
        country: { type: "string", description: "Filter by country (case-insensitive substring)." },
        limit: { type: "integer", description: `Max rows to return. Defaults to 25, hard cap ${SEARCH_HARD_LIMIT}.` },
      },
    },
  },
  {
    name: "crm_search_people",
    description:
      "Search people by name, email, job_title, company_id, or free-text query. Returns up to 50 rows. Preferred over crm_query for person search.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search across full_name and email (case-insensitive)." },
        name: { type: "string", description: "Filter by full name (case-insensitive substring)." },
        email: { type: "string", description: "Filter by email (case-insensitive substring)." },
        job_title: { type: "string", description: "Filter by job title (case-insensitive substring)." },
        company_id: { type: "string", description: "Filter by company_id (exact match)." },
        limit: { type: "integer", description: `Max rows to return. Defaults to 25, hard cap ${SEARCH_HARD_LIMIT}.` },
      },
    },
  },
  {
    name: "crm_create_company",
    description:
      "Create a new company in crm_companies with validated, allowlisted fields. The id is generated server-side. Returns the created row. Preferred over crm_execute for creating companies. Required: name.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description: "Writable company fields. id/created_at/updated_at are rejected (server-managed).",
          properties: {
            name: { type: "string", description: "Company name (required)." },
            domain: { type: "string" },
            website: { type: "string" },
            phone: { type: "string" },
            linkedin_url: { type: "string" },
            country: { type: "string" },
            city: { type: "string" },
            notes: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
          required: ["name"],
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "crm_create_person",
    description:
      "Create a new person in crm_people with validated, allowlisted fields. The id is generated server-side. Returns the created row. Preferred over crm_execute for creating people.",
    inputSchema: {
      type: "object",
      properties: {
        fields: {
          type: "object",
          description: "Writable person fields. id/created_at/updated_at are rejected (server-managed).",
          properties: {
            full_name: { type: "string" },
            first_name: { type: "string" },
            last_name: { type: "string" },
            email: { type: "string" },
            company_id: { type: "string", description: "References crm_companies.id." },
            phone: { type: "string" },
            job_title: { type: "string" },
            linkedin_url: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
            email_opted_out: { type: "boolean" },
          },
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "crm_update_company",
    description:
      "Update an existing company in crm_companies with validated, allowlisted fields. Returns the updated row. Preferred over crm_execute for updating companies. Cannot write id/created_at/updated_at. No field is required for updates.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Company id to update." },
        fields: {
          type: "object",
          description: "Writable company fields to update (same allowlist as crm_create_company). No field is required.",
          properties: {
            name: { type: "string" },
            domain: { type: "string" },
            website: { type: "string" },
            phone: { type: "string" },
            linkedin_url: { type: "string" },
            country: { type: "string" },
            city: { type: "string" },
            notes: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
          },
        },
      },
      required: ["id", "fields"],
    },
  },
  {
    name: "crm_update_person",
    description:
      "Update an existing person in crm_people with validated, allowlisted fields. Returns the updated row. Preferred over crm_execute for updating people. Cannot write id/created_at/updated_at. No field is required for updates.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Person id to update." },
        fields: {
          type: "object",
          description: "Writable person fields to update (same allowlist as crm_create_person). No field is required.",
          properties: {
            full_name: { type: "string" },
            first_name: { type: "string" },
            last_name: { type: "string" },
            email: { type: "string" },
            company_id: { type: "string", description: "References crm_companies.id." },
            phone: { type: "string" },
            job_title: { type: "string" },
            linkedin_url: { type: "string" },
            tags: { type: "array", items: { type: "string" } },
            notes: { type: "string" },
            email_opted_out: { type: "boolean" },
          },
        },
      },
      required: ["id", "fields"],
    },
  },
  {
    name: "crm_query",
    description:
      "Run a read-only SQL query against the denchclaw CRM database (SELECT only). Returns rows as JSON. This is a fallback for ad-hoc reads not covered by curated tools (crm_schema_overview, crm_get_company_profile, crm_get_person_profile, crm_search_companies, crm_search_people). Prefer curated tools first. Use crm_tables to discover available tables and columns. Examples: SELECT * FROM crm_companies LIMIT 10; SELECT name, domain, country FROM crm_companies LIMIT 50;",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL SELECT query." },
        params: { type: "array", items: {}, description: "Parameterized query values ($1, $2, ...)." },
        limit: { type: "integer", description: "Max rows to return. Defaults to 100, hard cap 1000." },
      },
      required: ["sql"],
    },
  },
  {
    name: "crm_execute",
    description:
      "ESCAPE HATCH: Execute a write operation (INSERT, UPDATE, DELETE, or DDL) against the denchclaw CRM database. Returns affected row count. Avoid this when a curated tool (crm_create_company, crm_create_person, crm_update_company, crm_update_person) fits — curated tools validate fields, parameterize SQL, and protect server-managed columns. Use crm_execute only for bulk updates, schema changes, or tables without a curated tool. Examples: UPDATE crm_companies SET country = $1 WHERE id = $2; INSERT INTO crm_people (id, name, email) VALUES ($1, $2, $3);",
    inputSchema: {
      type: "object",
      properties: {
        sql: { type: "string", description: "SQL statement (INSERT/UPDATE/DELETE/DDL)." },
        params: { type: "array", items: {}, description: "Parameterized query values ($1, $2, ...)." },
      },
      required: ["sql"],
    },
  },
  {
    name: "crm_tables",
    description:
      "Get schema overview of the denchclaw CRM database. Returns all tables with column names, types, primary keys, foreign keys, and approximate row counts. Use this to understand the schema before writing raw queries; for a curated summary prefer crm_schema_overview.",
    inputSchema: {
      type: "object",
      properties: {
        table: { type: "string", description: "Optional: get details for a single table only (e.g. 'crm_companies')." },
      },
    },
  },
  {
    name: "crm_enrichment_query",
    description:
      "Query the enrichment copy database for a company by domain. Returns the enriched company row or { found: false } if not enriched yet.",
    inputSchema: {
      type: "object",
      properties: {
        domain: { type: "string", description: "Company domain to look up (e.g. example.com)." },
      },
      required: ["domain"],
    },
  },
];

// ─── Tool execution ──────────────────────────────────────────────────────────

function getConnectedAccountId(toolkit) {
  const normalized = toolkit.toLowerCase().replace(/-/g, "");
  const account = connectedAccounts[normalized];
  return account?.connectedAccountId || null;
}

async function runQuery(sql, params) {
  const client = await resolvePgPool().connect();
  try {
    const res = await client.query(sql, params);
    return res;
  } finally {
    client.release();
  }
}

// Curated CRM tool implementations ───────────────────────────────────────────

async function crmSchemaOverview() {
  return {
    database: "denchclaw",
    description: "Local PostgreSQL CRM database for DenchClaw.",
    core_tables: [
      {
        table: "crm_companies",
        purpose: "Companies (buyers, sellers, recyclers, partners).",
        key_columns: ["id", "name", "domain", "website", "phone", "country", "city", "linkedin_url", "notes", "tags"],
        notes: "Tags are a flexible text[] array for classification (e.g. buyer, exhibit).",
      },
      {
        table: "crm_people",
        purpose: "People/contact records, optionally linked to a company.",
        key_columns: ["id", "full_name", "email", "company_id", "job_title", "phone", "linkedin_url", "notes", "tags"],
        notes: "company_id references crm_companies.id (nullable). email_opted_out gates outreach.",
      },
      {
        table: "crm_email_threads",
        purpose: "Email conversation threads.",
        key_columns: ["id", "subject", "last_message_at", "message_count", "gmail_thread_id"],
      },
      {
        table: "crm_email_messages",
        purpose: "Individual email messages within threads.",
        key_columns: ["id", "thread_id", "from_person_id", "subject", "sent_at", "body_preview"],
      },
      {
        table: "crm_calendar_events",
        purpose: "Calendar events with optional organizer.",
        key_columns: ["id", "title", "start_at", "end_at", "organizer_person_id", "google_event_id"],
      },
      {
        table: "crm_interactions",
        purpose: "Unified interaction log (email, meeting, etc.).",
        key_columns: ["id", "type", "occurred_at", "person_id", "company_id", "direction", "score_contribution"],
      },
      {
        table: "crm_commercial_opportunities",
        purpose: "Supply/demand commercial opportunities linked to companies.",
        key_columns: ["id", "company_id", "contact_person_id", "opportunity_type", "status", "title", "quantity", "soh"],
      },
      {
        table: "crm_objects",
        purpose: "Object-type registry (people, company, etc.).",
        key_columns: ["id", "name", "entity_table", "display_field"],
      },
      {
        table: "crm_fields",
        purpose: "Field definitions for objects, including canonical_column mapping.",
        key_columns: ["id", "object_id", "name", "type", "canonical_column"],
      },
    ],
    views: [
      {
        view: "crm_relation_links",
        purpose: "Read-only union of all relationship edges derived from junction tables and FK columns.",
        notes: "NOT a table — do not INSERT/UPDATE/DELETE into crm_relation_links. Writes go through the underlying junction tables or canonical FK columns.",
      },
    ],
    curated_tools: [
      "crm_schema_overview", "crm_get_company_profile", "crm_get_person_profile",
      "crm_search_companies", "crm_search_people",
      "crm_create_company", "crm_create_person", "crm_update_company", "crm_update_person",
    ],
    raw_sql_tools: ["crm_query (read-only SELECT)", "crm_tables (schema introspection)", "crm_execute (escape hatch for writes/DDL)"],
    caveats: [
      "Schema was cleaned: dropped tables (crm_custom_field_values, crm_saved_views, crm_object_view_settings, crm_statuses, crm_action_runs, crm_commercial_profiles) and the crm_company_commercial_summary_v view are absent.",
      "crm_relation_links is a VIEW, not a table.",
      "Curated create/update tools use hard field allowlists and parameterized SQL; id/created_at/updated_at are never writable through them.",
    ],
  };
}

async function crmGetCompanyProfile(args) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { error: "id is required." };
  const res = await runQuery(
    `select c.id, c.name, c.domain, c.website, c.phone, c.linkedin_url, c.country, c.city, c.notes, c.tags, c.created_at, c.updated_at,
       (select count(*)::int from crm_people p where p.company_id = c.id) as person_count
       from crm_companies c
      where c.id = $1
      limit 1`,
    [id],
  );
  const company = res.rows[0];
  if (!company) return { error: `Company not found: ${id}` };
  const peopleRes = await runQuery(
    `select id, full_name, email, job_title
       from crm_people
      where company_id = $1
      order by full_name nulls last
      limit 50`,
    [id],
  );
  return { company, people: peopleRes.rows, person_count: company.person_count };
}

async function crmGetPersonProfile(args) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { error: "id is required." };
  const res = await runQuery(
    `select p.id, p.full_name, p.first_name, p.last_name, p.email, p.company_id, p.phone, p.job_title, p.linkedin_url, p.tags, p.notes, p.email_opted_out, p.created_at, p.updated_at,
       c.name as company_name,
       c.domain as company_domain
       from crm_people p
       left join crm_companies c on c.id = p.company_id
      where p.id = $1
      limit 1`,
    [id],
  );
  const person = res.rows[0];
  if (!person) return { error: `Person not found: ${id}` };
  return { person };
}

function clampSearchLimit(limit) {
  const n = Math.floor(Number(limit) || 25);
  if (n < 1) return 1;
  if (n > SEARCH_HARD_LIMIT) return SEARCH_HARD_LIMIT;
  return n;
}

async function crmSearchCompanies(args) {
  const limit = clampSearchLimit(args.limit);
  const conditions = [];
  const params = [];
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query) {
    params.push(`%${query.toLowerCase()}%`);
    conditions.push(`(lower(name) like $${params.length} or lower(coalesce(domain, '')) like $${params.length})`);
  }
  if (typeof args.name === "string" && args.name.trim()) {
    params.push(`%${args.name.toLowerCase()}%`);
    conditions.push(`lower(name) like $${params.length}`);
  }
  if (typeof args.domain === "string" && args.domain.trim()) {
    params.push(`%${args.domain.toLowerCase()}%`);
    conditions.push(`lower(coalesce(domain, '')) like $${params.length}`);
  }
  if (typeof args.country === "string" && args.country.trim()) {
    params.push(`%${args.country.toLowerCase()}%`);
    conditions.push(`lower(coalesce(country, '')) like $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  params.push(limit);
  const res = await runQuery(
    `select id, name, domain, website, phone, country, city, linkedin_url, tags, created_at, updated_at
       from crm_companies
       ${where}
       order by name nulls last
       limit $${params.length}`,
    params,
  );
  return { companies: res.rows, count: res.rows.length, limit };
}

async function crmSearchPeople(args) {
  const limit = clampSearchLimit(args.limit);
  const conditions = [];
  const params = [];
  const query = typeof args.query === "string" ? args.query.trim() : "";
  if (query) {
    params.push(`%${query.toLowerCase()}%`);
    conditions.push(`(lower(coalesce(full_name, '')) like $${params.length} or lower(coalesce(email, '')) like $${params.length})`);
  }
  if (typeof args.name === "string" && args.name.trim()) {
    params.push(`%${args.name.toLowerCase()}%`);
    conditions.push(`lower(coalesce(full_name, '')) like $${params.length}`);
  }
  if (typeof args.email === "string" && args.email.trim()) {
    params.push(`%${args.email.toLowerCase()}%`);
    conditions.push(`lower(coalesce(email, '')) like $${params.length}`);
  }
  if (typeof args.job_title === "string" && args.job_title.trim()) {
    params.push(`%${args.job_title.toLowerCase()}%`);
    conditions.push(`lower(coalesce(job_title, '')) like $${params.length}`);
  }
  if (typeof args.company_id === "string" && args.company_id.trim()) {
    params.push(args.company_id.trim());
    conditions.push(`company_id = $${params.length}`);
  }
  const where = conditions.length ? `where ${conditions.join(" and ")}` : "";
  params.push(limit);
  const res = await runQuery(
    `select p.id, p.full_name, p.email, p.job_title, p.company_id, c.name as company_name, p.linkedin_url, p.tags, p.created_at, p.updated_at
       from crm_people p
       left join crm_companies c on c.id = p.company_id
       ${where}
       order by p.full_name nulls last
       limit $${params.length}`,
    params,
  );
  return { people: res.rows, count: res.rows.length, limit };
}

async function crmCreateCompany(args) {
  const validation = validateCompanyCreateFields(args.fields);
  if (!validation.ok) return { error: validation.error };
  const { sql, params, id } = buildInsertSql("crm_companies", validation.fields);
  const res = await runQuery(sql, params);
  const created = res.rows[0];
  if (!created) return { error: "Company was not created (no row returned)." };
  return { company: created, id, created: true };
}

async function crmCreatePerson(args) {
  const validation = validatePersonCreateFields(args.fields);
  if (!validation.ok) return { error: validation.error };
  const { sql, params, id } = buildInsertSql("crm_people", validation.fields);
  const res = await runQuery(sql, params);
  const created = res.rows[0];
  if (!created) return { error: "Person was not created (no row returned)." };
  return { person: created, id, created: true };
}

async function crmUpdateCompany(args) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { error: "id is required." };
  // Updates never require name/full_name — only non-empty allowlisted fields.
  const validation = validateCompanyFields(args.fields);
  if (!validation.ok) return { error: validation.error };
  const { sql, params } = buildUpdateSql("crm_companies", validation.fields, id);
  const res = await runQuery(sql, params);
  const updated = res.rows[0];
  if (!updated) return { error: `Company not found: ${id}` };
  return { company: updated, updated: true };
}

async function crmUpdatePerson(args) {
  const id = typeof args.id === "string" ? args.id.trim() : "";
  if (!id) return { error: "id is required." };
  // Updates never require name/full_name — only non-empty allowlisted fields.
  const validation = validatePersonFields(args.fields);
  if (!validation.ok) return { error: validation.error };
  const { sql, params } = buildUpdateSql("crm_people", validation.fields, id);
  const res = await runQuery(sql, params);
  const updated = res.rows[0];
  if (!updated) return { error: `Person not found: ${id}` };
  return { person: updated, updated: true };
}

export async function executeTool(name, args) {
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

    case "crm_schema_overview": {
      result = await crmSchemaOverview();
      break;
    }

    case "crm_get_company_profile": {
      result = await crmGetCompanyProfile(args);
      break;
    }

    case "crm_get_person_profile": {
      result = await crmGetPersonProfile(args);
      break;
    }

    case "crm_search_companies": {
      result = await crmSearchCompanies(args);
      break;
    }

    case "crm_search_people": {
      result = await crmSearchPeople(args);
      break;
    }

    case "crm_create_company": {
      result = await crmCreateCompany(args);
      break;
    }

    case "crm_create_person": {
      result = await crmCreatePerson(args);
      break;
    }

    case "crm_update_company": {
      result = await crmUpdateCompany(args);
      break;
    }

    case "crm_update_person": {
      result = await crmUpdatePerson(args);
      break;
    }

    case "crm_query": {
      const sql = typeof args.sql === "string" ? args.sql.trim() : "";
      if (!sql) {
        result = { error: "sql is required." };
        break;
      }
      if (!/^select\b/i.test(sql)) {
        result = { error: "crm_query only supports SELECT statements. Use crm_execute for mutations." };
        break;
      }
      // Reject multi-statement input: a trailing semicolon is allowed, but a
      // semicolon followed by more SQL is not. This prevents statement stacking.
      const withoutTrailingSemicolon = sql.replace(/;\s*$/, "");
      if (/;\s*\S/.test(withoutTrailingSemicolon)) {
        result = { error: "crm_query rejects multi-statement input. Provide a single SELECT statement." };
        break;
      }
      if (referencesUserScopedData(withoutTrailingSemicolon)) {
        result = {
          error: "Raw MCP SQL access to user-scoped CRM data is disabled.",
        };
        break;
      }
      const limit = Math.min(args.limit || 100, 1000);
      const params = Array.isArray(args.params) ? args.params : [];
      // For simple SELECTs without a LIMIT clause, push LIMIT into SQL so the
      // DB does the capping. Fall back to client-side slicing if we can't.
      const hasLimit = /\blimit\b/i.test(withoutTrailingSemicolon);
      const finalSql = hasLimit ? withoutTrailingSemicolon : `${withoutTrailingSemicolon} limit ${limit}`;
      const res = await runQuery(finalSql, params);
      const rows = res.rows.slice(0, limit);
      result = { rows, count: rows.length, truncated: res.rows.length > limit };
      break;
    }

    case "crm_execute": {
      const sql = typeof args.sql === "string" ? args.sql.trim() : "";
      if (!sql) {
        result = { error: "sql is required." };
        break;
      }
      if (referencesUserScopedData(sql)) {
        result = {
          error: "Raw MCP SQL access to user-scoped CRM data is disabled.",
        };
        break;
      }
      const params = Array.isArray(args.params) ? args.params : [];
      const res = await runQuery(sql, params);
      result = { command: res.command, rowCount: res.rowCount, oid: res.oid };
      break;
    }

    case "crm_tables": {
      const tableFilter = typeof args.table === "string" && args.table.trim() ? args.table.trim() : null;
      const client = await resolvePgPool().connect();
      try {
        const tablesQuery = tableFilter
          ? `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = $1 ORDER BY tablename`
          : `SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
        const tablesRes = await client.query(tablesQuery, tableFilter ? [tableFilter] : []);
        const tables = [];
        for (const t of tablesRes.rows) {
          const tableName = t.tablename;
          const [colsRes, countRes, pkRes, fkRes] = await Promise.all([
            client.query(`
              SELECT column_name, data_type, is_nullable, column_default
              FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1
              ORDER BY ordinal_position
            `, [tableName]),
            client.query(`SELECT count(*)::int AS count FROM "${tableName}"`),
            client.query(`
              SELECT a.attname AS column_name
              FROM pg_index i
              JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
              WHERE i.indrelid = $1::regclass AND i.indisprimary
            `, [`public.${tableName}`]),
            client.query(`
              SELECT
                kcu.column_name,
                ccu.table_name AS foreign_table,
                ccu.column_name AS foreign_column
              FROM information_schema.table_constraints tc
              JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
              JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
              WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_name = $1
            `, [tableName]),
          ]);
          tables.push({
            table: tableName,
            row_count: countRes.rows[0].count,
            columns: colsRes.rows.map(c => ({
              name: c.column_name,
              type: c.data_type,
              nullable: c.is_nullable === "YES",
              default: c.column_default,
            })),
            primary_key: pkRes.rows.map(r => r.column_name),
            foreign_keys: fkRes.rows.map(r => ({ column: r.column_name, references: `${r.foreign_table}.${r.foreign_column}` })),
          });
        }
        result = { tables };
      } finally {
        client.release();
      }
      break;
    }

    case "crm_enrichment_query": {
      const domain = typeof args.domain === "string" ? args.domain.trim() : "";
      if (!domain) {
        result = { error: "domain is required." };
        break;
      }
      const rows = await queryPgEnrichment(
        "select * from public.crm_company_enrichments where lower(domain) = lower($1) limit 1",
        [domain],
      );
      if (rows.length === 0) {
        result = { found: false };
      } else {
        result = rows[0];
      }
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

export async function handleRequest(request) {
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

// Only start the stdio server when invoked as the main entry point.
// This allows tests to import the module without triggering process.exit
// or readline stdio binding.
export function startServer() {
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

  return rl;
}

// Detect whether this module is the main entry point so the stdio server only
// autostarts when run directly (e.g. `node denchclaw-mcp-server.mjs` or
// `node apps/web/lib/denchclaw-mcp-server.mjs`). Resolves relative argv paths
// against cwd so launching via a relative path still autostarts.
export function isMainEntry(argv1, moduleUrl, cwd = process.cwd()) {
  if (!argv1) return false;
  try {
    const modulePath = fileURLToPath(moduleUrl);
    const argvPath = isAbsolute(argv1) ? argv1 : resolve(cwd, argv1);
    return argvPath === modulePath;
  } catch {
    return false;
  }
}

const isMain = isMainEntry(process.argv[1], import.meta.url);

if (isMain) {
  startServer();
}
