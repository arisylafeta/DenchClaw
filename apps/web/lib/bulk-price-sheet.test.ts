import { describe, expect, it } from "vitest";
import { read, utils } from "xlsx";
import type { FieldFact } from "./match/product-key";
import { buildPriceSheet, sheetReference, SheetRefused, type SheetKind, type SheetLot } from "./bulk-price-sheet";

const SELLER = "Northern Battery Salvage Ltd";
const CONTACT = "Gareth Pryce";
const EMAIL = "gareth@nbs-salvage.example";
const STREET = "Unit 4 Mill Road Industrial Estate";

// A lot whose seller-only facts are set to values that would be easy to spot, including rows wrongly marked teaser.
const fields = (over: Partial<Record<string, Partial<FieldFact>>> = {}): FieldFact[] => [
  { field_key: "model", value: "Hyundai Kona 64 kWh pack", status: "confirmed", visibility: "teaser" },
  { field_key: "capacity", value: "64 kWh per pack", status: "confirmed", visibility: "teaser" },
  { field_key: "chemistry", value: "NMC", status: "confirmed", visibility: "teaser" },
  { field_key: "format", value: "Packs", status: "confirmed", visibility: "teaser" },
  { field_key: "quantity", value: "24 packs", status: "confirmed", visibility: "teaser" },
  { field_key: "soh", value: "91%", status: "confirmed", visibility: "teaser" },
  { field_key: "location", value: `${STREET}, Leeds, United Kingdom`, status: "confirmed", visibility: "teaser" },
  { field_key: "seller_price", value: "GBP 1,975 per pack", status: "confirmed", visibility: "teaser" },
  { field_key: "local_recycler", value: "Leeds Metals Recovery", status: "confirmed", visibility: "teaser" },
  { field_key: "test_data", value: `Report by ${CONTACT}`, status: "confirmed", visibility: "after_nda" },
].map((row) => ({ ...row, ...(over[row.field_key] ?? {}) }));

const lot = (o: Partial<SheetLot> = {}): SheetLot => ({ fields: fields(), price: { amount: 2400, currency: "GBP", unit: "pack" }, quantity: 12, ...o });
const privateValues = [SELLER, CONTACT, EMAIL, "Gareth", "Pryce", STREET, "Mill Road"];
const sheet = (kind: SheetKind, lots: SheetLot[] = [lot()], o: Record<string, unknown> = {}) => buildPriceSheet({
  kind, reference: "PS-0a1b2c3d", date: "2026-11-12", lots, delivery: "DAP buyer's site, Rotterdam", payment: "100% before collection",
  validUntil: "2026-12-03", privateValues, ...o,
});

/** Every cell of the stored file, read back with the same library a buyer's spreadsheet app would use. */
const cells = (file: Buffer) => {
  const book = read(file, { type: "buffer" });
  return utils.sheet_to_json<unknown[]>(book.Sheets[book.SheetNames[0]], { header: 1 }).flat().map(String).join(" | ");
};

describe("price sheets", () => {
  it("never shows a seller-only field, in any of the three shapes, in the file or the email lines", () => {
    for (const kind of ["overview", "fixed", "send"] as const) {
      const made = sheet(kind);
      const everywhere = `${cells(made.file)}\n${made.text}\n${made.rows.flat().join(" ")}`;
      for (const secret of [SELLER, CONTACT, EMAIL, "Gareth", STREET, "Mill Road", "Unit 4", "1,975", "1975", "Leeds Metals", "Leeds"]) {
        expect(everywhere, `${kind}: ${secret}`).not.toContain(secret);
      }
      // The buyer price is there; the seller's is not.
      expect(everywhere).toContain("2400");
      if (kind === "overview") expect(everywhere).toContain("United Kingdom");
    }
  });

  it("refuses a sheet that would carry the seller's name or price, whatever the field says", () => {
    const named = lot({ fields: fields({ model: { value: `${SELLER} Kona pack` } }) });
    expect(() => sheet("overview", [named])).toThrow(SheetRefused);
    expect(() => sheet("fixed", [lot()], { delivery: `EXW ${STREET}` })).toThrow(/would include/);
    expect(() => sheet("fixed", [lot({ price: { amount: 1975, currency: "GBP", unit: "pack" } })])).toThrow(/seller's own price/);
  });

  it("overview: one row per lot with teaser facts, kWh, health, country, available and the buyer price", () => {
    const second = lot({ fields: fields({ model: { value: "Nissan Leaf 40 kWh pack" }, capacity: { value: "40 kWh per pack" }, soh: { visibility: "after_nda" }, location: { value: "Lyon, France" } }), price: { amount: 52, currency: "EUR", unit: "kWh" } });
    const made = sheet("overview", [lot(), second]);
    const table = made.rows.slice(made.rows.findIndex((row) => row[0] === "Lot"));
    expect(table).toEqual([
      ["Lot", "Product", "kWh per unit", "State of health", "Country", "Available", "Price", "Currency", "Per"],
      [1, "Hyundai Kona NMC packs", "64", "91%", "United Kingdom", 24, 2400, "GBP", "pack"],
      // Health that is not cleared for a buyer is left blank, not guessed.
      [2, "Nissan Leaf NMC packs", "40", "", "France", 24, 52, "EUR", "kWh"],
    ]);
    expect(made.total).toBeNull();
  });

  it("fixed and send: quantity, unit price, line totals, total, delivery and last day", () => {
    const made = sheet("send", [lot(), lot({ quantity: 3, price: { amount: 2350, currency: "GBP", unit: "pack" } })]);
    expect(made.total).toEqual({ amount: 35850, currency: "GBP" });
    expect(made.rows).toContainEqual([1, "Hyundai Kona NMC packs", "64", 12, "pack", 2400, 28800, "GBP"]);
    expect(made.rows).toContainEqual(["Total", "", "", "", "", "", 35850, "GBP"]);
    expect(made.rows).toContainEqual(["Delivery", "DAP buyer's site, Rotterdam"]);
    expect(made.rows).toContainEqual(["Valid until", "3 December 2026"]);
    expect(made.text).toBe([
      "12 x Hyundai Kona NMC packs at GBP 2,400 per pack: GBP 28,800",
      "3 x Hyundai Kona NMC packs at GBP 2,350 per pack: GBP 7,050",
      "Total: GBP 35,850, DAP buyer's site, Rotterdam.",
      "Valid until 3 December 2026.",
      "Price sheet PS-0a1b2c3d.",
    ].join("\n"));
    expect(made.fileName).toBe("PS-0a1b2c3d.xlsx");
    expect(cells(made.file)).toContain("PS-0a1b2c3d");
  });

  it("refuses a fixed sheet without quantities or with two currencies", () => {
    expect(() => sheet("fixed", [lot({ quantity: null })])).toThrow(/needs a quantity/);
    expect(() => sheet("fixed", [lot(), lot({ price: { amount: 2000, currency: "EUR", unit: "pack" } })])).toThrow(/more than one currency/);
    expect(() => sheet("fixed", [])).toThrow(/nothing priced/);
  });

  it("uses references of a prefix and random hex, never a running number", () => {
    const refs = Array.from({ length: 200 }, () => sheetReference());
    expect(refs.every((ref) => /^PS-[0-9a-f]{8}$/.test(ref))).toBe(true);
    expect(new Set(refs).size).toBe(refs.length);
    const numbers = refs.map((ref) => parseInt(ref.slice(3), 16));
    const steps = numbers.slice(1).map((n, i) => n - numbers[i]);
    expect(steps.filter((step) => step === 1).length).toBeLessThan(2);
    expect(() => sheet("fixed", [lot()], { reference: "PS-0001" })).toThrow(/eight hex/);
  });
});
