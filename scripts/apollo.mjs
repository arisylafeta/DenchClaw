#!/usr/bin/env node

/**
 * Apollo.io CLI — Sales intelligence & people/company enrichment
 *
 * Reads APOLLO_API_KEY from environment.
 * Base URL: https://api.apollo.io/api/v1
 * Auth: X-Api-Key header
 *
 * Usage:
 *   APOLLO_API_KEY=xxx node apollo.mjs <command> [args] [options]
 *
 * Commands:
 *   people-search [filters]           Search people (POST /mixed_people/search)
 *   person-enrich <email|linkedin>    Enrich a person (POST /people/match)
 *   company-enrich <domain>           Enrich a company (POST /organizations/enrich)
 *   company-search [filters]         Search companies (POST /mixed_companies/search)
 *   job-postings <organization_id>   Get job postings (GET /organizations/{id}/job_postings)
 *   usage                             Get API usage stats
 *
 * Options:
 *   --raw          Output raw JSON (no pretty print)
 *   --page=N       Page number (default: 1)
 *   --per-page=N   Results per page (default: 25)
 *   --help         Show this help message
 *
 * Environment:
 *   APOLLO_API_KEY   Required. Your Apollo API key.
 */

const BASE_URL = "https://api.apollo.io/api/v1";

function getApiKey() {
  const key = process.env.APOLLO_API_KEY?.trim();
  if (!key) {
    console.error("Error: APOLLO_API_KEY environment variable is required.");
    console.error("Get your key at: https://app.apollo.io/settings/integrations/api");
    process.exit(1);
  }
  return key;
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, ...valueParts] = arg.slice(2).split("=");
      const value = valueParts.join("=");
      flags[key] = value || true;
    } else {
      positional.push(arg);
    }
  }
  return { flags, positional };
}

async function apolloRequest(path, { method = "GET", body, params } = {}) {
  const apiKey = getApiKey();
  const url = new URL(`${BASE_URL}${path}`);

  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        url.searchParams.set(key, String(value));
      }
    }
  }

  const options = {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
  };

  if (body && method !== "GET") {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url.toString(), options);
  const text = await response.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    const errorMsg =
      typeof data === "object" && data?.message
        ? data.message
        : typeof data === "object" && data?.error
          ? data.error
          : `HTTP ${response.status}`;
    console.error(`Error: ${errorMsg}`);
    if (typeof data === "object" && data?.details) {
      console.error(JSON.stringify(data.details, null, 2));
    }
    process.exit(1);
  }

  return data;
}

function output(data, raw) {
  if (raw) {
    console.log(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

function printHelp() {
  console.log(`Apollo.io CLI — Sales intelligence & people/company enrichment

Usage:
  APOLLO_API_KEY=xxx node apollo.mjs <command> [args] [options]

Commands:
  people-search [filters]           Search people (POST /mixed_people/search)
    Filters (key=value pairs):
      titles=VP,Director             Job titles (comma-separated)
      locations=London,UK           Person locations (comma-separated)
      org-domains=tesla.com         Organization domains (comma-separated)
      keywords=battery              Keyword search
      seniority=vp,c_level           Seniority levels
      departments=engineering        Departments
      per-page=25                    Results per page
      page=1                         Page number

  person-enrich <email|linkedin>    Enrich a person (POST /people/match)
    Provide an email or LinkedIn URL.

  company-enrich <domain>           Enrich a company (POST /organizations/enrich)

  company-search [filters]          Search companies (POST /mixed_companies/search)
    Filters (key=value pairs):
      locations=USA                  Company locations (comma-separated)
      keywords=battery               Keyword search
      revenue-min=1000000            Min revenue
      employees-min=100              Min employee count
      per-page=25                    Results per page
      page=1                         Page number

  job-postings <organization_id>    Get job postings (GET /organizations/{id}/job_postings)

  usage                             Get API usage stats

Options:
  --raw          Output raw JSON (no pretty print)
  --help         Show this help message

Environment:
  APOLLO_API_KEY   Required. Your Apollo API key.
                   Get it at: https://app.apollo.io/settings/integrations/api
`);
}

// --- Commands ---

async function cmdPeopleSearch(positional, flags) {
  // Parse key=value pairs from positional args as filters
  const filters = {};
  for (const arg of positional) {
    const [key, ...valueParts] = arg.split("=");
    const value = valueParts.join("=");
    if (key && value) {
      filters[key] = value;
    }
  }

  const body = {
    page: parseInt(flags.page || "1", 10),
    per_page: parseInt(flags["per-page"] || "25", 10),
  };

  if (filters.titles) body.person_titles = filters.titles.split(",");
  if (filters.locations) body.person_locations = filters.locations.split(",");
  if (filters["org-domains"]) body.q_organization_domains = filters["org-domains"].split(",");
  if (filters.keywords) body.q_keywords = filters.keywords;
  if (filters.seniority) body.person_seniorities = filters.seniority.split(",");
  if (filters.departments) body.q_person_department = filters.departments.split(",");

  const data = await apolloRequest("/mixed_people/search", { method: "POST", body });
  output(data, flags.raw);
}

async function cmdPersonEnrich(positional, flags) {
  const identifier = positional[0];
  if (!identifier) {
    console.error("Error: person-enrich requires an email or LinkedIn URL.");
    process.exit(1);
  }

  const body = {};
  if (identifier.includes("@")) {
    body.email = identifier;
  } else if (identifier.includes("linkedin.com")) {
    body.linkedin_url = identifier;
  } else {
    console.error("Error: provide a valid email or LinkedIn URL.");
    process.exit(1);
  }

  const data = await apolloRequest("/people/match", { method: "POST", body });
  output(data, flags.raw);
}

async function cmdCompanyEnrich(positional, flags) {
  const domain = positional[0];
  if (!domain) {
    console.error("Error: company-enrich requires a domain (e.g. tesla.com).");
    process.exit(1);
  }

  const body = { domain };
  const data = await apolloRequest("/organizations/enrich", { method: "POST", body });
  output(data, flags.raw);
}

async function cmdCompanySearch(positional, flags) {
  const filters = {};
  for (const arg of positional) {
    const [key, ...valueParts] = arg.split("=");
    const value = valueParts.join("=");
    if (key && value) {
      filters[key] = value;
    }
  }

  const body = {
    page: parseInt(flags.page || "1", 10),
    per_page: parseInt(flags["per-page"] || "25", 10),
  };

  if (filters.locations) body.organization_locations = filters.locations.split(",");
  if (filters.keywords) body.q_organization_keyword_tags = filters.keywords.split(",");
  if (filters["revenue-min"]) body.revenue_range = { min: parseInt(filters["revenue-min"], 10) };
  if (filters["employees-min"]) {
    body.organization_num_employees_ranges = [`${filters["employees-min"]},`];
  }

  const data = await apolloRequest("/mixed_companies/search", { method: "POST", body });
  output(data, flags.raw);
}

async function cmdJobPostings(positional, flags) {
  const orgId = positional[0];
  if (!orgId) {
    console.error("Error: job-postings requires an organization ID.");
    process.exit(1);
  }

  const params = {
    page: parseInt(flags.page || "1", 10),
    per_page: parseInt(flags["per-page"] || "25", 10),
  };

  const data = await apolloRequest(`/organizations/${orgId}/job_postings`, { params });
  output(data, flags.raw);
}

async function cmdUsage(flags) {
  const data = await apolloRequest("/auth/health");
  output(data, flags.raw);
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const { flags, positional } = parseFlags(args);

  if (flags.help || positional.length === 0) {
    printHelp();
    process.exit(0);
  }

  const command = positional[0];
  const rest = positional.slice(1);

  try {
    switch (command) {
      case "people-search":
        await cmdPeopleSearch(rest, flags);
        break;
      case "person-enrich":
        await cmdPersonEnrich(rest, flags);
        break;
      case "company-enrich":
        await cmdCompanyEnrich(rest, flags);
        break;
      case "company-search":
        await cmdCompanySearch(rest, flags);
        break;
      case "job-postings":
        await cmdJobPostings(rest, flags);
        break;
      case "usage":
        await cmdUsage(flags);
        break;
      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run with --help for usage.");
        process.exit(1);
    }
  } catch (err) {
    if (err.message?.includes("fetch failed") || err.cause?.code === "ECONNREFUSED") {
      console.error("Network error: could not reach Apollo API.");
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

main();
