/**
 * Canonical model slugs, shared by the lot side (`productKeyFor`) and the buyer lines (SQL `buyer_interest_model_slug()`
 * in migration 115, scripts/rebattery/model_aliases.py). `model-aliases.json` is the one list; the three readers are tested
 * to agree on every alias. "Kona Electric" is `kona`, "Model 3 Long Range AWD" is `model3`, "e-Niro" is `niro`, "ID.3" is `id3`.
 *
 * Normalise the text (lower case, accents folded, kWh/kW/Ah figures, bracketed asides, years and battery/pack/module words
 * removed, punctuation to single spaces, a leading make dropped, trailing trim words dropped), then find an alias that equals
 * it or starts it. An alias that belongs to the line's own make wins, and a bare short alias ("4", "2") only applies to its
 * own make. A text that lists models names none; with a slash the whole text must be an alias. An unknown model keeps its
 * folded text, so keys never change for a model the list does not know.
 */
import aliasData from "./model-aliases.json";

type AliasModel = { make: string; slug: string; name: string; aliases: string[] };
const DATA = aliasData as { makeAliases: Record<string, string>; models: AliasModel[] };

const VARIANT_WORDS = new Set(["long", "range", "standard", "awd", "rwd", "fwd", "4wd", "2wd", "lr", "sr", "dual", "motor", "performance", "premium", "se"]);
const BRAND_WORDS = [
  "volkswagen", "vw", "audi", "mini", "skoda", "cupra", "porsche", "bmw", "mercedes-benz", "mercedes", "tesla", "stellantis", "nissan",
  "renault", "dacia", "peugeot", "citroen", "opel", "vauxhall", "fiat", "jeep", "ford", "hyundai", "kia", "genesis", "toyota", "lexus",
  "honda", "mazda", "mitsubishi", "suzuki", "subaru", "volvo", "polestar", "jaguar", "land rover", "mg", "byd", "lotus", "lucid", "rivian",
  "nio", "xpeng", "zeekr", "leapmotor", "maxus", "smart", "seat",
];

const unaccent = (value: string | null | undefined) => (value ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const fold = (value: string | null | undefined) => unaccent(value).replace(/[^a-z0-9]+/g, "");
const spaced = (value: string) => value.replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");

function makeFold(make: string | null | undefined): string {
  const folded = fold(make);
  return DATA.makeAliases[folded] ?? folded;
}

type AliasRow = { own: string; alias: string; slug: string; global: boolean };
const ALIAS_ROWS: AliasRow[] = (() => {
  const owners = new Map<string, Set<string>>();
  for (const model of DATA.models) {
    for (const alias of model.aliases) {
      owners.set(alias, (owners.get(alias) ?? new Set()).add(model.slug));
    }
  }
  const rows: AliasRow[] = [];
  for (const model of DATA.models) {
    for (const alias of model.aliases) {
      const compact = alias.replace(/ /g, "");
      rows.push({ own: makeFold(model.make), alias, slug: model.slug, global: (owners.get(alias)?.size ?? 0) === 1 && compact.length > 2 && !/^\d+$/.test(compact) });
    }
  }
  return rows;
})();

/** A model text that lists vehicles (comma, semicolon, colon) names no single model. */
export function listsModels(raw: string | null | undefined): boolean {
  return /[,;:]/.test(raw ?? "");
}

/** The model text as the alias list reads it. */
export function normalModelTokens(raw: string | null | undefined, make?: string | null): string {
  let text = unaccent(raw)
    .replace(/\b\d+(?:\.\d+)?\s*(?:kwh|kw|ps|hp|bhp|ah)\b/g, " ")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ")
    .replace(/\b(?:19|20)\d{2}\b/g, " ")
    .replace(/\b(?:battery|batteries|packs?|modules?|hv|high voltage)\b/g, " ");
  text = spaced(text);
  const own = make ? spaced(unaccent(make)) : "";
  const brands = [...new Set([own, ...BRAND_WORDS.map((brand) => spaced(brand))].filter(Boolean))].toSorted((a, b) => b.length - a.length);
  for (const brand of brands) {
    if (text.startsWith(`${brand} `)) {
      text = text.slice(brand.length + 1);
      break;
    }
  }
  const tokens = text.split(" ").filter(Boolean);
  while (tokens.length > 1 && VARIANT_WORDS.has(tokens[tokens.length - 1])) { tokens.pop(); }
  return tokens.join(" ");
}

/** The canonical slug for a model under a make; null when the text names no single model. */
export function modelSlug(make: string | null | undefined, raw: string | null | undefined): string | null {
  if (!(raw ?? "").trim() || listsModels(raw)) { return null; }
  const norm = normalModelTokens(raw, make);
  if (!norm) { return null; }
  const mk = make ? makeFold(make) : null;
  const exactOnly = (raw ?? "").includes("/");
  let best: { own: boolean; length: number; slug: string } | null = null;
  for (const row of ALIAS_ROWS) {
    if (!(norm === row.alias || (!exactOnly && norm.startsWith(`${row.alias} `)))) { continue; }
    const own = row.own === mk;
    if (!(own || row.global)) { continue; }
    if (!best || (own && !best.own) || (own === best.own && row.alias.length > best.length)) { best = { own, length: row.alias.length, slug: row.slug }; }
  }
  if (best) { return best.slug; }
  if (exactOnly || norm.split(" ").length >= 4) { return null; }
  return fold(norm) || null;
}

/** Every canonical slug the list defines, for tests and the conformance checker. */
export const CANONICAL_MODEL_SLUGS: ReadonlySet<string> = new Set(DATA.models.map((model) => model.slug));
export const MODEL_ALIAS_DATA = DATA;
