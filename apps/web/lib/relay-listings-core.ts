/**
 * Prepared listings for a seller who has agreed to list ("Prepare listings and link"). The desk proposes one draft
 * listing per battery group from what the seller stated; Alex approves on the card; relay_listings.py creates the drafts
 * under ReBattery Sales through the supplier API, issues the prepared-listing invitation and the link goes into the reply
 * where the desk left LISTING_LINK_MARKER. Pure: the server, the runner's payloads and the tests share it.
 */

/** Where the link goes in the reply. A gap, so the reply can't be sent until Alex approves or declines. */
export const LISTING_LINK_MARKER = "[BLANK: listing link]";
/** The fallback when Alex declines: the seller lists themselves from the sell page. */
export const SELL_PAGE = "https://www.rebattery.io/sell-batteries";
/** At most this many drafts per proposal: one per battery group the seller named. */
export const MAX_GROUPS = 6;

export const FORMATS = ["Pack", "Module", "Cell"] as const;
export const APPLICATIONS = ["EV / automotive", "Home energy storage", "Commercial / grid storage", "Forklift / material handling", "Telecom / UPS", "E-mobility", "New / never used", "Other"] as const;
export const CURRENCIES = ["GBP", "EUR", "USD"] as const;

export type ListingGroup = {
  /** How the group is named on the card and beside its link, e.g. "Samsung 35E e-bike packs". */
  label: string;
  format: (typeof FORMATS)[number];
  description: string;
  manufacturer?: string;
  model?: string;
  chemistry?: string;
  quantity?: number;
  packKwh?: number;
  voltageNominal?: number;
  numCells?: string;
  cellFormat?: string;
  originalApplication?: (typeof APPLICATIONS)[number];
  /** Only what the seller said about damage; the condition grade is always theirs to choose. */
  conditionDeclaration?: "none_damaged" | "some_damaged";
  damageDetails?: string;
  /** Only a price the seller stated. */
  buyItNowPrice?: number;
  currency?: (typeof CURRENCIES)[number];
  location: { country: string; countryCode: string; region?: string; city?: string };
};

export type ProposalStatus = "proposed" | "creating" | "ready" | "failed" | "declined";

/** What the card shows. Never the link: it is a credential and lives only in the reply. */
export type ListingProposalView = {
  id: string; status: ProposalStatus; sellerEmail: string; why: string;
  groups: { label: string; facts: string[] }[];
  listingCount: number; expiresAt: string | null; error: string | null; createdAt: string;
};

class GroupError extends Error {}

const str = (v: unknown, key: string, max: number, optional = true): string | undefined => {
  if (v === undefined || v === null || (typeof v === "string" && !v.trim())) {
    if (optional) return undefined;
    throw new GroupError(`${key} is required.`);
  }
  if (typeof v !== "string") throw new GroupError(`${key} must be text.`);
  return v.trim().slice(0, max);
};
const num = (v: unknown, key: string, max: number, integer = false): number | undefined => {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0 || v > max) throw new GroupError(`${key} must be a positive number.`);
  return integer ? Math.round(v) : v;
};
const oneOf = <T extends string>(v: unknown, key: string, options: readonly T[]): T | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  if (!options.includes(v as T)) throw new GroupError(`${key} must be one of ${options.join(", ")}.`);
  return v as T;
};

/** Reads the desk's groups strictly. Throws with a reason the desk can act on. */
export function readGroups(raw: unknown): ListingGroup[] {
  if (!Array.isArray(raw) || !raw.length) throw new GroupError("Give at least one group: one draft listing per battery group the seller named.");
  if (raw.length > MAX_GROUPS) throw new GroupError(`At most ${MAX_GROUPS} groups.`);
  return raw.map((r, i) => {
    try {
      if (!r || typeof r !== "object") throw new GroupError("must be an object.");
      const g = r as Record<string, unknown>;
      const loc = (g.location && typeof g.location === "object" ? g.location : {}) as Record<string, unknown>;
      const countryCode = str(loc.countryCode, "location.countryCode", 10, false)!.toUpperCase();
      if (!/^[A-Z]{2}$/.test(countryCode)) throw new GroupError("location.countryCode must be two letters, e.g. US or GB.");
      const price = num(g.buyItNowPrice, "buyItNowPrice", 9_999_999);
      const currency = oneOf(g.currency, "currency", CURRENCIES);
      if (price !== undefined && !currency) throw new GroupError("A price needs its currency.");
      if ("condition" in g || "soh" in g) throw new GroupError("Leave condition and SoH out: the seller chooses the grade when they finish the listing.");
      return {
        label: str(g.label, "label", 80, false)!,
        format: oneOf(g.format, "format", FORMATS) ?? (() => { throw new GroupError("format is required (Pack, Module or Cell)."); })(),
        description: str(g.description, "description", 1200, false)!,
        manufacturer: str(g.manufacturer, "manufacturer", 80), model: str(g.model, "model", 120), chemistry: str(g.chemistry, "chemistry", 40),
        quantity: num(g.quantity, "quantity", 10_000_000, true), packKwh: num(g.packKwh, "packKwh", 999_999), voltageNominal: num(g.voltageNominal, "voltageNominal", 999_999),
        numCells: str(g.numCells, "numCells", 20), cellFormat: str(g.cellFormat, "cellFormat", 40),
        originalApplication: oneOf(g.originalApplication, "originalApplication", APPLICATIONS),
        conditionDeclaration: oneOf(g.conditionDeclaration, "conditionDeclaration", ["none_damaged", "some_damaged"] as const),
        damageDetails: str(g.damageDetails, "damageDetails", 200),
        buyItNowPrice: price, currency,
        location: { country: str(loc.country, "location.country", 80, false)!, countryCode, region: str(loc.region, "location.region", 80), city: str(loc.city, "location.city", 80) },
      };
    } catch (error) {
      throw new GroupError(`Group ${i + 1}: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

/** The supplier API's CreateListingInput for one group, always a draft (the seller publishes). Images are added by the runner. */
export function apiPayload(g: ListingGroup, reference: string): Record<string, unknown> {
  const place = [g.location.city, g.location.region, g.location.country].filter(Boolean).join(", ");
  const payload: Record<string, unknown> = {
    status: "draft", channelMode: "sale", reference, format: g.format, description: g.description,
    manufacturer: g.manufacturer, model: g.model, chemistry: g.chemistry, quantity: g.quantity, packKwh: g.packKwh,
    voltageNominal: g.voltageNominal, numCells: g.numCells, cellFormat: g.cellFormat, originalApplication: g.originalApplication,
    conditionDeclaration: g.conditionDeclaration, damageDetails: g.damageDetails,
    buyItNowPrice: g.buyItNowPrice, currency: g.currency ?? (g.location.countryCode === "US" ? "USD" : g.location.countryCode === "GB" ? "GBP" : "EUR"),
    address: { address: place, country: g.location.country, countryCode: g.location.countryCode, region: g.location.region, city: g.location.city },
  };
  return JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;  // drops the undefined fields
}

/** The facts the card shows for one group. */
export function groupFacts(g: ListingGroup): string[] {
  return [
    [g.manufacturer, g.model].filter(Boolean).join(" ") || null,
    `${g.quantity ? `${g.quantity.toLocaleString("en-GB")} x ` : ""}${g.format.toLowerCase()}${g.numCells ? `, ${g.numCells} cells` : ""}${g.packKwh ? `, ${g.packKwh} kWh` : ""}`,
    g.chemistry ?? null,
    [g.location.region ?? g.location.city, g.location.country].filter(Boolean).join(", "),
    g.buyItNowPrice ? `${g.currency} ${g.buyItNowPrice.toLocaleString("en-GB")} (their price)` : "Price: theirs to add",
    g.conditionDeclaration === "some_damaged" ? `Damage: ${g.damageDetails ?? "some"}` : null,
  ].filter((x): x is string => !!x);
}

/** The link text for the reply: one link alone, or each group's link on its own line. The first link sets up the account. */
export function linkBlock(links: { label: string; url: string }[]): string {
  if (links.length === 1) return links[0].url;
  return links.map((l, i) => `${l.label}: ${l.url}${i === 0 ? "" : " (once you've set your password)"}`).join("\n");
}

const SIGN_OFF = /\n\n(best|thanks|kind regards|regards|cheers|many thanks)[^\n]{0,20},?\n/i;

/** Puts the link where the desk left the marker; if Alex took the marker out, as its own paragraph before the sign-off. */
export function placeLink(body: string, block: string): string {
  if (body.includes(LISTING_LINK_MARKER)) return body.split(LISTING_LINK_MARKER).join(block);
  const close = SIGN_OFF.exec(body);
  return close ? `${body.slice(0, close.index)}\n\n${block}${body.slice(close.index)}` : `${body.trimEnd()}\n\n${block}`;
}

/** Declined: the sell page in place of the prepared link. */
export const declineBody = (body: string): string => body.split(LISTING_LINK_MARKER).join(SELL_PAGE);
