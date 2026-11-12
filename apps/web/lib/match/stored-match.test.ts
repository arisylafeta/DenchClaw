import { describe, expect, it } from "vitest";
import type { MatchRow } from "../matches-types";
import { buildOfferEmail } from "./offer-email";
import { buildProductKey } from "./product-key";
import {
  addWorkingDays, askedAgo, candidateFacts, candidateRef, checkRanking, quoteInDate, reservationLive, reservationUntil, ruleReason,
} from "./stored-match";

const row = (o: Partial<MatchRow> = {}): MatchRow => ({
  key: "stock:sto_1", rank: 1, name: "Synetiq", detail: null, tags: ["unlisted stock"], reason: "Model matches: Hyundai Kona",
  checks: ["No price stated"], price: null, offer: null, companyId: "co_s", personId: "pe_s", contact: "sales@synetiq.test",
  stockId: "sto_1", units: 12, country: "United Kingdom", holds: "Hyundai Kona 64 kWh pack × 12",
  fit: [{ key: "model", label: "Hyundai Kona", state: "fits" }, { key: "quantity", label: "12 of 20", state: "close" }], ...o,
});

describe("which candidate a row is", () => {
  it("maps every Matches key to a candidate, and a reservation to the candidate on a request", () => {
    const demand = { id: "btd_1", kind: "demand" as const };
    expect(candidateRef("stock:sto_1", demand)).toEqual({ kind: "stock", id: "sto_1", stockKind: "stock", stockId: "sto_1" });
    expect(candidateRef("group:stock:sto_2", demand)).toEqual({ kind: "stock", id: "sto_2", stockKind: "stock", stockId: "sto_2" });
    expect(candidateRef("supply:bts_9", demand)).toEqual({ kind: "listing", id: "bts_9", stockKind: "listing", stockId: "bts_9" });
    expect(candidateRef("listing:mkt_1", demand)).toEqual({ kind: "marketplace", id: "mkt_1", stockKind: "marketplace", stockId: "mkt_1" });
    expect(candidateRef("company:co_1", demand)).toBeNull();
  });

  it("holds the deal's own lot on a supply deal, whoever the buyer is", () => {
    const supply = { id: "bts_1", kind: "supply" as const };
    expect(candidateRef("demand:btd_4", supply)).toEqual({ kind: "listing", id: "btd_4", stockKind: "listing", stockId: "bts_1" });
    expect(candidateRef("company:co_1", supply)).toEqual({ kind: "company", id: "co_1", stockKind: "listing", stockId: "bts_1" });
    expect(candidateRef("nonsense", supply)).toBeNull();
  });
});

describe("the model step's answer", () => {
  const ids = ["c1", "c2"];
  const facts = { c1: candidateFacts(row()), c2: candidateFacts(row({ units: null, holds: "Kona pack", fit: [] })) };
  const input = { ids, facts, ask: "Hyundai Kona 64 kWh packs, 20 units", forbidden: ["Synetiq", "sales@synetiq.test", "Motorgreen Ltd"] };

  it("keeps no names or contacts in the facts it is given", () => {
    expect(facts.c1).not.toMatch(/Synetiq|synetiq\.test/);
    expect(facts.c1).toContain("Quantity: 12");
  });

  it("accepts a full reorder with short reasons drawn from the facts", () => {
    const answer = { order: ["c2", "c1"], reasons: { c1: "Exact model and 12 of the 20 packs stated.", c2: "Same model; quantity not stated, so ask first." } };
    expect(checkRanking(answer, input)).toEqual({ ok: true, ranking: answer });
  });

  it("refuses a reason that names a counterparty, the buyer or carries an address", () => {
    const named = checkRanking({ order: ["c1", "c2"], reasons: { c1: "Synetiq has the exact model.", c2: "Same model." } }, input);
    expect(named).toEqual({ ok: false, why: "reason for c1 names Synetiq" });
    const buyer = checkRanking({ order: ["c1", "c2"], reasons: { c1: "Exact model.", c2: "Motorgreen would like these." } }, input);
    expect(buyer.ok).toBe(false);
    expect(checkRanking({ order: ["c1", "c2"], reasons: { c1: "Exact model.", c2: "Write to sales@x.test." } }, input).ok).toBe(false);
  });

  it("refuses a figure the inputs do not hold, an order that is not the candidates, and more than two sentences", () => {
    expect(checkRanking({ order: ["c1", "c2"], reasons: { c1: "Exact model at 95% state of health.", c2: "Same model." } }, input))
      .toEqual({ ok: false, why: "reason for c1 cites 95, which is not in its facts" });
    expect(checkRanking({ order: ["c1", "c1"], reasons: { c1: "a.", c2: "b." } }, input).ok).toBe(false);
    expect(checkRanking({ order: ["c1"], reasons: {} }, input).ok).toBe(false);
    expect(checkRanking({ order: ["c1", "c2"], reasons: { c1: "One. Two. Three.", c2: "Same." } }, input).ok).toBe(false);
    expect(checkRanking("prose", input).ok).toBe(false);
  });
});

describe("plain reasons", () => {
  it("says what fits and what to check, naming nobody", () => {
    expect(ruleReason(row(), ["Synetiq"])).toBe("Fits on model. Check quantity close.");
    expect(ruleReason(row({ fit: [], reason: "Same part number: 50 kWh Packs NMC", checks: ["No firm seller price"] })))
      .toBe("Same part number: 50 kWh Packs NMC. Check: No firm seller price.");
    expect(ruleReason(row({ fit: [], reason: "Wants what Synetiq sells", checks: [] }), ["Synetiq"])).toBe("Ranked by the scorer on the product it matched.");
  });
});

describe("dates", () => {
  it("counts working days the same way as the database", () => {
    expect(addWorkingDays("2026-11-12", 5)).toBe("2026-11-19");
    expect(addWorkingDays("2026-11-13", 5)).toBe("2026-11-20");
    expect(addWorkingDays("2026-11-14", 1)).toBe("2026-11-16");
  });

  it("holds five working days, or to the quote's last day if sooner", () => {
    expect(reservationUntil("2026-11-12", null)).toBe("2026-11-19");
    expect(reservationUntil("2026-11-12", "2026-11-16")).toBe("2026-11-16");
    expect(reservationUntil("2026-11-12", "2026-12-31")).toBe("2026-11-19");
  });

  it("reads an out-of-date reservation as free", () => {
    expect(reservationLive({ state: "offered", reserved_until: "2026-11-12" }, "2026-11-12")).toBe(true);
    expect(reservationLive({ state: "offered", reserved_until: "2026-11-11" }, "2026-11-12")).toBe(false);
    expect(reservationLive({ state: "confirmed", reserved_until: "2026-11-30" }, "2026-11-12")).toBe(false);
    // Once the offer is past offered, the reservation holds until the offer ends; complete has consumed it.
    expect(reservationLive({ state: "offered", reserved_until: "2026-11-11", offer_stage: "negotiating" }, "2026-11-12")).toBe(true);
    expect(reservationLive({ state: "offered", reserved_until: "2026-11-11", offer_stage: "paid" }, "2026-11-12")).toBe(true);
    expect(reservationLive({ state: "offered", reserved_until: "2026-11-30", offer_stage: "complete" }, "2026-11-12")).toBe(false);
    expect(reservationLive({ state: "offered", reserved_until: null, offer_stage: "negotiating" }, "2026-11-12")).toBe(false);
  });

  it("says how long an ask has gone unanswered", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    // On the one chase clock: day 1, 3 and 5 from the ask (lib/chase-clock.ts).
    expect(askedAgo({ state: "asked", asked_at: "2026-11-09T10:00:00Z", verdict: null, chases: 1 }, now)).toEqual({ days: 3, label: "Asked 3 working days ago, no answer: chase 2 of 3 due", chase: "due", next: 2 });
    expect(askedAgo({ state: "asked", asked_at: "2026-11-10T10:00:00Z", verdict: null, chases: 1 }, now)).toEqual({ days: 2, label: "Asked 2 working days ago, no answer", chase: "waiting", next: 2 });
    expect(askedAgo({ state: "asked", asked_at: "2026-11-02T10:00:00Z", verdict: null, chases: 3 }, now)?.label).toBe("Asked 8 working days ago, no answer to 3 chases: park it?");
    expect(askedAgo({ state: "asked", asked_at: "2026-11-12T09:00:00Z", verdict: null }, now)?.label).toBe("Asked today, no answer yet");
    expect(askedAgo({ state: "confirmed", asked_at: "2026-11-09T10:00:00Z", verdict: "yes" }, now)).toBeNull();
  });

  it("treats a seller quote as in date only when confirmed, priced and not past its last day", () => {
    expect(quoteInDate({ value: "£1,495 per pack", status: "confirmed", validUntil: "2026-11-20" }, "2026-11-12")).toBe(true);
    expect(quoteInDate({ value: "£1,495 per pack", status: "unverified", validUntil: "2026-11-20" }, "2026-11-12")).toBe(false);
    expect(quoteInDate({ value: "£1,495 per pack", status: "confirmed", validUntil: "2026-11-11" }, "2026-11-12")).toBe(false);
    expect(quoteInDate({ value: "£1,495 per pack", status: "confirmed", validUntil: null }, "2026-11-12")).toBe(false);
    expect(quoteInDate({ value: null, status: "confirmed", validUntil: "2026-11-20" }, "2026-11-12")).toBe(false);
  });
});

describe("the ask emails", () => {
  const key = buildProductKey({ fields: [], title: "Hyundai Kona packs" });

  it("asks a supplier to confirm stock, quantity, price and until when, naming neither the buyer nor their ceiling", () => {
    const email = buildOfferEmail({
      kind: "stock_confirm", key, recipientFirstName: "Connor", location: "Unit 4, Leeds Road, Leeds, United Kingdom",
      request: { productFamily: "Hyundai Kona 64 kWh packs", volume: 20, volumeUnit: "packs", maxPrice: 1800 },
      holds: "Hyundai Kona 64 kWh pack × 12", privateValues: ["Motorgreen Ltd", "buyer@motorgreen.test", "Unit 4", "Leeds Road"],
    });
    expect(email.subject).toBe("Stock check: 20 x Hyundai Kona 64 kWh packs");
    expect(email.body).toContain("We're looking for 20 x Hyundai Kona 64 kWh packs in United Kingdom.");
    expect(email.body).toContain("Is your Hyundai Kona 64 kWh pack × 12 still available? If so, how many can you offer, at what price, and until when does that price hold?");
    expect(email.body).not.toMatch(/Motorgreen|1800|1,800|Leeds Road/);
  });

  it("refuses a stock check that would name the buyer", () => {
    expect(() => buildOfferEmail({
      kind: "stock_confirm", key, request: { productFamily: "Packs for Motorgreen" }, privateValues: ["Motorgreen"],
    })).toThrow(/Motorgreen/);
  });

  it("asks the seller to re-confirm their own price without offering one", () => {
    const email = buildOfferEmail({ kind: "seller_reconfirm", key: buildProductKey({ fields: [
      { field_key: "quantity", value: "12", status: "confirmed" }, { field_key: "seller_price", value: "1,495 GBP per pack", status: "confirmed" },
    ], title: "Kona packs" }), recipientFirstName: "Mohamed" });
    expect(email.body).toContain("Hi Mohamed,");
    expect(email.body).toContain("Could you confirm how many you have, your price, and until when that price holds?");
    expect(email.body).not.toMatch(/1,495|GBP/);
  });
});
