import { describe, expect, it } from "vitest";
import { expiryProblem, NEXT_STEP, offerExpiry, offerMargin, priceUnit, quoteDay, quoteGate, stepGaps } from "./bulk-offer-close";

const on = "2026-11-12";
const confirmed = { value: "GBP 2,000 per pack", status: "confirmed", validUntil: "2026-12-03" };

describe("quote gate", () => {
  it("lets a buyer offer go while the seller's quote is confirmed and in date, until its last day", () => {
    expect(quoteGate(confirmed, on)).toEqual({ ok: true, validUntil: "2026-12-03" });
    // The last day itself still counts.
    expect(quoteGate({ ...confirmed, validUntil: on }, on)).toEqual({ ok: true, validUntil: on });
  });

  it("blocks an expired quote and says the day it ran out", () => {
    expect(quoteGate({ ...confirmed, validUntil: "2026-11-03" }, on)).toEqual({
      ok: false, validUntil: "2026-11-03", reason: "The seller's quote ran out on 3 Nov. Ask them to confirm it.",
    });
  });

  it("blocks a missing price, a missing end date and an unconfirmed price, each with its own reason", () => {
    expect(quoteGate(null, on)).toMatchObject({ ok: false, reason: "The seller has not given a price yet. Ask them to confirm it." });
    expect(quoteGate({ ...confirmed, value: " " }, on)).toMatchObject({ ok: false, reason: /has not given a price/ });
    expect(quoteGate({ ...confirmed, validUntil: null }, on)).toMatchObject({ ok: false, reason: "The seller's quote has no end date. Ask them to confirm it." });
    expect(quoteGate({ ...confirmed, status: "unverified" }, on)).toMatchObject({ ok: false, reason: "The seller's price is not confirmed. Ask them to confirm it.", validUntil: "2026-12-03" });
  });

  it("takes the match's own quote date when it is sooner, and blocks when that one has run out", () => {
    expect(quoteGate(confirmed, on, "2026-11-20")).toEqual({ ok: true, validUntil: "2026-11-20" });
    expect(quoteGate(confirmed, on, "2026-12-20")).toEqual({ ok: true, validUntil: "2026-12-03" });
    expect(quoteGate(confirmed, on, "2026-11-10")).toMatchObject({ ok: false, reason: /quote on this match ran out on 10 Nov/ });
  });

  it("formats days the way the card says them", () => {
    expect(quoteDay("2026-11-03")).toBe("3 Nov");
    expect(quoteDay("2026-12-31T00:00:00Z")).toBe("31 Dec");
  });
});

describe("offer expiry", () => {
  const gate = quoteGate(confirmed, on);

  it("defaults to the seller quote's last day", () => {
    expect(offerExpiry(null, gate)).toBe("2026-12-03");
    expect(offerExpiry("2026-11-30", gate)).toBe("2026-11-30");
    expect(offerExpiry(null, null)).toBeNull();
  });

  it("may not be later than the seller's quote", () => {
    expect(expiryProblem("2026-12-03", gate)).toBeNull();
    expect(expiryProblem("2026-11-20", gate)).toBeNull();
    expect(expiryProblem("2026-12-04", gate)).toBe("The offer cannot run past the seller's quote, which ends on 3 Dec.");
    expect(expiryProblem("next week", gate)).toMatch(/valid-until date/);
    expect(expiryProblem(null, gate)).toBeNull();
  });
});

describe("margin and take", () => {
  it("is buyer price minus seller quote, times quantity, with the take in pounds", () => {
    const margin = offerMargin({
      buyer: { amount: 2400, currency: "GBP", unit: "pack" }, seller: { amount: 2000, currency: "GBP", per: "unit" }, quantity: 12,
    });
    expect(margin).toEqual({
      ok: true, currency: "GBP", unit: "pack", buyerPrice: 2400, sellerPrice: 2000, perUnit: 400, quantity: 12,
      total: 4800, buyerTotal: 28800, takeGbp: 4800, feePct: 16.7, approx: false,
    });
  });

  // Rule: both prices go through EUR at the CRM's fixed rates (EUR_PER: 1 GBP = 1.16 EUR, 1 USD = 0.86 EUR). The margin
  // is counted in the buyer's currency and the take is that margin in pounds, marked approximate.
  it("converts a seller quote in another currency at the fixed rates and marks it approximate", () => {
    const margin = offerMargin({
      buyer: { amount: 100, currency: "EUR", unit: "kWh" }, seller: { amount: 70, currency: "GBP", per: "kwh" }, quantity: 1000,
    });
    expect(margin).toMatchObject({ ok: true, currency: "EUR", sellerPrice: 81.2, perUnit: 18.8, total: 18800, approx: true });
    // 18,800 EUR / 1.16 = 16,206.9 GBP
    expect(margin.ok && margin.takeGbp).toBe(16207);

    const usd = offerMargin({ buyer: { amount: 3000, currency: "USD", unit: "pack" }, seller: { amount: 2000, currency: "EUR", per: "unit" }, quantity: 2 });
    // Seller 2,000 EUR = 2,325.58 USD; margin 674.42 USD a pack, 1,348.84 USD; in GBP 1,348.84 x 0.86 / 1.16 = 1,000.
    expect(usd).toMatchObject({ ok: true, sellerPrice: 2325.58, perUnit: 674.42, total: 1348.84, takeGbp: 1000, approx: true });
  });

  it("converts per kWh and per pack with a single product's kWh per unit, and says why when it cannot", () => {
    const margin = offerMargin({
      buyer: { amount: 2400, currency: "GBP", unit: "pack" }, seller: { amount: 40, currency: "GBP", per: "kwh" }, quantity: 10, kwhPerUnit: 50,
    });
    expect(margin).toMatchObject({ ok: true, sellerPrice: 2000, total: 4000, approx: true });
    expect(offerMargin({ buyer: { amount: 2400, currency: "GBP", unit: "pack" }, seller: { amount: 40, currency: "GBP", per: "kwh" }, quantity: 10 }))
      .toEqual({ ok: false, why: expect.stringMatching(/kWh per unit is not known/) });
  });

  it("gives no margin without a buyer price, a confirmed seller price or a quantity", () => {
    expect(offerMargin({ buyer: {}, seller: { amount: 1, currency: "GBP", per: "unit" }, quantity: 1 })).toEqual({ ok: false, why: "No buyer price on the offer yet." });
    expect(offerMargin({ buyer: { amount: 2, currency: "GBP", unit: "pack" }, seller: null, quantity: 1 })).toEqual({ ok: false, why: "No confirmed seller price to count from." });
    expect(offerMargin({ buyer: { amount: 2, currency: "GBP", unit: "pack" }, seller: { amount: 1, currency: "GBP", per: "unit" }, quantity: null }))
      .toEqual({ ok: false, why: "No quantity on the offer yet." });
    expect(offerMargin({ buyer: { amount: 2, currency: "GBP", unit: "lot" }, seller: { amount: 1, currency: "GBP", per: "unit" }, quantity: 1 }))
      .toMatchObject({ ok: false, why: /per lot/ });
  });

  it("reads written units", () => {
    expect([priceUnit("kWh"), priceUnit("per MWh"), priceUnit("packs"), priceUnit("module"), priceUnit("kg"), priceUnit(null)]).toEqual(["kwh", "mwh", "unit", "unit", null, null]);
  });
});

describe("next step", () => {
  it("has one primary move for every open stage and none once complete or ended", () => {
    expect(Object.fromEntries(Object.entries(NEXT_STEP).map(([stage, step]) => [stage, step!.to]))).toEqual({
      candidate: "offered", offered: "negotiating", negotiating: "contract_out", contract_out: "signed", signed: "invoiced", invoiced: "paid", paid: "complete",
    });
    expect(NEXT_STEP.complete).toBeUndefined();
    expect(NEXT_STEP.lost).toBeUndefined();
  });

  it("asks for the price, quantity and last day before the contract, and leaves paid facts to their own form", () => {
    expect(stepGaps("contract_out", { terms: {}, quantity: null })).toEqual(["buyer price", "quantity", "valid-until date"]);
    expect(stepGaps("contract_out", { terms: { amount: 1, currency: "GBP", expires_on: "2026-12-01" }, quantity: 3 })).toEqual([]);
    expect(stepGaps("paid", { terms: {}, quantity: null })).toEqual([]);
  });
});
