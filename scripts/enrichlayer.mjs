#!/usr/bin/env node
/**
 * enrichlayer.mjs
 *
 * Standalone CLI for the EnrichLayer data enrichment API.
 *
 * Usage:
 *   ENRICH_LAYER_API_KEY=xxx node scripts/enrichlayer.mjs <command> [args] [options]
 *
 * No external dependencies required — uses Node.js built-in `fetch`.
 */

const API_BASE_URL = "https://enrichlayer.com/api/v2";
const API_KEY = process.env.ENRICH_LAYER_API_KEY;

/**
 * Print usage information for all supported commands and options.
 */
function printUsage() {
  console.log(`
EnrichLayer CLI — Usage:

  ENRICH_LAYER_API_KEY=xxx node scripts/enrichlayer.mjs <command> [args] [options]

People API
  person <linkedin_url>                         Enrich a person profile
  person-lookup <first_name> <last_name> <company>  Find person by name + company
  role <company_url> <role>                     Find person by role at company
  person-picture <linkedin_url>                 Get profile picture

Company API
  company <linkedin_url>                        Enrich a company
  company-lookup <name_or_domain>               Find company by name or domain
  company-id <id>                               Lookup company by numeric ID
  employees <linkedin_url>                      List employees
  employee-count <linkedin_url>                 Get employee count
  employee-search <linkedin_url> <title>        Search employees by title

Contact API
  work-email <linkedin_url>                     Find work email
  personal-email <linkedin_url>                 Find personal emails
  personal-contact <linkedin_url>               Find personal phone number
  reverse-email <email>                         Reverse email lookup
  reverse-phone <phone>                         Reverse phone lookup
  disposable <email>                            Check if email is disposable

Search API
  search-person <query>                         Search people
  search-company <query>                        Search companies

Jobs API
  job <job_url>                                 Get job profile
  job-search <company_url>                      Search jobs at company
  job-count <company_url>                       Count jobs at company

Meta API
  credits                                       Check credit balance

Options
  --raw                  Output compact/raw JSON
  --use-cache            Request cached result
  --fallback-to-cache    Allow fallback to cached result
  --live-fetch           Force live fetch
  --extra=include        Include extra fields
  --skills=include       Include skills
  --start=N              Pagination start (employees)
  --count=N              Pagination count (employees)
`.trim());
}

/**
 * Append the common optional query parameters (`use_cache`, `fallback_to_cache`,
 * `live_fetch`, `extra`, `skills`) to a URLSearchParams object.
 */
function appendCommonParams(searchParams, options) {
  if (options.useCache !== undefined) {
    searchParams.set("use_cache", String(options.useCache));
  }
  if (options.fallbackToCache !== undefined) {
    searchParams.set("fallback_to_cache", String(options.fallbackToCache));
  }
  if (options.liveFetch !== undefined) {
    searchParams.set("live_fetch", String(options.liveFetch));
  }
  if (options.extra !== undefined) {
    searchParams.set("extra", options.extra);
  }
  if (options.skills !== undefined) {
    searchParams.set("skills", options.skills);
  }
}

/**
 * Build a full API URL from a path and required/optional query parameters.
 */
function buildUrl(path, requiredParams = {}, options = {}) {
  const searchParams = new URLSearchParams();

  for (const [key, value] of Object.entries(requiredParams)) {
    if (value !== undefined && value !== null && value !== "") {
      searchParams.set(key, value);
    }
  }

  appendCommonParams(searchParams, options);

  const query = searchParams.toString();
  return query ? `${API_BASE_URL}${path}?${query}` : `${API_BASE_URL}${path}`;
}

/**
 * Execute an authenticated GET request against the EnrichLayer API and return
 * the parsed JSON body.
 */
async function apiGet(path, requiredParams = {}, options = {}) {
  const url = buildUrl(path, requiredParams, options);

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      Accept: "application/json",
    },
  });

  let body;
  const contentType = response.headers.get("content-type") || "";

  try {
    if (contentType.includes("application/json")) {
      body = await response.json();
    } else {
      const text = await response.text();
      body = text ? { message: text } : {};
    }
  } catch (err) {
    body = { message: "Unable to parse API response" };
  }

  if (!response.ok) {
    const message =
      body?.message || body?.error || body?.detail || JSON.stringify(body);
    throw new Error(`API error ${response.status}: ${message}`);
  }

  return body;
}

/**
 * Print data to stdout as JSON, respecting the --raw flag.
 */
function printData(data, raw = false) {
  const output = raw ? JSON.stringify(data) : JSON.stringify(data, null, 2);
  console.log(output);
}

/**
 * Parse CLI arguments into { command, positional, options }.
 * Supports flags both before and after positional arguments.
 */
function parseArgs(argv) {
  const options = {
    raw: false,
    useCache: undefined,
    fallbackToCache: undefined,
    liveFetch: undefined,
    extra: undefined,
    skills: undefined,
    start: undefined,
    count: undefined,
  };
  const positional = [];

  function parseBooleanValue(str) {
    const lower = str.toLowerCase();
    if (["true", "1", "yes"].includes(lower)) return true;
    if (["false", "0", "no"].includes(lower)) return false;
    return true; // flag presence defaults to true
  }

  function parseFlag(arg) {
    if (arg === "--raw") {
      options.raw = true;
      return true;
    }

    if (arg === "--use-cache") {
      options.useCache = true;
      return true;
    }
    if (arg.startsWith("--use-cache=")) {
      options.useCache = parseBooleanValue(arg.slice("--use-cache=".length));
      return true;
    }

    if (arg === "--fallback-to-cache") {
      options.fallbackToCache = true;
      return true;
    }
    if (arg.startsWith("--fallback-to-cache=")) {
      options.fallbackToCache = parseBooleanValue(
        arg.slice("--fallback-to-cache=".length)
      );
      return true;
    }

    if (arg === "--live-fetch") {
      options.liveFetch = true;
      return true;
    }
    if (arg.startsWith("--live-fetch=")) {
      options.liveFetch = parseBooleanValue(arg.slice("--live-fetch=".length));
      return true;
    }

    if (arg === "--extra") {
      options.extra = "include";
      return true;
    }
    if (arg.startsWith("--extra=")) {
      options.extra = arg.slice("--extra=".length);
      return true;
    }

    if (arg === "--skills") {
      options.skills = "include";
      return true;
    }
    if (arg.startsWith("--skills=")) {
      options.skills = arg.slice("--skills=".length);
      return true;
    }

    if (arg.startsWith("--start=")) {
      options.start = arg.slice("--start=".length);
      return true;
    }

    if (arg.startsWith("--count=")) {
      options.count = arg.slice("--count=".length);
      return true;
    }

    return false;
  }

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (!parseFlag(arg)) {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    args: positional.slice(1),
    options,
  };
}

/**
 * Ensure the expected number of positional arguments was provided.
 */
function expectArgs(commandArgs, min, max = min) {
  const count = commandArgs.length;
  if (count < min || count > max) {
    console.error(
      `Error: command expects ${min === max ? min : `${min}-${max}`} argument(s), got ${count}.`
    );
    printUsage();
    process.exit(1);
  }
}

/**
 * Main command dispatcher.
 */
async function main() {
  const { command, args, options } = parseArgs(process.argv.slice(2));

  if (!command) {
    printUsage();
    process.exit(0);
  }

  if (!API_KEY) {
    console.error("Error: ENRICH_LAYER_API_KEY environment variable is required.");
    process.exit(1);
  }

  let data;

  switch (command) {
    // People API
    case "person": {
      expectArgs(args, 1);
      data = await apiGet("/profile", { profile_url: args[0] }, options);
      break;
    }

    case "person-lookup": {
      expectArgs(args, 3);
      data = await apiGet(
        "/profile/resolve",
        {
          first_name: args[0],
          last_name: args[1],
          company_name: args[2],
        },
        options
      );
      break;
    }

    case "role": {
      expectArgs(args, 2);
      data = await apiGet(
        "/find/company/role",
        { company_url: args[0], role: args[1] },
        options
      );
      break;
    }

    case "person-picture": {
      expectArgs(args, 1);
      data = await apiGet(
        "/person/profile-picture",
        { profile_url: args[0] },
        options
      );
      break;
    }

    // Company API
    case "company": {
      expectArgs(args, 1);
      data = await apiGet("/company", { profile_url: args[0] }, options);
      break;
    }

    case "company-lookup": {
      expectArgs(args, 1);
      data = await apiGet(
        "/company/resolve",
        { name_or_domain: args[0] },
        options
      );
      break;
    }

    case "company-id": {
      expectArgs(args, 1);
      data = await apiGet("/company/id-lookup", { company_id: args[0] }, options);
      break;
    }

    case "employees": {
      expectArgs(args, 1);
      const params = { profile_url: args[0] };
      if (options.start !== undefined) params.start = options.start;
      if (options.count !== undefined) params.count = options.count;
      data = await apiGet("/company/employees", params, options);
      break;
    }

    case "employee-count": {
      expectArgs(args, 1);
      data = await apiGet(
        "/company/employees/count",
        { profile_url: args[0] },
        options
      );
      break;
    }

    case "employee-search": {
      expectArgs(args, 2);
      data = await apiGet(
        "/company/employees/search",
        { profile_url: args[0], title: args[1] },
        options
      );
      break;
    }

    // Contact API
    case "work-email": {
      expectArgs(args, 1);
      data = await apiGet(
        "/profile/email",
        { profile_url: args[0] },
        options
      );
      break;
    }

    case "personal-email": {
      expectArgs(args, 1);
      data = await apiGet(
        "/contact-api/personal-email",
        { profile_url: args[0] },
        options
      );
      break;
    }

    case "personal-contact": {
      expectArgs(args, 1);
      data = await apiGet(
        "/contact-api/personal-contact",
        { profile_url: args[0] },
        options
      );
      break;
    }

    case "reverse-email": {
      expectArgs(args, 1);
      data = await apiGet("/resolve/email", { email: args[0] }, options);
      break;
    }

    case "reverse-phone": {
      expectArgs(args, 1);
      data = await apiGet("/resolve/phone", { phone: args[0] }, options);
      break;
    }

    case "disposable": {
      expectArgs(args, 1);
      data = await apiGet(
        "/contact-api/disposable-email",
        { email: args[0] },
        options
      );
      break;
    }

    // Search API
    case "search-person": {
      expectArgs(args, 1);
      data = await apiGet("/search/person", { q: args[0] }, options);
      break;
    }

    case "search-company": {
      expectArgs(args, 1);
      data = await apiGet("/search/company", { q: args[0] }, options);
      break;
    }

    // Jobs API
    case "job": {
      expectArgs(args, 1);
      data = await apiGet("/job", { url: args[0] }, options);
      break;
    }

    case "job-search": {
      expectArgs(args, 1);
      data = await apiGet("/company/job", { profile_url: args[0] }, options);
      break;
    }

    case "job-count": {
      expectArgs(args, 1);
      data = await apiGet(
        "/company/jobs/count",
        { profile_url: args[0] },
        options
      );
      break;
    }

    // Meta API
    case "credits": {
      expectArgs(args, 0);
      data = await apiGet("/credits", {}, options);
      break;
    }

    default: {
      console.error(`Error: unknown command "${command}".`);
      printUsage();
      process.exit(1);
    }
  }

  printData(data, options.raw);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
