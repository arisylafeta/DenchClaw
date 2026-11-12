// Price sheets for buyers, built from CRM data only. Three shapes:
//   overview  one row per lot offered to this buyer: what it is, kWh, state of health where known, country, how many
//             are available and the buyer price. For a buyer choosing among many packs.
//   fixed     the confirmed lines: quantity, unit price, line total, the total, delivery terms and the last day.
//   send      the fixed sheet as it goes with the offer email, kept so History shows what was sent.
//
// A buyer sees only teaser fields, and at most the country. The price on every line is the one recorded on the offer
// (`terms.amount`, its currency and unit), never the seller's: a sheet whose text holds the seller's name, contact,
// address or price is refused, and so is a line whose buyer price equals the seller's. References are a prefix plus
// random hex, never a running number.
import { randomBytes } from "node:crypto";
import { utils, write } from "xlsx";
import { buildProductKey, type FieldFact, type ProductKey } from "./match/product-key";
import { buyerField, firstLeak, publicCountry } from "./match/offer-email";
import { priceUnit } from "./bulk-offer-close";

export type SheetKind = "overview" | "fixed" | "send";

export const SHEET_TITLE: Record<SheetKind, string> = {
  overview: "Price overview", fixed: "Price sheet", send: "Price sheet (sent copy)",
};

/** "PS-3f9a1c7e": a prefix and eight random hex characters. */
export function sheetReference(): string {
  return `PS-${randomBytes(4).toString("hex")}`;
}

/** One lot on a sheet, as the CRM holds it. Everything seller-only is passed in so it can be checked against, never shown. */
export type SheetLot = {
  /** All the lot's field rows; only teaser rows reach the sheet. */
  fields: FieldFact[];
  /** The buyer price recorded on the offer. */
  price: { amount: number; currency: string; unit: string };
  /** How many the buyer takes (fixed sheet), from the offer or the match's yes. */
  quantity?: number | null;
};

export type SheetInput = {
  kind: SheetKind;
  reference: string;
  /** YYYY-MM-DD. */
  date: string;
  lots: SheetLot[];
  delivery?: string | null;
  payment?: string | null;
  validUntil?: string | null;
  /** Seller names, contacts and address parts: none may appear. */
  privateValues: (string | null | undefined)[];
};

export type PriceSheet = {
  kind: SheetKind;
  reference: string;
  fileName: string;
  /** The cells, row by row, as written to the file. */
  rows: (string | number)[][];
  /** Plain lines for an email body (fixed and send). */
  text: string;
  total: { amount: number; currency: string } | null;
  file: Buffer;
};

export class SheetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SheetRefused";
  }
}

/** The fields that never reach a buyer, whatever their visibility says. */
const SELLER_ONLY = new Set(["seller_price", "max_price", "min_price", "target_price", "buyer_price", "local_recycler"]);

/** Teaser rows only: the facts a buyer may see. */
export function teaserFields(fields: FieldFact[]): FieldFact[] {
  return fields.filter((row) => row.visibility === "teaser" && !SELLER_ONLY.has(row.field_key));
}

const round = (value: number) => (Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10));

/** "Hyundai Kona NMC packs": make and model, chemistry and format, from teaser facts only. No title, no quantity. */
export function lotLabel(key: ProductKey): string {
  const line = key.lines[0];
  if (!line) {
    return "Battery lot";
  }
  if (key.mixed) {
    return `Mixed lot of ${key.lines.length} battery products`;
  }
  // The model as written often repeats the size and format ("Kona 64 kWh pack"); those have their own columns.
  const written = (line.model ?? "").replace(/\b\d+(?:[.,]\d+)?\s*kwh\b/gi, " ").replace(/\b(?:packs?|modules?|cells?)\b/gi, " ").replace(/\s+/g, " ").trim() || null;
  const model = line.make && written ? written.replace(new RegExp(`^${line.make}\\s+`, "i"), "") : written;
  const bits = [line.make, model && model !== line.make ? model : null, line.chemistry ?? key.chemistry, (line.format ?? key.format ?? "").toLowerCase() || null];
  return bits.filter(Boolean).join(" ") || "Battery lot";
}

function kwhText(key: ProductKey): string {
  const line = key.lines[0];
  if (!line || key.mixed) {
    return "";
  }
  if (line.kwhMin != null && line.kwhMax != null) {
    return `${round(line.kwhMin)}-${round(line.kwhMax)}`;
  }
  return line.kwh != null ? round(line.kwh) : "";
}

function sohText(fields: FieldFact[]): string {
  const row = buyerField(fields, "soh");
  const value = (row?.value ?? "").trim();
  return row && value && row.status !== "conflict" ? value.replace(/[.\s]+$/, "") : "";
}

const money = (amount: number, currency: string) =>
  `${currency.toUpperCase()} ${amount.toLocaleString("en-GB", { minimumFractionDigits: Number.isInteger(amount) ? 0 : 2, maximumFractionDigits: 2 })}`;

const day = (iso: string) => {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
};

/** The seller's price as written, so the finished sheet can be checked against it. */
function sellerPriceValues(lots: SheetLot[]): string[] {
  return lots.flatMap((lot) => lot.fields.filter((row) => SELLER_ONLY.has(row.field_key)).map((row) => row.value ?? "")).filter((value) => value.trim());
}

/** Refuses a line whose buyer price is the seller's own price in the same currency and unit. */
function sameAsSeller(lot: SheetLot): boolean {
  const seller = buildProductKey({ fields: lot.fields }).sellerPrice;
  const unit = priceUnit(lot.price.unit);
  return !!seller && !!unit && seller.per === unit && seller.currency === lot.price.currency.toUpperCase() && seller.amount === lot.price.amount;
}

/** Builds one sheet, or refuses with the reason. Deterministic for the same input and reference. */
export function buildPriceSheet(input: SheetInput): PriceSheet {
  if (!input.lots.length) {
    throw new SheetRefused("There is nothing priced to put on the sheet.");
  }
  if (!/^PS-[0-9a-f]{8}$/.test(input.reference)) {
    throw new SheetRefused("The sheet reference must be PS- and eight hex characters.");
  }
  for (const lot of input.lots) {
    if (!(lot.price.amount > 0) || !lot.price.currency) {
      throw new SheetRefused("Every line needs a buyer price.");
    }
    if (sameAsSeller(lot)) {
      throw new SheetRefused("A buyer price is the seller's own price. Record the price to the buyer on the offer.");
    }
  }
  const fixed = input.kind !== "overview";
  const currencies = new Set(input.lots.map((lot) => lot.price.currency.toUpperCase()));
  if (fixed && currencies.size > 1) {
    throw new SheetRefused("The lines are priced in more than one currency, so there is no single total.");
  }
  if (fixed && input.lots.some((lot) => !(lot.quantity != null && lot.quantity > 0))) {
    throw new SheetRefused("Every line on a fixed price sheet needs a quantity.");
  }
  const header: (string | number)[][] = [
    ["ReBattery", SHEET_TITLE[input.kind === "send" ? "fixed" : input.kind]],
    ["Reference", input.reference],
    ["Date", day(input.date)],
    ...(input.validUntil ? [["Valid until", day(input.validUntil)]] : []),
    [],
  ];
  let rows: (string | number)[][];
  let lines: string[] = [];
  // What came from the CRM, as written to the sheet: checked against the seller's details below. The sheet's own labels
  // ("Unit", "Total") and the price unit are fixed words, so they are not, or a seller at "Unit 4" could never be quoted.
  const facts: string[] = [input.delivery ?? "", input.payment ?? ""];
  let total: PriceSheet["total"] = null;
  if (!fixed) {
    rows = [
      ["Lot", "Product", "kWh per unit", "State of health", "Country", "Available", "Price", "Currency", "Per"],
      ...input.lots.map((lot, index) => {
        const fields = teaserFields(lot.fields);
        const key = buildProductKey({ fields });
        facts.push(lotLabel(key), kwhText(key), sohText(fields), publicCountry(buyerField(fields, "location")?.value) ?? "", String(key.units ?? ""), String(lot.price.amount));
        return [
          index + 1, lotLabel(key), kwhText(key), sohText(fields),
          publicCountry(buyerField(fields, "location")?.value) ?? "", key.units ?? "",
          lot.price.amount, lot.price.currency.toUpperCase(), lot.price.unit,
        ];
      }),
    ];
  } else {
    const currency = [...currencies][0];
    let sum = 0;
    rows = [["Line", "Product", "kWh per unit", "Quantity", "Unit", "Unit price", "Line total", "Currency"]];
    input.lots.forEach((lot, index) => {
      const key = buildProductKey({ fields: teaserFields(lot.fields) });
      facts.push(lotLabel(key), kwhText(key), String(lot.price.amount));
      const lineTotal = Math.round(lot.price.amount * lot.quantity! * 100) / 100;
      sum += lineTotal;
      rows.push([index + 1, lotLabel(key), kwhText(key), lot.quantity!, lot.price.unit, lot.price.amount, lineTotal, currency]);
      lines.push(`${lot.quantity!.toLocaleString("en-GB")} x ${lotLabel(key)} at ${money(lot.price.amount, currency)} per ${lot.price.unit}: ${money(lineTotal, currency)}`);
    });
    total = { amount: Math.round(sum * 100) / 100, currency };
    rows.push([], ["Total", "", "", "", "", "", total.amount, currency]);
    if (input.delivery?.trim()) rows.push(["Delivery", input.delivery.trim()]);
    if (input.payment?.trim()) rows.push(["Payment", input.payment.trim()]);
    lines = [
      ...lines,
      `Total: ${money(total.amount, currency)}${input.delivery?.trim() ? `, ${input.delivery.trim()}` : ""}.`,
      ...(input.validUntil ? [`Valid until ${day(input.validUntil)}.`] : []),
      `Price sheet ${input.reference}.`,
    ];
  }
  const all = [...header, ...rows];
  const text = all.map((row) => row.join(" ")).join("\n");
  // The seller's price as written must not appear anywhere; its amount cannot either, because every price cell is a
  // buyer price and one equal to the seller's was refused above. Its words ("per pack") are ordinary sheet words.
  const flat = ` ${`${text}\n${lines.join("\n")}`.toLowerCase().replace(/\s+/g, " ")} `;
  const leaked = firstLeak(facts.join("\n"), input.privateValues)
    ?? sellerPriceValues(input.lots).find((value) => flat.includes(` ${value.toLowerCase().replace(/\s+/g, " ").trim()} `)) ?? null;
  if (leaked) {
    throw new SheetRefused(`The sheet would include ${leaked}, so it was not made.`);
  }
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet(all), SHEET_TITLE[input.kind === "send" ? "fixed" : input.kind].slice(0, 31));
  const file = write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  return { kind: input.kind, reference: input.reference, fileName: `${input.reference}.xlsx`, rows: all, text: lines.join("\n"), total, file };
}
