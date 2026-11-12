import { describe, expect, it } from "vitest";
import { isPaidStage, missingPaidFacts, missingPaidMessage, readPaidFacts } from "./bulk-offer-paid";

const all = { paid_on: "2026-12-03", paid_amount: 18000, paid_currency: "EUR", quantity: 48, take_gbp: 1500 };

describe("paid facts", () => {
  it("are needed only for Paid and Complete", () => {
    expect(["paid", "complete"].map(isPaidStage)).toEqual([true, true]);
    for (const stage of ["candidate", "offered", "negotiating", "contract_out", "signed", "invoiced", "declined", "lost", null]) {
      expect(missingPaidFacts(stage, {})).toEqual([]);
    }
  });
  it("lists every missing or blank fact, in the order the form asks", () => {
    expect(missingPaidFacts("paid", {})).toEqual(["paid_on", "paid_amount", "paid_currency", "quantity", "take_gbp"]);
    expect(missingPaidFacts("complete", { ...all, paid_currency: " ", take_gbp: null })).toEqual(["paid_currency", "take_gbp"]);
    expect(missingPaidFacts("paid", all)).toEqual([]);
    // Zero is a real take (a deal we waived the fee on); only missing counts as missing.
    expect(missingPaidFacts("paid", { ...all, take_gbp: 0 })).toEqual([]);
  });
  it("names what is missing in plain words", () => {
    expect(missingPaidMessage("paid", ["paid_on", "take_gbp"])).toBe("To mark this offer Paid, add the paid date and take in GBP.");
    expect(missingPaidMessage("complete", ["quantity"])).toBe("To mark this offer Complete, add the quantity.");
    expect(missingPaidMessage("paid", ["paid_on", "paid_amount", "take_gbp"])).toBe("To mark this offer Paid, add the paid date, amount paid and take in GBP.");
  });
  it("reads the request keys, clears with null, and refuses bad values", () => {
    expect(readPaidFacts({ paidOn: "2026-12-03", paidAmount: "18000", paidCurrency: "eur", quantity: 48, takeGbp: 0, stage: "paid" }))
      .toEqual({ paid_on: "2026-12-03", paid_amount: 18000, paid_currency: "EUR", quantity: 48, take_gbp: 0 });
    expect(readPaidFacts({ takeGbp: null })).toEqual({ take_gbp: null });
    expect(readPaidFacts({})).toEqual({});
    expect(readPaidFacts({ paidOn: "3 Dec" })).toBe("Use a paid date like 2026-10-30.");
    expect(readPaidFacts({ paidCurrency: "JPY" })).toBe("Currency must be GBP, EUR, USD.");
    expect(readPaidFacts({ quantity: 0 })).toBe("Quantity must be a number above 0.");
    expect(readPaidFacts({ takeGbp: -1 })).toBe("Take in GBP must be a number, 0 or more.");
    expect(readPaidFacts({ paidAmount: "lots" })).toBe("Amount paid must be a number, 0 or more.");
  });
});
