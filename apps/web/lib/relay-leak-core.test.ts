import { describe, expect, it } from "vitest";
import { leaks, leakSentence, moneyMentions, readNumber, type LeakFacts } from "./relay-leak-core";

const FACTS: LeakFacts = {
  suppliers: [
    { name: "Parts Roberto S.r.l.", email: "vendite@partsroberto.it", costs: [4500] },
    { name: "Broekhuis Autogroep B.V.", email: "inkoop@broekhuis.nl", costs: [4000] },
    { name: "Green Energy Ltd", email: "sales@greenenergy.co.uk", costs: [] },
    { name: "Tesla Parts Direct", email: "tpd.sales@gmail.com", costs: [3329.99] },
  ],
  buyer: { name: "Ben Bament", company: "Silent Classics", email: "ben@silentclassics.co.uk", prices: [5350, 3610] },
};

const kinds = (body: string, toKind: "buyer" | "supplier" | "other" = "buyer") => leaks({ toKind, body }, FACTS).map((l) => `${l.kind}:${l.found}`);

describe("buyer emails", () => {
  it("passes a clean offer", () => {
    expect(kinds("Hi Ben,\n\nWe've got a 2020 VW ID.3 62 kWh pack at £5,350 delivered to BA2, and a 58 kWh at £3,610.\n\nBest,\nAlex")).toEqual([]);
  });

  it("catches a supplier named in passing, with or without its legal ending", () => {
    expect(kinds("The pack is with Parts Roberto in Italy.")).toEqual(["supplier_name:Parts Roberto"]);
    expect(kinds("Our partner parts-roberto can ship next week.")).toEqual(["supplier_name:parts-roberto"]);
  });

  it("catches a company by its telling lead word alone, accents or not", () => {
    expect(kinds("The Dutch pack from Broekhuis has an 86% health report.")).toEqual(["supplier_name:Broekhuis"]);
    expect(kinds("Brökhuis is fine.")).toEqual([]);  // a different word
  });

  it("does not flag everyday words that make up a company name", () => {
    expect(kinds("We back green energy and second-life storage.")).toEqual([]);
    expect(kinds("A Tesla Model 3 pack, parts tested, sold direct.")).toEqual([]);
    expect(kinds("Green Energy have the pack.")).toEqual(["supplier_name:Green Energy"]);
  });

  it("catches a supplier's address or company domain, never a free-mail one", () => {
    expect(kinds("Write to vendite@partsroberto.it for photos.")).toEqual(["supplier_email:vendite@partsroberto.it"]);
    expect(kinds("See www.partsroberto.it/id3 for the listing.")).toEqual(["supplier_email:partsroberto.it"]);
    expect(kinds("Send it to my gmail.com address.")).toEqual([]);
  });

  it("catches a cost written as money in any common form", () => {
    expect(kinds("They want £4,500 for it.")).toEqual(["cost:£4,500"]);
    expect(kinds("Asking 4.500,00 € collected.")).toEqual(["cost:4.500,00 €"]);
    expect(kinds("About EUR 4000 ex works.")).toEqual(["cost:EUR 4000"]);
    expect(kinds("Around 4.5k GBP.")).toEqual(["cost:4.5k GBP"]);
    expect(kinds("Listed at £3,329.99.")).toEqual(["cost:£3,329.99"]);
  });

  it("does not take counts or other amounts for a cost", () => {
    expect(kinds("4,500 cells in 4000 kg, 62 kWh.")).toEqual([]);
    expect(kinds("£4,500 2 packs")).toEqual(["cost:£4,500"]);
    expect(kinds("£45,000 for the lot.")).toEqual([]);
  });
});

describe("supplier emails", () => {
  it("passes a clean ask", () => {
    expect(kinds("Hi Roberto,\n\nIs the ID.3 62 kWh (part 0Z1915911M) still available? Could you send the VIN, mileage and your best price delivered to Somerset?\n\nThanks,\nAlex", "supplier")).toEqual([]);
  });

  it("catches the buyer's name, surname, company and address", () => {
    expect(kinds("It's for Ben Bament at Silent Classics.", "supplier")).toEqual(["buyer_name:Ben Bament", "buyer_company:Silent Classics"]);
    expect(kinds("Mr Bament needs it by Friday.", "supplier")).toEqual(["buyer_name:Bament"]);
    expect(kinds("Deliver to ben@silentclassics.co.uk's workshop.", "supplier")).toEqual(["buyer_email:ben@silentclassics.co.uk"]);
  });

  it("leaves a first name, Alex's own sign-off and supplier facts alone", () => {
    expect(kinds("Thanks Ben for the photos.\n\nBest,\nAlex", "supplier")).toEqual([]);
    expect(kinds("Is £4,500 still your price, Parts Roberto?", "supplier")).toEqual([]);
  });

  it("catches what the buyer pays", () => {
    expect(kinds("Our customer pays £5,350, so we need it under that.", "supplier")).toEqual(["buyer_price:£5,350"]);
    expect(kinds("Could you do it for £3,000?", "supplier")).toEqual([]);
  });
});

describe("other emails", () => {
  it("are not checked: a transport partner needs the towns", () => {
    expect(kinds("Collect from Parts Roberto, Bologna, deliver to Ben Bament, BA2 0BS.", "other")).toEqual([]);
  });

  it("skips a supplier who is the buyer too", () => {
    const facts: LeakFacts = { suppliers: [{ name: "Ben Bament", email: "ben@silentclassics.co.uk", costs: [] }], buyer: FACTS.buyer };
    expect(leaks({ toKind: "buyer", body: "Hi Ben Bament" }, facts)).toEqual([]);
  });

  it("works with no buyer known", () => {
    expect(leaks({ toKind: "supplier", body: "Hi" }, { suppliers: [], buyer: null })).toEqual([]);
  });
});

describe("money", () => {
  it("reads numbers the way people write them", () => {
    expect(readNumber("4,500")).toBe(4500);
    expect(readNumber("4.500,00")).toBe(4500);
    expect(readNumber("4 500")).toBe(4500);
    expect(readNumber("12.50")).toBe(12.5);
    expect(readNumber("1,234,567.89")).toBe(1234567.89);
  });

  it("finds money in a sentence", () => {
    expect(moneyMentions("£85/kWh, €30k, 2 pounds").map((m) => m.value)).toEqual([85, 30000, 2]);
  });

  it("says it in one line", () => {
    const problems = leaks({ toKind: "supplier", body: "For Ben Bament, who pays £5,350." }, FACTS);
    expect(leakSentence("Parts Roberto", problems)).toBe("The email to Parts Roberto names the buyer (Ben Bament), and shows what the buyer pays (£5,350).");
  });
});

describe("lone words", () => {
  const facts: LeakFacts = { suppliers: [{ name: "Silverlake Recycling Ltd", email: null, costs: [] }, { name: "Surplus Autos (Groupe Surplus Recyclage)", email: null, costs: [] }], buyer: null };
  const found = (body: string) => leaks({ toKind: "buyer", body }, facts).map((l) => l.found);

  it("takes a lead word only as a proper noun mid-sentence", () => {
    expect(found("The 58 kWh pack from Silverlake is ready.")).toEqual(["Silverlake"]);
    expect(found("Silverlake. That's who has it.")).toEqual([]);
    expect(found("We sell silverlake grey paint too.")).toEqual([]);
  });

  it("never takes an everyday word for a company (found in Relay's sent emails)", () => {
    expect(found("We supply surplus and second-life batteries globally, so it'd be great to know.")).toEqual([]);
    expect(found("We bought from Surplus Autos last year.")).toEqual(["Surplus Autos"]);
  });
});
