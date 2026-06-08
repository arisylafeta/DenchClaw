import type { AnyAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk";
import {
  readDenchAuthProfileKey,
  resolveDenchGatewayUrl,
} from "../shared/dench-auth.js";

export const id = "apollo-enrichment";

const ENRICHMENT_BASE_PATH = "/v1/enrichment";
const APOLLO_ACTIONS = ["people", "company", "people_search"] as const;

/**
 * Canonical `requiredFields` lists for each enrichment action.
 *
 * Why these exist: the Dench Cloud gateway's "default backfill" path —
 * the one taken when the caller sends no `requiredFields` — was wired to
 * Apollo's now-removed `mode` field. Apollo returns
 * `{ code: "deprecated_field", message: "The mode field has been removed.
 * Use requiredFields to control which fields the waterfall must populate." }`,
 * which surfaces in chat as "Apollo hit an API issue." The column-based
 * enrichment route never hits this because it derives `requiredFields`
 * from the matched column. The chat tool used to leave the parameter
 * optional with a description telling the agent it could omit. The agent
 * naturally omitted, the gateway took its broken default-backfill path,
 * Apollo rejected it.
 *
 * The fix: when the caller omits `requiredFields`, the plugin substitutes
 * the canonical list below. This mirrors the columns defined in
 * `apps/web/lib/enrichment-columns.ts` (the union of every column's
 * `requiredFields`), which the column-enrichment route already exercises
 * in production and which is on the gateway allowlist. Callers can still
 * override with their own list.
 */
const PEOPLE_DEFAULT_REQUIRED_FIELDS = [
  "fullName",
  "email",
  "headline",
  "linkedinID",
  "URLs",
  "phone",
  "location",
];

const COMPANY_DEFAULT_REQUIRED_FIELDS = [
  "name",
  "website",
  "industryList",
  "linkedinID",
  "totalFunding",
  "founded",
];

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
  return value && typeof value === "object" ? (value as UnknownRecord) : undefined;
}

function readTrimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readStringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value
    .map((item) => readTrimmedString(item))
    .filter((item): item is string => Boolean(item));
  return items.length > 0 ? items : undefined;
}

function jsonResult(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    details: payload,
  };
}

const ApolloEnrichParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [...APOLLO_ACTIONS],
      description: 'Action to perform: "people", "company", or "people_search".',
    },
    email: { type: "string", description: "Email for people enrichment." },
    linkedinUrl: { type: "string", description: "LinkedIn URL for people enrichment." },
    firstName: { type: "string", description: "Person first name." },
    lastName: { type: "string", description: "Person last name." },
    domain: { type: "string", description: "Company domain such as acme.com." },
    organizationName: {
      type: "string",
      description: "Organization name hint for people enrichment.",
    },
    personTitles: {
      type: "array",
      items: { type: "string" },
      description: "Job titles for people search.",
    },
    personLocations: {
      type: "array",
      items: { type: "string" },
      description: "Locations for people search.",
    },
    organizationDomains: {
      type: "array",
      items: { type: "string" },
      description: "Organization domains for people search.",
    },
    page: { type: "number", description: "People search page number." },
    perPage: { type: "number", description: "People search page size." },
    first_name: { type: "string", description: "Legacy alias for firstName." },
    last_name: { type: "string", description: "Legacy alias for lastName." },
    organization_name: { type: "string", description: "Legacy alias for organizationName." },
    linkedin_url: { type: "string", description: "Legacy alias for linkedinUrl." },
    person_titles: {
      type: "array",
      items: { type: "string" },
      description: "Legacy alias for personTitles.",
    },
    person_locations: {
      type: "array",
      items: { type: "string" },
      description: "Legacy alias for personLocations.",
    },
    organization_domains: {
      type: "array",
      items: { type: "string" },
      description: "Legacy alias for organizationDomains.",
    },
    per_page: { type: "number", description: "Legacy alias for perPage." },
    requiredFields: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional Dench gateway requiredFields contract. The waterfall stops as soon as every listed field is non-null on the merged record. Omit to use the canonical default for the action (people: name/email/headline/linkedin/URLs/phone/location; company: name/website/industry/linkedin/funding/founded). Never omit just to opt out — the gateway's no-list path is deprecated and Apollo rejects it.",
    },
    required_fields: {
      type: "array",
      items: { type: "string" },
      description: "Legacy alias for requiredFields.",
    },
  },
  required: ["action"],
};

function buildPeopleBody(params: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  const email = readTrimmedString(params.email);
  const linkedinUrl =
    readTrimmedString(params.linkedinUrl) ?? readTrimmedString(params.linkedin_url);
  const firstName = readTrimmedString(params.firstName) ?? readTrimmedString(params.first_name);
  const lastName = readTrimmedString(params.lastName) ?? readTrimmedString(params.last_name);
  const domain = readTrimmedString(params.domain);
  const organizationName =
    readTrimmedString(params.organizationName) ?? readTrimmedString(params.organization_name);

  if (email) {
    body.email = email;
  }
  if (linkedinUrl) {
    body.linkedin_url = linkedinUrl;
  }
  if (firstName) {
    body.first_name = firstName;
  }
  if (lastName) {
    body.last_name = lastName;
  }
  if (domain) {
    body.domain = domain;
  }
  if (organizationName) {
    body.organization_name = organizationName;
  }

  return body;
}

function buildPeopleSearchBody(params: Record<string, unknown>) {
  const body: Record<string, unknown> = {};
  const personTitles = readStringList(params.personTitles) ?? readStringList(params.person_titles);
  const personLocations =
    readStringList(params.personLocations) ?? readStringList(params.person_locations);
  const organizationDomains =
    readStringList(params.organizationDomains) ?? readStringList(params.organization_domains);
  const page = typeof params.page === "number" ? params.page : undefined;
  const perPage =
    typeof params.perPage === "number"
      ? params.perPage
      : typeof params.per_page === "number"
        ? params.per_page
        : undefined;

  if (personTitles) {
    body.person_titles = personTitles;
  }
  if (personLocations) {
    body.person_locations = personLocations;
  }
  if (organizationDomains) {
    body.organization_domains = organizationDomains;
  }
  if (page !== undefined) {
    body.page = page;
  }
  if (perPage !== undefined) {
    body.per_page = perPage;
  }

  return body;
}

async function parseResponse(response: Response) {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
}

async function executeApolloEnrich(
  gatewayUrl: string,
  apiKey: string,
  _toolCallId: string,
  params: Record<string, unknown>,
) {
  const action = params.action;
  if (action !== "people" && action !== "company" && action !== "people_search") {
    return jsonResult({
      error: `Unknown action "${String(action)}". Use "people", "company", or "people_search".`,
    });
  }

  try {
    let response: Response;
    // Caller-supplied requiredFields wins. When omitted, fall back to the
    // canonical allowlist for the action so the gateway never takes its
    // deprecated default-backfill path (which Apollo rejects with the
    // "mode field has been removed" 400). people_search uses a different
    // endpoint that does not accept requiredFields, so leave it alone.
    const callerRequiredFields =
      readStringList(params.requiredFields) ?? readStringList(params.required_fields);

    if (action === "people") {
      const body = buildPeopleBody(params);
      body.requiredFields = callerRequiredFields ?? PEOPLE_DEFAULT_REQUIRED_FIELDS;
      if (!body.email && !body.linkedin_url && !body.first_name && !body.last_name) {
        return jsonResult({
          error: "People enrichment requires at least an email, LinkedIn URL, or person name.",
        });
      }
      response = await fetch(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/people`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    } else if (action === "company") {
      const domain = readTrimmedString(params.domain);
      if (!domain) {
        return jsonResult({ error: "Company enrichment requires a domain." });
      }
      const url = new URL(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/company`);
      url.searchParams.set("domain", domain);
      const companyRequiredFields = callerRequiredFields ?? COMPANY_DEFAULT_REQUIRED_FIELDS;
      url.searchParams.set("requiredFields", companyRequiredFields.join(","));
      response = await fetch(url, {
        method: "GET",
        headers: {
          authorization: `Bearer ${apiKey}`,
        },
      });
    } else {
      const body = buildPeopleSearchBody(params);
      response = await fetch(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/people/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });
    }

    if (!response.ok) {
      const detail = await parseResponse(response).catch(() => "");
      return jsonResult({
        error: `Enrichment request failed (HTTP ${response.status}).`,
        detail: detail || undefined,
      });
    }

    return jsonResult(await parseResponse(response));
  } catch (err) {
    return jsonResult({
      error: "Enrichment request failed.",
      detail: err instanceof Error ? err.message : String(err),
    });
  }
}

export default function register(api: OpenClawPluginApi) {
  const rootConfig = asRecord(api.config);
  const pluginEntries = asRecord(asRecord(rootConfig?.plugins)?.entries);
  const pluginConfig = asRecord(asRecord(pluginEntries?.[id])?.config);
  if (pluginConfig?.enabled === false) {
    return;
  }

  const gwPluginConfig = asRecord(asRecord(pluginEntries?.["dench-ai-gateway"])?.config);
  const gatewayUrl = resolveDenchGatewayUrl(gwPluginConfig as Record<string, unknown> | undefined);
  const apiKey = readDenchAuthProfileKey();

  if (!apiKey) {
    api.logger?.info?.(
      "[apollo-enrichment] No Dench Cloud API key found; tool will not be registered.",
    );
    return;
  }

  api.registerTool({
    name: "apollo_enrich",
    label: "Apollo Enrichment",
    description:
      "Look up Apollo people, companies, or people search results through the Dench Cloud gateway. " +
      'Use action "people" for an individual profile, "company" for company enrichment by domain, ' +
      'or "people_search" to search people with filters such as titles, locations, and company domains. ' +
      "For people and company, the tool always sends gateway requiredFields (defaults when omitted) so Apollo's removed mode field is never used. " +
      "Prefer this tool over integration execute tools for the same structured enrichment from chat.",
    parameters: ApolloEnrichParameters,
    execute: (toolCallId: string, params: Record<string, unknown>) =>
      executeApolloEnrich(gatewayUrl, apiKey, toolCallId, params),
  } as AnyAgentTool);
}
