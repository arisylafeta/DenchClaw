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

// extensions/apollo-enrichment/index.ts
var id = "apollo-enrichment";
var ENRICHMENT_BASE_PATH = "/v1/enrichment";
var APOLLO_ACTIONS = ["people", "company", "people_search"];
var PEOPLE_DEFAULT_REQUIRED_FIELDS = [
  "fullName",
  "email",
  "headline",
  "linkedinID",
  "URLs",
  "phone",
  "location"
];
var COMPANY_DEFAULT_REQUIRED_FIELDS = [
  "name",
  "website",
  "industryList",
  "linkedinID",
  "totalFunding",
  "founded"
];
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
var ApolloEnrichParameters = {
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [...APOLLO_ACTIONS],
      description: 'Action to perform: "people", "company", or "people_search".'
    },
    email: { type: "string", description: "Email for people enrichment." },
    linkedinUrl: { type: "string", description: "LinkedIn URL for people enrichment." },
    firstName: { type: "string", description: "Person first name." },
    lastName: { type: "string", description: "Person last name." },
    domain: { type: "string", description: "Company domain such as acme.com." },
    organizationName: {
      type: "string",
      description: "Organization name hint for people enrichment."
    },
    personTitles: {
      type: "array",
      items: { type: "string" },
      description: "Job titles for people search."
    },
    personLocations: {
      type: "array",
      items: { type: "string" },
      description: "Locations for people search."
    },
    organizationDomains: {
      type: "array",
      items: { type: "string" },
      description: "Organization domains for people search."
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
      description: "Legacy alias for personTitles."
    },
    person_locations: {
      type: "array",
      items: { type: "string" },
      description: "Legacy alias for personLocations."
    },
    organization_domains: {
      type: "array",
      items: { type: "string" },
      description: "Legacy alias for organizationDomains."
    },
    per_page: { type: "number", description: "Legacy alias for perPage." },
    requiredFields: {
      type: "array",
      items: { type: "string" },
      description: "Optional Dench gateway requiredFields contract. The waterfall stops as soon as every listed field is non-null on the merged record. Omit to use the canonical default for the action (people: name/email/headline/linkedin/URLs/phone/location; company: name/website/industry/linkedin/funding/founded). Never omit just to opt out \u2014 the gateway's no-list path is deprecated and Apollo rejects it."
    },
    required_fields: {
      type: "array",
      items: { type: "string" },
      description: "Legacy alias for requiredFields."
    }
  },
  required: ["action"]
};
function buildPeopleBody(params) {
  const body = {};
  const email = readTrimmedString(params.email);
  const linkedinUrl = readTrimmedString(params.linkedinUrl) ?? readTrimmedString(params.linkedin_url);
  const firstName = readTrimmedString(params.firstName) ?? readTrimmedString(params.first_name);
  const lastName = readTrimmedString(params.lastName) ?? readTrimmedString(params.last_name);
  const domain = readTrimmedString(params.domain);
  const organizationName = readTrimmedString(params.organizationName) ?? readTrimmedString(params.organization_name);
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
function buildPeopleSearchBody(params) {
  const body = {};
  const personTitles = readStringList(params.personTitles) ?? readStringList(params.person_titles);
  const personLocations = readStringList(params.personLocations) ?? readStringList(params.person_locations);
  const organizationDomains = readStringList(params.organizationDomains) ?? readStringList(params.organization_domains);
  const page = typeof params.page === "number" ? params.page : void 0;
  const perPage = typeof params.perPage === "number" ? params.perPage : typeof params.per_page === "number" ? params.per_page : void 0;
  if (personTitles) {
    body.person_titles = personTitles;
  }
  if (personLocations) {
    body.person_locations = personLocations;
  }
  if (organizationDomains) {
    body.organization_domains = organizationDomains;
  }
  if (page !== void 0) {
    body.page = page;
  }
  if (perPage !== void 0) {
    body.per_page = perPage;
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
async function executeApolloEnrich(gatewayUrl, apiKey, _toolCallId, params) {
  const action = params.action;
  if (action !== "people" && action !== "company" && action !== "people_search") {
    return jsonResult({
      error: `Unknown action "${String(action)}". Use "people", "company", or "people_search".`
    });
  }
  try {
    let response;
    const callerRequiredFields = readStringList(params.requiredFields) ?? readStringList(params.required_fields);
    if (action === "people") {
      const body = buildPeopleBody(params);
      body.requiredFields = callerRequiredFields ?? PEOPLE_DEFAULT_REQUIRED_FIELDS;
      if (!body.email && !body.linkedin_url && !body.first_name && !body.last_name) {
        return jsonResult({
          error: "People enrichment requires at least an email, LinkedIn URL, or person name."
        });
      }
      response = await fetch(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/people`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
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
          authorization: `Bearer ${apiKey}`
        }
      });
    } else {
      const body = buildPeopleSearchBody(params);
      response = await fetch(`${gatewayUrl}${ENRICHMENT_BASE_PATH}/people/search`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`
        },
        body: JSON.stringify(body)
      });
    }
    if (!response.ok) {
      const detail = await parseResponse(response).catch(() => "");
      return jsonResult({
        error: `Enrichment request failed (HTTP ${response.status}).`,
        detail: detail || void 0
      });
    }
    return jsonResult(await parseResponse(response));
  } catch (err) {
    return jsonResult({
      error: "Enrichment request failed.",
      detail: err instanceof Error ? err.message : String(err)
    });
  }
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
    api.logger?.info?.(
      "[apollo-enrichment] No Dench Cloud API key found; tool will not be registered."
    );
    return;
  }
  api.registerTool({
    name: "apollo_enrich",
    label: "Apollo Enrichment",
    description: `Look up Apollo people, companies, or people search results through the Dench Cloud gateway. Use action "people" for an individual profile, "company" for company enrichment by domain, or "people_search" to search people with filters such as titles, locations, and company domains. For people and company, the tool always sends gateway requiredFields (defaults when omitted) so Apollo's removed mode field is never used. Prefer this tool over integration execute tools for the same structured enrichment from chat.`,
    parameters: ApolloEnrichParameters,
    execute: (toolCallId, params) => executeApolloEnrich(gatewayUrl, apiKey, toolCallId, params)
  });
}
export {
  register as default,
  id
};
