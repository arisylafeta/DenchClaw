import { describe, expect, it } from "vitest";
import { buildProductKey, type FieldFact } from "./product-key";
import { buildOfferEmail, buyerWant, firstName, OfferEmailRefused, priceLine, productPhrase, publicPlace, testStatusLine } from "./offer-email";

const fields = (values: Record<string, string>, status: Record<string, string> = {}): FieldFact[] =>
  Object.entries(values).map(([field_key, value]) => ({ field_key, value, status: status[field_key] ?? "confirmed" }));

const key = (values: Record<string, string>, status: Record<string, string> = {}) =>
  buildProductKey({ fields: fields(values, status), title: "Lot" });

const lot = key({
  model: "Samsung SDI 50E", capacity: "50 kWh per pack", chemistry: "NMC", format: "Packs", quantity: "40 packs",
  seller_price: "EUR 40 per kWh", test_data: "BMS report supplied", soh: "88%",
});

const buyer = {
  wants: "Samsung 50E packs\nNMC modules",
  products: [
    { make: "Samsung", platform: "Samsung SDI 50E", kwh: [50], chemistry: "NMC", format: "packs", status: "asked" },
    { make: "BMW", kwh: [26], chemistry: "NMC", format: "packs", status: "asked" },
  ],
};

describe("the supply offer", () => {
  it("merges the buyer's matching want, the lot facts and the firm price", () => {
    const email = buildOfferEmail({ kind: "supply_offer", key: lot, fields: fields({ test_data: "BMS report supplied", soh: "88%" }), recipientFirstName: "Sam", location: "Rotterdam, Netherlands", buyer });
    expect(email.subject).toBe("40 x 50 kWh NMC packs");
    expect(email.body).toContain("Hi Sam,");
    expect(email.body).toContain("You were looking for Samsung SDI 50E 50 kWh NMC packs.");
    expect(email.body).toContain("We have 40 x 50 kWh NMC packs available in Rotterdam, Netherlands.");
    expect(email.body).toContain("Test data: BMS report supplied.");
    expect(email.body).toContain("State of health: 88%.");
    expect(email.body).toContain("The price is EUR 40 per kWh.");
    expect(email.body).toContain("Is it still of interest?");
    expect(email.body.trimEnd().endsWith("Best,\nAlex")).toBe(true);
  });

  it("asks for the spec sheet when the buyer's own want is not held", () => {
    const email = buildOfferEmail({ kind: "supply_offer", key: lot, fields: [], recipientFirstName: null, buyer: null });
    expect(email.body).toContain("Hi there,");
    expect(email.body).toContain("Would you like the full spec sheet?");
    expect(email.body).not.toContain("You were looking for");
  });

  it("writes 'price on request' unless the price is firm", () => {
    const unconfirmed = key({ capacity: "50 kWh per pack", format: "Packs", quantity: "40 packs", seller_price: "EUR 40 per kWh" }, { seller_price: "unverified" });
    expect(priceLine(unconfirmed)).toBe("Price on request.");
    expect(buildOfferEmail({ kind: "supply_offer", key: unconfirmed, fields: [], buyer: null }).body).toContain("Price on request.");
    expect(priceLine(lot)).toBe("The price is EUR 40 per kWh.");
  });

  it("never turns a missing test record into 'tested'", () => {
    const missing = buildOfferEmail({ kind: "supply_offer", key: lot, fields: fields({ test_data: "" }, { test_data: "missing" }), buyer: null });
    expect(missing.body).toContain("No test data recorded.");
    expect(missing.body.toLowerCase()).not.toContain("tested");
    const disputed = buildOfferEmail({ kind: "supply_offer", key: lot, fields: fields({ test_data: "BMS report" }, { test_data: "conflict" }), buyer: null });
    expect(disputed.body).toContain("The test data on this lot is disputed.");
    expect(disputed.body).not.toContain("BMS report");
  });

  it("quotes a recorded test status exactly as written", () => {
    expect(testStatusLine(fields({ test_data: "Capacity test by supplier, Sept 2026" }))).toBe("Test data: Capacity test by supplier, Sept 2026.");
  });
});

describe("the request stock ask", () => {
  it("asks one question about supply and never states a price", () => {
    const email = buildOfferEmail({ kind: "request_stock", key: lot, fields: [], recipientFirstName: "Cameron", location: "Leeds, United Kingdom" });
    expect(email.subject).toBe("Stock enquiry: 40 x 50 kWh NMC packs");
    expect(email.body).toContain("We're looking for 40 x 50 kWh NMC packs in Leeds, United Kingdom.");
    expect(email.body).toContain("Do you have anything that fits?");
    expect(email.body).not.toMatch(/EUR|GBP|price|per kWh/i);
    expect((email.body.match(/\?/g) ?? []).length).toBe(1);
  });
});

describe("the chase", () => {
  it("is short, reuses the earlier subject and asks the same question once", () => {
    const email = buildOfferEmail({ kind: "chase", key: lot, fields: [], recipientFirstName: "Sam", previousSubject: "40 x 50 kWh NMC packs" });
    expect(email.subject).toBe("Re: 40 x 50 kWh NMC packs");
    expect(email.body).toContain("Following up on the note I sent about 40 x 50 kWh NMC packs.");
    expect(email.body).toContain("Is it still of interest?");
    expect(email.body.split("\n\n")).toHaveLength(4);
    expect(email.body).not.toMatch(/EUR|price/i);
  });
});

describe("privacy", () => {
  const seller = { party: "Battery Partners Ltd", contact: "seller@batterypartners.example", person: "Daan" };

  it("refuses to write the other party's name", () => {
    // The buyer's dossier text can mention who they buy from; quoting it must not put the seller in the email.
    expect(() => buildOfferEmail({
      kind: "supply_offer", key: lot, fields: [],
      buyer: { wants: "Battery Partners Ltd packs" },
      privateValues: [seller.party, seller.contact, seller.person],
    })).toThrow(OfferEmailRefused);
  });

  it("keeps town and country but never the street or unit", () => {
    const email = buildOfferEmail({
      kind: "supply_offer", key: lot, fields: [], location: "Unit 4, 12 Foo Street, Rotterdam, Netherlands",
      privateValues: [seller.party, seller.contact],
    });
    expect(email.body).toContain("in Rotterdam, Netherlands");
    expect(email.body).not.toContain("Foo Street");
    expect(email.body).not.toContain("Unit 4");
    expect(email.body).not.toContain("12 ");
  });

  it("drops a location that is only an address", () => {
    expect(publicPlace("Unit 7, 88 Industrial Estate Road")).toBeNull();
    expect(publicPlace("12 Foo Street, Leeds")).toBe("Leeds");
    expect(publicPlace(null)).toBeNull();
    expect(buildOfferEmail({ kind: "supply_offer", key: lot, fields: [], location: "Unit 7, 88 Industrial Estate Road", buyer: null }).body)
      .toContain("We have 40 x 50 kWh NMC packs available.");
  });

  it("does not treat a generic trade word as the other party's name", () => {
    const email = buildOfferEmail({
      kind: "supply_offer", key: lot, fields: [], buyer: null,
      privateValues: ["Rotterdam Battery Recycling BV"],
    });
    expect(email.body).toContain("packs");
  });
});

describe("the merge inputs", () => {
  it("falls back to the derived wants line without its history note", () => {
    expect(buyerWant({ wants: "NMC packs (asked Sept 2026)" }, lot)).toBe("NMC packs");
    expect(buyerWant({ wants: "", products: [] }, lot)).toBeNull();
  });

  it("prefers the dossier product that matches the lot over an unrelated one", () => {
    expect(buyerWant(buyer, lot)).toBe("Samsung SDI 50E 50 kWh NMC packs");
    expect(buyerWant({ products: [{ make: "BMW", kwh: [26], chemistry: "NMC", format: "packs" }] }, lot)).toBeNull();
  });

  it("accepts a first name only when it is one", () => {
    expect(firstName("Sam")).toBe("Sam");
    expect(firstName("sam smith")).toBe("Sam");
    expect(firstName("sam@buyer.example")).toBeNull();
    expect(firstName("Warehouse 4")).toBeNull();
    expect(firstName(null)).toBeNull();
  });

  it("describes the product from the key alone", () => {
    expect(productPhrase(lot)).toBe("40 x 50 kWh NMC packs");
    expect(productPhrase(buildProductKey({ fields: [], title: "Lot" }))).toBeNull();
  });
});
