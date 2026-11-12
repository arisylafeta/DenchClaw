import { describe, expect, it } from "vitest";
import { buildProductKey, type FieldFact } from "./product-key";
import {
  buildOfferEmail, buyerWant, firstName, OfferEmailRefused, priceLine, productPhrase, publicCountry, publicPlace, testStatusLine,
  type RequestFacts,
} from "./offer-email";

/** A listing's field rows. Visibility defaults to `teaser`; a key in `visibility` overrides it. */
const fields = (
  values: Record<string, string>,
  status: Record<string, string> = {},
  visibility: Record<string, string | null> = {},
): FieldFact[] =>
  Object.entries(values).map(([field_key, value]) => ({
    field_key, value, status: status[field_key] ?? "confirmed",
    visibility: field_key in visibility ? visibility[field_key] : "teaser",
  }));

const key = (values: Record<string, string>, status: Record<string, string> = {}) =>
  buildProductKey({ fields: fields(values, status), title: "Lot" });

const listing = {
  model: "Samsung SDI 50E", capacity: "50 kWh per pack", chemistry: "NMC", format: "Packs", quantity: "40 packs",
  seller_price: "EUR 40 per kWh", test_data: "BMS report supplied", soh: "88%", location: "Rotterdam, Netherlands",
};

const lot = key(listing);

const buyer = {
  wants: "Samsung 50E packs\nNMC modules",
  products: [
    { make: "Samsung", platform: "Samsung SDI 50E", kwh: [50], chemistry: "NMC", format: "packs", status: "asked" },
    { make: "BMW", kwh: [26], chemistry: "NMC", format: "packs", status: "asked" },
  ],
};

const supply = (over: Partial<Parameters<typeof buildOfferEmail>[0]> = {}) => buildOfferEmail({
  kind: "supply_offer", key: lot, fields: fields(listing), recipientFirstName: "Sam", location: listing.location, buyer, ...over,
});

describe("the supply offer", () => {
  it("merges the buyer's matching want and the lot facts a buyer may see", () => {
    const email = supply();
    expect(email.subject).toBe("40 x 50 kWh NMC packs");
    expect(email.body).toContain("Hi Sam,");
    expect(email.body).toContain("You were looking for Samsung SDI 50E 50 kWh NMC packs.");
    expect(email.body).toContain("We have 40 x 50 kWh NMC packs available in Rotterdam, Netherlands.");
    expect(email.body).toContain("Test data: BMS report supplied.");
    expect(email.body).toContain("State of health: 88%.");
    expect(email.body).toContain("Is it still of interest?");
    expect(email.body.trimEnd().endsWith("Best,\nAlex")).toBe(true);
  });

  it("asks for the spec sheet when the buyer's own want is not held", () => {
    const email = supply({ fields: [], recipientFirstName: null, buyer: null });
    expect(email.body).toContain("Hello,");
    expect(email.body).toContain("Would you like the full spec sheet?");
    expect(email.body).not.toContain("You were looking for");
  });

  it("never turns a missing test record into 'tested'", () => {
    const missing = supply({ fields: fields({ test_data: "" }, { test_data: "missing" }) });
    expect(missing.body).toContain("No test data recorded.");
    expect(missing.body.toLowerCase()).not.toContain("tested");
    const disputed = supply({ fields: fields({ test_data: "BMS report" }, { test_data: "conflict" }) });
    expect(disputed.body).toContain("The test data on this lot is disputed.");
    expect(disputed.body).not.toContain("BMS report");
  });

  it("quotes a recorded test status exactly as written", () => {
    expect(testStatusLine(fields({ test_data: "Capacity test by supplier, Sept 2026" })))
      .toBe("Test data: Capacity test by supplier, Sept 2026.");
  });
});

// The blocker: ReBattery buys at the seller's price and sells on at its own. The buyer email may never state it,
// whatever the listing records, and only fields cleared as `teaser` may appear at all.
describe("what a buyer may see", () => {
  it("never writes the seller's price, even when the listing records a firm one", () => {
    expect(lot.sellerPrice?.amount).toBe(40);
    const email = supply();
    expect(email.body).toContain("Price on request.");
    expect(email.body).not.toMatch(/EUR|GBP|USD|per kWh/i);
    expect(email.body).not.toContain("The price is");
    expect(priceLine()).toBe("Price on request.");
  });

  it("writes the price line even when the listing records no price at all", () => {
    const noPrice = key({ capacity: "50 kWh per pack", format: "Packs", quantity: "40 packs" });
    expect(buildOfferEmail({ kind: "supply_offer", key: noPrice, fields: [], buyer: null }).body).toContain("Price on request.");
  });

  it("omits a state of health and test data the buyer may not see, rather than calling it tested", () => {
    const email = supply({
      fields: fields(
        { soh: "88%", test_data: "BMS report", location: "Rotterdam, Netherlands" },
        {},
        { soh: "after_nda", test_data: "after_loi" },
      ),
    });
    expect(email.body).not.toContain("State of health");
    expect(email.body).not.toContain("88%");
    expect(email.body).not.toContain("Test data");
    expect(email.body).not.toContain("BMS report");
    expect(email.body).not.toContain("No test data recorded.");
  });

  it("omits any field with no visibility at all, and one marked never", () => {
    const email = supply({ fields: fields({ soh: "88%", test_data: "BMS report" }, {}, { soh: null, test_data: "never" }) });
    expect(email.body).not.toContain("State of health");
    expect(email.body).not.toContain("Test data");
  });

  it("includes a teaser field", () => {
    const email = supply({ fields: fields({ soh: "88%", test_data: "BMS report supplied" }, {}, { soh: "teaser", test_data: "teaser" }) });
    expect(email.body).toContain("State of health: 88%.");
    expect(email.body).toContain("Test data: BMS report supplied.");
  });

  it("drops the place line unless the location is teaser", () => {
    expect(supply().body).toContain("available in Rotterdam, Netherlands.");
    const hidden = supply({ fields: fields({ location: "Rotterdam, Netherlands" }, {}, { location: "after_loi" }) });
    expect(hidden.body).toContain("available.");
    expect(hidden.body).not.toContain("Rotterdam");
    const none = supply({ fields: [], location: "Rotterdam, Netherlands" });
    expect(none.body).not.toContain("Rotterdam");
  });
});

describe("a priced supply offer", () => {
  it("carries the price sheet's lines in place of price on request, built from the offer's price", () => {
    const email = supply({ priceLines: "40 x Samsung NMC packs at GBP 2,400 per pack: GBP 96,000\nPrice sheet PS-0a1b2c3d." });
    expect(email.body).toContain("40 x Samsung NMC packs at GBP 2,400 per pack: GBP 96,000\nPrice sheet PS-0a1b2c3d.");
    expect(email.body).not.toContain("Price on request.");
    expect(email.body).toContain("Test data: BMS report supplied.");
  });

  it("still refuses copy that would carry the seller's price as written", () => {
    expect(() => supply({ priceLines: "Seller asks EUR 40 per kWh" })).toThrow(OfferEmailRefused);
  });
});

describe("the request stock ask", () => {
  it("asks one question about supply and never states a price", () => {
    const email = buildOfferEmail({ kind: "request_stock", key: lot, fields: [], recipientFirstName: "Cameron", location: "Leeds, United Kingdom" });
    expect(email.subject).toBe("Stock enquiry: 40 x 50 kWh NMC packs");
    expect(email.body).toContain("We're looking for 40 x 50 kWh NMC packs in United Kingdom.");
    expect(email.body).toContain("Do you have anything that fits?");
    expect(email.body).not.toMatch(/EUR|GBP|price|per kWh/i);
    expect((email.body.match(/\?/g) ?? []).length).toBe(1);
  });

  it("never names the buyer, their company, their ceiling or their town", () => {
    const email = buildOfferEmail({
      kind: "request_stock", key: lot, location: "Leeds, United Kingdom", recipientFirstName: "Cameron",
      fields: fields({ soh: "80%", max_price: "EUR 45 per kWh", seller_price: "EUR 40 per kWh" }),
      buyer: { wants: "Acme Recycling Ltd, 52 kWh packs" },
      privateValues: ["Acme Recycling Ltd", "purchasing@acme.example", "Leeds"],
    });
    expect(email.body).toContain("in United Kingdom.");
    for (const leak of ["Acme", "Leeds", "45", "EUR", "acme.example"]) {
      expect(email.body).not.toContain(leak);
    }
    expect(email.body).toContain("The buyer is asking for 80% state of health.");
  });

  it("states the state of health the buyer asked for, and drops a disputed one", () => {
    const email = buildOfferEmail({ kind: "request_stock", key: lot, fields: fields({ soh: "80%" }), buyer: null });
    expect(email.body).toContain("The buyer is asking for 80% state of health.");
    const disputed = buildOfferEmail({ kind: "request_stock", key: lot, fields: fields({ soh: "80%" }, { soh: "conflict" }) });
    expect(disputed.body).not.toContain("state of health");
  });
});

describe("the request stock ask, from the request's own facts", () => {
  // The 50E request as crm_bulk_demand holds it: no field rows, the facts on the demand row.
  const request: RequestFacts = {
    productFamily: "Samsung 50E-equivalent 21700 cells", volume: 500_000, volumeUnit: "cells", quantity: "500,000",
    neededBy: "2027-01-31", spec: { formats: ["Cells"], cell_makers: ["Samsung SDI"], min_soh: 90 }, maxPrice: 1,
  };
  const ask = (over: Partial<Parameters<typeof buildOfferEmail>[0]> = {}) => buildOfferEmail({
    kind: "request_stock", key: buildProductKey({ fields: [], title: "500,000x Samsung 50E 21700 Cells" }), fields: [],
    location: "Poland (delivery site tbc)", recipientFirstName: "ro cell", request,
    privateValues: ["Battery Partners", "Battery Partners Ltd", "buyer@batterypartners.example"], ...over,
  });

  it("states the product, the quantity and the timing", () => {
    const email = ask({ recipientFirstName: null });
    expect(email.subject).toBe("Stock enquiry: 500,000 x Samsung 50E-equivalent 21700 cells");
    expect(email.body).toContain("We're looking for 500,000 x Samsung 50E-equivalent 21700 cells in Poland.");
    expect(email.body).toContain("They're needed by 31 January 2027.");
    expect(email.body).toContain("We need at least 90% state of health.");
    expect(email.body).toContain("Do you have anything that fits? If so, how many do you have, and when could they ship?");
  });

  it("puts an energy volume in brackets, never 'N x' (btd_8f67e71e: 1,000 kWh of cells or packs)", () => {
    const email = ask({ recipientFirstName: null, request: { productFamily: "LFP prismatic 100Ah cells / 50kWh packs", volume: 1000, volumeUnit: "kWh", neededBy: null, spec: {} } });
    expect(email.subject).toBe("Stock enquiry: LFP prismatic 100Ah cells / 50kWh packs (1,000 kWh)");
    expect(email.body).toContain("We're looking for LFP prismatic 100Ah cells / 50kWh packs (1,000 kWh) in Poland.");
    expect(email.subject).not.toContain(" x ");
  });

  it("asks when they could ship when the request has no date, and falls back to the spec without a product family", () => {
    const email = ask({ request: { ...request, productFamily: null, neededBy: null, spec: { formats: ["Cells"], cell_makers: ["Samsung SDI"] } } });
    expect(email.body).toContain("We're looking for 500,000 x Samsung SDI cells in Poland.");
    expect(email.body).not.toContain("needed by");
    expect(email.body).toContain("when could they ship?");
  });

  it("never names the buyer, their company or their ceiling", () => {
    const email = ask({ recipientFirstName: null });
    for (const leak of ["Battery Partners", "batterypartners", "1.00", "EUR", "€", "tbc"]) {
      expect(email.body).not.toContain(leak);
      expect(email.subject).not.toContain(leak);
    }
    // A product family that names the buyer is refused rather than sent.
    expect(() => ask({ request: { ...request, productFamily: "Battery Partners 50E cells" } })).toThrow(OfferEmailRefused);
    // So is copy that would carry the ceiling.
    expect(() => ask({ request: { ...request, productFamily: "Samsung 50E at EUR 1.00 per cell" } })).toThrow(OfferEmailRefused);
  });

  it("greets a person named after their company with Hello", () => {
    expect(firstName("ro cell", ["Ro Cell"])).toBeNull();
    expect(firstName("Ro  Cell", ["RO CELL"])).toBeNull();
    expect(firstName("Michael Lee", ["Ancoo Technologies"])).toBe("Michael");
    expect(ask({ recipientFirstName: firstName("ro cell", ["Ro Cell"]) }).body.startsWith("Hello,\n\n")).toBe(true);
  });

  it("chases a request with its own product", () => {
    const email = buildOfferEmail({
      kind: "chase", key: buildProductKey({ fields: [], title: "Lot" }), fields: [], side: "demand", request,
      previousSubject: "Stock enquiry: 500,000 x Samsung 50E-equivalent 21700 cells",
    });
    expect(email.body).toContain("Following up on the note I sent about 500,000 x Samsung 50E-equivalent 21700 cells.");
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

  it("asks the stock question again on a request", () => {
    const email = buildOfferEmail({ kind: "chase", key: lot, fields: [], side: "demand", previousSubject: "Stock enquiry: 40 x 50 kWh NMC packs" });
    expect(email.body).toContain("Do you have anything that fits?");
    expect(email.body).not.toContain("still of interest");
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
    const email = supply({
      fields: fields({ location: "Unit 4, 12 Foo Street, Rotterdam, Netherlands" }),
      location: "Unit 4, 12 Foo Street, Rotterdam, Netherlands",
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
    expect(supply({ fields: [], location: "Unit 7, 88 Industrial Estate Road" }).body)
      .toContain("We have 40 x 50 kWh NMC packs available.");
  });

  it("reduces a request location to its country", () => {
    expect(publicCountry("Leeds, United Kingdom")).toBe("United Kingdom");
    expect(publicCountry("Rotterdam, Netherlands")).toBe("Netherlands");
    expect(publicCountry("Rotterdam")).toBe("Rotterdam");
    expect(publicCountry("Unit 4, Foo Street")).toBeNull();
    expect(publicCountry(null)).toBeNull();
  });

  it("does not treat a generic trade word as the other party's name", () => {
    const email = supply({ fields: [], buyer: null, privateValues: ["Rotterdam Battery Recycling BV"] });
    expect(email.body).toContain("packs");
  });

  // A company name of three letters was skipped entirely, so a dossier line that named it went out. It is matched as
  // a whole word now, and words that the copy itself uses stay ordinary copy.
  it("refuses a three-letter company name on its own or inside a longer name", () => {
    expect(() => supply({ fields: [], buyer: { wants: "ABZ packs" }, privateValues: ["ABZ"] })).toThrow(/\bABZ\b/);
    expect(() => supply({ fields: [], buyer: { wants: "abz packs" }, privateValues: ["ABZ Metals"] })).toThrow(/\bABZ\b/);
  });

  it("matches a short name as a whole word, not inside a longer one", () => {
    expect(() => supply({ fields: [], buyer: { wants: "ABZCO packs" }, privateValues: ["ABZ"] })).not.toThrow();
  });

  it("keeps ordinary words out of the short-name check", () => {
    expect(() => supply({ fields: [], buyer: null, privateValues: ["the", "you", "our", "per"] })).not.toThrow();
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
