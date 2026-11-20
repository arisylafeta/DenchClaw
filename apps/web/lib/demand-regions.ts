// Countries and the regions the Matches criteria filter by. One code constant, so the matcher, the editor and the
// registry migration (which lists these names as the allowed `supplier_countries`) agree.

export const REGIONS = ["Europe", "America", "Middle East", "Africa", "Asia", "SE Asia"] as const;
export type Region = (typeof REGIONS)[number];

/** Short description of each region, shown next to it in the editor. */
export const REGION_NOTE: Record<Region, string> = {
  Europe: "EU, UK, Norway, Switzerland, Turkey, Ukraine",
  America: "North and South America",
  "Middle East": "GCC, Israel, Jordan",
  Africa: "All of Africa",
  Asia: "China, India, Japan, Korea",
  "SE Asia": "Vietnam, Thailand, Malaysia, Indonesia, Philippines",
};

// [ISO code, name]
const BY_REGION: Record<Region, [string, string][]> = {
  Europe: [
    ["AL", "Albania"], ["AT", "Austria"], ["BY", "Belarus"], ["BE", "Belgium"], ["BA", "Bosnia and Herzegovina"], ["BG", "Bulgaria"],
    ["HR", "Croatia"], ["CY", "Cyprus"], ["CZ", "Czechia"], ["DK", "Denmark"], ["EE", "Estonia"], ["FI", "Finland"], ["FR", "France"],
    ["DE", "Germany"], ["GR", "Greece"], ["HU", "Hungary"], ["IS", "Iceland"], ["IE", "Ireland"], ["IT", "Italy"], ["LV", "Latvia"],
    ["LT", "Lithuania"], ["LU", "Luxembourg"], ["MT", "Malta"], ["MD", "Moldova"], ["ME", "Montenegro"], ["NL", "Netherlands"],
    ["MK", "North Macedonia"], ["NO", "Norway"], ["PL", "Poland"], ["PT", "Portugal"], ["RO", "Romania"], ["RU", "Russia"],
    ["RS", "Serbia"], ["SK", "Slovakia"], ["SI", "Slovenia"], ["ES", "Spain"], ["SE", "Sweden"], ["CH", "Switzerland"], ["TR", "Turkey"],
    ["UA", "Ukraine"], ["GB", "United Kingdom"],
  ],
  America: [
    ["AR", "Argentina"], ["BO", "Bolivia"], ["BR", "Brazil"], ["CA", "Canada"], ["CL", "Chile"], ["CO", "Colombia"], ["CR", "Costa Rica"],
    ["DO", "Dominican Republic"], ["EC", "Ecuador"], ["GT", "Guatemala"], ["MX", "Mexico"], ["PA", "Panama"], ["PY", "Paraguay"],
    ["PE", "Peru"], ["UY", "Uruguay"], ["US", "United States"], ["VE", "Venezuela"],
  ],
  "Middle East": [
    ["BH", "Bahrain"], ["IQ", "Iraq"], ["IL", "Israel"], ["JO", "Jordan"], ["KW", "Kuwait"], ["LB", "Lebanon"], ["OM", "Oman"],
    ["QA", "Qatar"], ["SA", "Saudi Arabia"], ["AE", "United Arab Emirates"],
  ],
  Africa: [
    ["DZ", "Algeria"], ["EG", "Egypt"], ["ET", "Ethiopia"], ["GH", "Ghana"], ["KE", "Kenya"], ["MA", "Morocco"], ["NG", "Nigeria"],
    ["SN", "Senegal"], ["ZA", "South Africa"], ["TZ", "Tanzania"], ["TN", "Tunisia"], ["UG", "Uganda"], ["ZM", "Zambia"], ["ZW", "Zimbabwe"],
  ],
  Asia: [
    ["BD", "Bangladesh"], ["CN", "China"], ["HK", "Hong Kong"], ["IN", "India"], ["JP", "Japan"], ["KZ", "Kazakhstan"],
    ["KR", "South Korea"], ["LK", "Sri Lanka"], ["PK", "Pakistan"], ["TW", "Taiwan"], ["UZ", "Uzbekistan"],
  ],
  "SE Asia": [
    ["ID", "Indonesia"], ["KH", "Cambodia"], ["MY", "Malaysia"], ["PH", "Philippines"], ["SG", "Singapore"], ["TH", "Thailand"], ["VN", "Vietnam"],
  ],
};

export type CountryRow = { code: string; name: string; region: Region };

export const COUNTRIES: CountryRow[] = REGIONS.flatMap((region) => BY_REGION[region].map(([code, name]) => ({ code, name, region })));

const BY_CODE = new Map(COUNTRIES.map((row) => [row.code, row]));
const BY_NAME = new Map(COUNTRIES.map((row) => [row.name.toLowerCase(), row]));
// Names sellers write instead of the ones above.
const ALIASES: Record<string, string> = {
  uk: "GB", "great britain": "GB", england: "GB", scotland: "GB", wales: "GB", "northern ireland": "GB", usa: "US", "united states of america": "US",
  uae: "AE", holland: "NL", "the netherlands": "NL", "czech republic": "CZ", deutschland: "DE", polska: "PL", italia: "IT",
  "korea": "KR", "republic of korea": "KR", turkiye: "TR", "türkiye": "TR", macedonia: "MK", "viet nam": "VN",
};

export const countryNameOf = (code: string | null | undefined): string | null => (code ? BY_CODE.get(code.toUpperCase())?.name ?? null : null);

/** ISO code of a country given as a code or a name ("DE", "Germany", "uk"); null when it is not one we know. */
export function countryCodeOf(text: string | null | undefined): string | null {
  const value = (text ?? "").trim();
  if (!value) return null;
  if (/^[A-Za-z]{2}$/.test(value)) {
    const code = value.toUpperCase();
    if (BY_CODE.has(code)) return code;
    return ALIASES[value.toLowerCase()] ?? null;
  }
  const lower = value.toLowerCase();
  return BY_NAME.get(lower)?.code ?? ALIASES[lower] ?? null;
}

/** The country in free text such as "Brumunddal, Innlandet, Norway" or "Leeds, UK": the last comma part that names one. */
export function countryInText(text: string | null | undefined): string | null {
  if (!text) return null;
  const parts = text.split(/[,;|/()\n]/).map((part) => part.trim()).filter(Boolean);
  for (let i = parts.length - 1; i >= 0; i--) {
    const code = countryCodeOf(parts[i]);
    if (code) return code;
  }
  const lower = ` ${text.toLowerCase().replace(/[^a-z\u00c0-\u024f ]+/g, " ")} `;
  for (const row of COUNTRIES) if (lower.includes(` ${row.name.toLowerCase()} `)) return row.code;
  return null;
}

export const regionOfCode = (code: string | null | undefined): Region | null => (code ? BY_CODE.get(code.toUpperCase())?.region ?? null : null);

/** The country codes a supplier-country list plus a supplier-region list allow (their union). Empty when neither is set. */
export function allowedSupplierCodes(countries: readonly string[], regions: readonly string[]): Set<string> {
  const allowed = new Set<string>();
  for (const name of countries) {
    const code = countryCodeOf(name);
    if (code) allowed.add(code);
  }
  for (const row of COUNTRIES) if ((regions as readonly string[]).includes(row.region)) allowed.add(row.code);
  return allowed;
}
