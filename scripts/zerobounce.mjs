#!/usr/bin/env node
/**
 * ZeroBounce Email Validation CLI
 *
 * Standalone Node.js ES module for the ZeroBounce v2 API.
 * Uses only Node.js built-in modules + global fetch.
 *
 * Usage:
 *   ZEROBOUNCE_API_KEY=xxx node scripts/zerobounce.mjs validate test@example.com
 *   ZEROBOUNCE_API_KEY=xxx node scripts/zerobounce.mjs batch a@b.com,c@d.com
 *   ZEROBOUNCE_API_KEY=xxx node scripts/zerobounce.mjs credits
 *   ZEROBOUNCE_API_KEY=xxx node scripts/zerobounce.mjs usage 2026-01-01 2026-01-31
 *   ZEROBOUNCE_API_KEY=xxx node scripts/zerobounce.mjs find John Doe example.com
 *   ZEROBOUNCE_API_KEY=xxx node scripts/zerobounce.mjs score test@example.com
 *   ZEROBOUNCE_API_KEY=xxx node scripts/zerobounce.mjs activity test@example.com
 */

const API_BASE = "https://api.zerobounce.net/v2";
const ZEROBOUNCE_API_KEY = process.env.ZEROBOUNCE_API_KEY;

/**
 * Print usage information and exit.
 * @param {number} exitCode - Exit code to use (default 0)
 */
function printUsage(exitCode = 0) {
  const scriptName = process.argv[1].split("/").pop();

  console.log(`ZeroBounce Email Validation CLI

Usage:
  ZEROBOUNCE_API_KEY=xxx node ${scriptName} <command> [options]

Commands:
  validate <email>                       Validate a single email (GET /v2/validate)
  batch <email1,email2,...>              Batch validate up to 100 emails (POST /v2/validatebatch)
  credits                                Check remaining credits (GET /v2/getcredits)
  usage [start_date] [end_date]          Get API usage (GET /v2/getapiusage)
  find <first_name> <last_name> <domain> Email finder (GET /v2/guessformat)
  score <email>                          AI scoring (GET /v2/scoring)
  activity <email>                       Check email activity (GET /v2/activity)

Options:
  --raw     Output raw JSON (no pretty print)
  --quiet   Minimal output (validate command returns status only)
  --help    Show this help message

Environment:
  ZEROBOUNCE_API_KEY    Required. Your ZeroBounce API key.
`);

  process.exit(exitCode);
}

/**
 * Print an error message to stderr and exit.
 * @param {string} message
 * @param {number} exitCode
 */
function die(message, exitCode = 1) {
  console.error(`Error: ${message}`);
  process.exit(exitCode);
}

/**
 * Format and output data based on CLI flags.
 * @param {unknown} data
 * @param {object} options
 * @param {boolean} options.raw
 * @param {boolean} options.quiet
 * @param {string} [options.command]
 */
function outputData(data, { raw, quiet, command }) {
  // Minimal output for the validate command when --quiet is set
  if (quiet && command === "validate" && data && typeof data === "object" && "status" in data) {
    console.log(String(data.status));
    return;
  }

  if (raw) {
    console.log(JSON.stringify(data));
  } else {
    console.log(JSON.stringify(data, null, 2));
  }
}

/**
 * Make a request to the ZeroBounce API and parse/validate the response.
 * @param {string} endpoint - API endpoint path (e.g. /v2/validate)
 * @param {object} [options]
 * @param {URLSearchParams} [options.searchParams]
 * @param {object} [options.body] - JSON body for POST requests
 * @returns {Promise<unknown>} Parsed JSON response
 */
async function apiRequest(endpoint, { searchParams, body } = {}) {
  const url = new URL(endpoint, API_BASE);
  if (searchParams) {
    url.search = searchParams.toString();
  }

  const fetchOptions = {
    method: body ? "POST" : "GET",
    headers: {
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
  };

  if (body) {
    fetchOptions.body = JSON.stringify(body);
  }

  let response;
  try {
    response = await fetch(url.href, fetchOptions);
  } catch (err) {
    die(`Network error: ${err.message ?? err}`);
  }

  let data;
  try {
    data = await response.json();
  } catch (err) {
    die(`Failed to parse API response: ${err.message ?? err}`);
  }

  // Treat explicit API error payloads as failures
  if (data && typeof data === "object" && "error" in data && data.error) {
    die(`API error: ${data.error}`);
  }

  // Handle non-2xx HTTP responses
  if (!response.ok) {
    die(`HTTP ${response.status}: ${response.statusText}`);
  }

  return data;
}

/**
 * Validate a single email address.
 */
async function validateEmail(email) {
  const params = new URLSearchParams({
    api_key: ZEROBOUNCE_API_KEY,
    email,
  });

  return apiRequest("/v2/validate", { searchParams: params });
}

/**
 * Batch validate up to 100 comma-separated email addresses.
 */
async function batchValidate(emailsCsv) {
  const emails = emailsCsv
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);

  if (emails.length === 0) {
    die("Please provide at least one email address for batch validation.");
  }

  if (emails.length > 100) {
    die(`Batch validation supports a maximum of 100 emails; received ${emails.length}.`);
  }

  const body = {
    api_key: ZEROBOUNCE_API_KEY,
    email_batch: emails.map((email) => ({ email_address: email })),
  };

  return apiRequest("/v2/validatebatch", { body });
}

/**
 * Check remaining API credits.
 */
async function getCredits() {
  const params = new URLSearchParams({ api_key: ZEROBOUNCE_API_KEY });

  return apiRequest("/v2/getcredits", { searchParams: params });
}

/**
 * Get API usage for a date range.
 */
async function getUsage(startDate, endDate) {
  const params = new URLSearchParams({
    api_key: ZEROBOUNCE_API_KEY,
  });

  if (startDate) params.set("start_date", startDate);
  if (endDate) params.set("end_date", endDate);

  return apiRequest("/v2/getapiusage", { searchParams: params });
}

/**
 * Find email format from first name, last name, and domain.
 */
async function findEmail(firstName, lastName, domain) {
  const params = new URLSearchParams({
    api_key: ZEROBOUNCE_API_KEY,
    first_name: firstName,
    last_name: lastName,
    domain,
  });

  return apiRequest("/v2/guessformat", { searchParams: params });
}

/**
 * Get AI score for an email address.
 */
async function scoreEmail(email) {
  const params = new URLSearchParams({
    api_key: ZEROBOUNCE_API_KEY,
    email,
  });

  return apiRequest("/v2/scoring", { searchParams: params });
}

/**
 * Get activity data for an email address.
 */
async function getActivity(email) {
  const params = new URLSearchParams({
    api_key: ZEROBOUNCE_API_KEY,
    email,
  });

  return apiRequest("/v2/activity", { searchParams: params });
}

/**
 * Parse CLI args into commands, positional arguments, and flags.
 */
function parseArgs() {
  const args = process.argv.slice(2);

  const flags = {
    raw: false,
    quiet: false,
    help: false,
  };

  const positional = [];

  for (const arg of args) {
    if (arg === "--raw") {
      flags.raw = true;
    } else if (arg === "--quiet") {
      flags.quiet = true;
    } else if (arg === "--help" || arg === "-h") {
      flags.help = true;
    } else {
      positional.push(arg);
    }
  }

  return { command: positional[0], positional: positional.slice(1), flags };
}

async function main() {
  const { command, positional, flags } = parseArgs();

  if (flags.help || !command) {
    printUsage(flags.help ? 0 : 1);
  }

  if (!ZEROBOUNCE_API_KEY) {
    die("Missing ZEROBOUNCE_API_KEY environment variable.");
  }

  let data;
  switch (command) {
    case "validate": {
      const [email] = positional;
      if (!email) die("validate requires an email address.");
      data = await validateEmail(email);
      break;
    }

    case "batch": {
      const [emailsCsv] = positional;
      if (!emailsCsv) die("batch requires a comma-separated list of emails.");
      data = await batchValidate(emailsCsv);
      break;
    }

    case "credits": {
      data = await getCredits();
      break;
    }

    case "usage": {
      const [startDate, endDate] = positional;
      data = await getUsage(startDate, endDate);
      break;
    }

    case "find": {
      const [firstName, lastName, domain] = positional;
      if (!firstName || !lastName || !domain) {
        die("find requires first_name, last_name, and domain.");
      }
      data = await findEmail(firstName, lastName, domain);
      break;
    }

    case "score": {
      const [email] = positional;
      if (!email) die("score requires an email address.");
      data = await scoreEmail(email);
      break;
    }

    case "activity": {
      const [email] = positional;
      if (!email) die("activity requires an email address.");
      data = await getActivity(email);
      break;
    }

    default:
      die(`Unknown command: ${command}`);
  }

  outputData(data, { raw: flags.raw, quiet: flags.quiet, command });
}

main();
