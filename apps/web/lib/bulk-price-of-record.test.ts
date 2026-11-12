import { describe, expect, it } from "vitest";
import { comparePrices, moneyText } from "./bulk-price-of-record";

describe("price of record", () => {
  it("flags the 9 Nov case in plain words", () => {
    const check = comparePrices({ amount: 2400, currency: "GBP", unit: "pack" }, { amount: 662, currency: "GBP", unit: "pack" });
    expect(check).toMatchObject({ state: "differs", flag: "Marketplace shows £662, CRM has £2,400." });
  });

  it("stays quiet within 2% and flags just beyond it", () => {
    expect(comparePrices({ amount: 1000, currency: "GBP", unit: "pack" }, { amount: 1020, currency: "GBP", unit: "pack" })).toMatchObject({ state: "match", flag: null });
    expect(comparePrices({ amount: 1000, currency: "GBP", unit: "pack" }, { amount: 980, currency: "GBP", unit: "pack" })).toMatchObject({ state: "match", flag: null });
    expect(comparePrices({ amount: 1000, currency: "GBP", unit: "pack" }, { amount: 1021, currency: "GBP", unit: "pack" })).toMatchObject({ state: "differs", flag: "Marketplace shows £1,021, CRM has £1,000." });
  });

  it("compares across currencies at the fixed rates and across units with kWh per unit", () => {
    // 1,160 EUR is 1,000 GBP at 1.16.
    expect(comparePrices({ amount: 1000, currency: "GBP", unit: "pack" }, { amount: 1160, currency: "EUR", unit: "pack" })).toMatchObject({ state: "match" });
    // 40 GBP per kWh on a 50 kWh pack is 2,000 a pack.
    expect(comparePrices({ amount: 2000, currency: "GBP", unit: "pack" }, { amount: 40, currency: "GBP", unit: "kWh" }, 50)).toMatchObject({ state: "match" });
    expect(comparePrices({ amount: 2000, currency: "GBP", unit: "pack" }, { amount: 40, currency: "GBP", unit: "kWh" })).toMatchObject({ state: "unknown", flag: null });
  });

  it("says when either price is not known instead of guessing", () => {
    expect(comparePrices(null, { amount: 1, currency: "GBP", unit: null })).toMatchObject({ state: "unknown", why: /CRM has no price/ });
    expect(comparePrices({ amount: 1, currency: "GBP", unit: null }, null)).toMatchObject({ state: "unknown", why: /marketplace price is not known/ });
  });

  it("writes money the way people read it", () => {
    expect([moneyText(2400, "GBP"), moneyText(40.5, "EUR"), moneyText(300, "PLN")]).toEqual(["£2,400", "€40.5", "PLN 300"]);
  });
});
