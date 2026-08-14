/**
 * Display-name helpers for CRM object table identifiers.
 *
 * Workspace tables are stored using machine-friendly identifiers
 * (`vc_lead`, `Yc_founder`, `myCompany`, ...) but the UI should always
 * show a human-friendly label. These helpers normalize those identifiers
 * into a single house style:
 *
 *   vc_lead       → "VC Leads"   /  singular: "VC Lead"
 *   Yc_founder    → "YC Founders" /  singular: "YC Founder"
 *   my_company    → "My Companies" / singular: "My Company"
 *   yc-outreach   → "YC Outreaches" / singular: "YC Outreach"
 *   personOfInterest → "Persons Of Interest" — last token pluralized
 *
 * Rules:
 *  - Split on `_`, `-`, and camelCase boundaries.
 *  - Tokens that match a known acronym (vc, yc, ai, api, …) are uppercased.
 *  - Other tokens get title-cased.
 *  - Pluralization (when applicable) is applied to the LAST token only.
 *  - Already-plural inputs (`people`, `companies`, `leads`) stay plural.
 *
 * Raw identifiers are still the source of truth for API calls and routing —
 * these helpers are display-only.
 */

const PLURAL_DISPLAY_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map();

const SINGULAR_DISPLAY_NAME_OVERRIDES: ReadonlyMap<string, string> = new Map();

const KNOWN_ACRONYMS: ReadonlySet<string> = new Set([
  // venture / fundraising
  "vc", "yc", "ipo", "kpi", "kyc", "roi", "mrr", "arr",
  // tech
  "ai", "ml", "llm", "nlp", "api", "sdk", "url", "uri", "uuid",
  "ios", "css", "html", "json", "yaml", "sql",
  // markets
  "b2b", "b2c", "saas", "iaas", "paas",
  // titles
  "ceo", "cto", "cfo", "coo", "cmo", "cro", "vp",
  // sales / cs
  "sdr", "bdr", "ae", "am", "csm", "crm", "erp",
  // misc business
  "hr", "pr", "it", "ip", "id", "qa", "qc", "ux", "ui",
  "sla", "nda", "msa",
  // geos
  "us", "uk", "eu", "uae", "usa",
]);

const IRREGULAR_PLURALS: ReadonlyMap<string, string> = new Map([
  ["person", "people"],
  ["man", "men"],
  ["woman", "women"],
  ["child", "children"],
  ["mouse", "mice"],
  ["goose", "geese"],
  ["foot", "feet"],
  ["tooth", "teeth"],
  ["datum", "data"],
  ["criterion", "criteria"],
  ["phenomenon", "phenomena"],
  ["leaf", "leaves"],
  ["life", "lives"],
  ["wife", "wives"],
  ["knife", "knives"],
]);

const IRREGULAR_SINGULARS: ReadonlyMap<string, string> = new Map(
  Array.from(IRREGULAR_PLURALS.entries(), ([s, p]) => [p, s]),
);

/**
 * Singular nouns that *look* plural (end in `s`/`es`) but aren't, so the
 * "already plural" heuristic shouldn't skip them. Add to this set if a
 * common CRM term gets mangled.
 */
const SINGULAR_LOOKING_PLURAL: ReadonlySet<string> = new Set([
  "address", "process", "status", "lens", "series", "species",
  "news", "analysis", "basis", "thesis", "axis",
  "business", "boss", "class", "glass", "miss", "pass",
]);

/**
 * Split a CRM identifier into lowercase tokens.
 *
 *   "vc_lead"        → ["vc", "lead"]
 *   "vc-lead"        → ["vc", "lead"]
 *   "vcLead"         → ["vc", "lead"]
 *   "Yc_founder"     → ["yc", "founder"]
 *   "myCompany"      → ["my", "company"]
 *   "  VC___Lead  "  → ["vc", "lead"]
 */
export function splitObjectTokens(raw: string): string[] {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return [];
  return trimmed
    // camelCase / PascalCase: insert separator before any uppercase that
    // follows a lowercase or digit, or before an uppercase that's followed
    // by a lowercase (handles "URLPath" → "URL Path").
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    // Snake / kebab / whitespace separators all collapse to spaces.
    .replace(/[_\-\s]+/g, " ")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter(Boolean);
}

/** Format a single lowercase token: acronym → upper, else title-case. */
function formatToken(token: string): string {
  if (!token) return "";
  if (KNOWN_ACRONYMS.has(token)) return token.toUpperCase();
  return token.charAt(0).toUpperCase() + token.slice(1);
}

/** Format the LAST token in plural mode, preserving acronym uppercase
 *  when the singular form is a known acronym ("ceo" → "CEOs"). */
function formatLastTokenPlural(token: string): string {
  if (!token) return "";
  if (KNOWN_ACRONYMS.has(token)) return `${token.toUpperCase()}s`;
  if (looksAlreadyPlural(token)) {
    const singular = singularizeWord(token);
    if (KNOWN_ACRONYMS.has(singular)) {
      const suffix = token.slice(singular.length);
      return `${singular.toUpperCase()}${suffix}`;
    }
    return formatToken(token);
  }
  const plural = pluralizeWord(token);
  return plural.charAt(0).toUpperCase() + plural.slice(1);
}

/** Format the LAST token in singular mode. Recovers acronym-ness even
 *  when the input is a plural acronym ("ceos" → "CEO"). */
function formatLastTokenSingular(token: string): string {
  if (!token) return "";
  if (KNOWN_ACRONYMS.has(token)) return token.toUpperCase();
  const singular = singularizeWord(token);
  if (KNOWN_ACRONYMS.has(singular)) return singular.toUpperCase();
  return formatToken(singular);
}

/** Heuristic: does this lowercase word look already-plural? */
function looksAlreadyPlural(word: string): boolean {
  if (!word) return false;
  if (IRREGULAR_SINGULARS.has(word)) return true;
  if (SINGULAR_LOOKING_PLURAL.has(word)) return false;
  if (word.endsWith("ies")) return true;
  if (word.endsWith("ses") || word.endsWith("xes") || word.endsWith("zes")) return true;
  if (word.endsWith("ches") || word.endsWith("shes")) return true;
  // Generic "ends in s" — but don't treat 2-letter words (e.g. "is", "us") as plural.
  if (word.endsWith("s") && word.length > 2 && !word.endsWith("ss")) return true;
  return false;
}

/** Pluralize a lowercase English word using simple rules + irregulars. */
function pluralizeWord(word: string): string {
  if (!word) return word;
  if (looksAlreadyPlural(word)) return word;
  const irregular = IRREGULAR_PLURALS.get(word);
  if (irregular) return irregular;
  if (/(s|x|z|ch|sh)$/.test(word)) return `${word}es`;
  if (/[^aeiou]y$/.test(word)) return `${word.slice(0, -1)}ies`;
  return `${word}s`;
}

/** Singularize a lowercase English word using simple rules + irregulars. */
function singularizeWord(word: string): string {
  if (!word) return word;
  const irregular = IRREGULAR_SINGULARS.get(word);
  if (irregular) return irregular;
  if (SINGULAR_LOOKING_PLURAL.has(word)) return word;
  if (word.endsWith("ies") && word.length > 3) return `${word.slice(0, -3)}y`;
  if (word.endsWith("sses")) return word.slice(0, -2); // addresses → address
  if (
    (word.endsWith("ches") || word.endsWith("shes") || word.endsWith("xes") || word.endsWith("zes")) &&
    word.length > 3
  ) {
    return word.slice(0, -2);
  }
  if (word.endsWith("s") && !word.endsWith("ss") && word.length > 2) return word.slice(0, -1);
  return word;
}

/**
 * Pretty plural form for an object identifier.
 *
 * Used for sidebar nav, page headers, tab titles, and any "search across
 * the collection" label.
 */
export function displayObjectName(raw: string): string {
  const override = PLURAL_DISPLAY_NAME_OVERRIDES.get(raw);
  if (override) {return override;}
  const tokens = splitObjectTokens(raw);
  if (tokens.length === 0) return raw ?? "";
  const last = tokens.length - 1;
  const formatted = tokens.map((t, i) =>
    i === last ? formatLastTokenPlural(t) : formatToken(t),
  );
  return formatted.join(" ");
}

/**
 * Pretty singular form for an object identifier.
 *
 * Used for action verbs ("Add VC Lead", "Select Company", "Go to YC Founder")
 * and per-record chip labels.
 */
export function displayObjectNameSingular(raw: string): string {
  const override = SINGULAR_DISPLAY_NAME_OVERRIDES.get(raw);
  if (override) {return override;}
  const tokens = splitObjectTokens(raw);
  if (tokens.length === 0) return raw ?? "";
  const last = tokens.length - 1;
  const formatted = tokens.map((t, i) =>
    i === last ? formatLastTokenSingular(t) : formatToken(t),
  );
  return formatted.join(" ");
}
