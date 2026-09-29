import { describe, expect, it } from "vitest";
import type { BulkTrade } from "./bulk-trades";
import {
  bidLabel,
  missingItems,
  parseBidInput,
  parseBuyerInput,
  parseFieldInput,
  teaserText,
  whatsappNumber,
  type TradeField,
  type TradeFile,
} from "./bulk-trade-details";

function field(field_key: string, value: string, overrides: Partial<TradeField> = {}): TradeField {
  return {
    field_key, value, status: "confirmed", visibility: "teaser",
    source_label: null, source_url: null, source_date: null, alternatives: [], ...overrides,
  };
}

function file(file_type: TradeFile["file_type"]): TradeFile {
  return {
    id: file_type, file_name: "x", file_type, byte_size: 1, source_label: null, source_date: null,
    visibility: "never", created_at: "2026-09-28T09:00:00Z",
  };
}

const TRADE = { title: "Synthetic eBS37", trade_kind: "packs" } as BulkTrade;

describe("missingItems", () => {
  it("lists empty template fields and absent required files, earliest step first", () => {
    const fields = [
      field("model", "FPT eBS37"), field("chemistry", "NMC"), field("capacity", "36.9 kWh"),
      field("quantity", "161 + 9 incomplete"), field("soh", ">90%", { status: "unverified" }),
      field("test_data", "", { status: "missing" }), field("seller_price", "€20–25/kWh", { visibility: "never" }),
      field("sale_route", "Auction"), field("clear_by", "Mid-Nov"),
    ];
    const items = missingItems("packs", fields, [file("Datasheet")]);

    expect(items.map((item) => `${item.label} · ${item.neededFor}`)).toEqual([
      "Manufacture date · Teaser",
      "Photos · Teaser",
      "BMS or test data · Bids",
      "Location · Bids",
      "BMS or test report · Bids",
      "Transport class · Shipping",
      "Transport documents · Shipping",
    ]);
  });
});

describe("teaserText", () => {
  it("uses only Teaser values and never price, location or unresolved claims", () => {
    const text = teaserText(TRADE, [
      field("model", "FPT eBS37"),
      field("quantity", "about 200", { status: "conflict" }),
      field("seller_price", "€20–25/kWh", { visibility: "teaser" }),
      field("location", "Turin", { visibility: "after_loi" }),
      field("soh", ">90%", { visibility: "after_nda" }),
    ]);
    expect(text).toContain("- Pack model: FPT eBS37");
    expect(text).not.toMatch(/about 200|Turin|90%|€20–25|Synthetic/);
  });
});

describe("validation", () => {
  it("accepts a structured bid and rejects bad amounts or units", () => {
    expect(parseBidInput({ amount: "22", unit: "kWh", currency: "EUR", firmness: "indicative" })).toEqual({
      value: {
        amount: 22, unit: "kWh", currency: "EUR", firmness: "indicative",
        delivery_terms: null, payment_terms: null, expires_on: null,
      },
    });
    expect(parseBidInput({ amount: 0, unit: "kWh", currency: "EUR", firmness: "firm" })).toHaveProperty("error");
    expect(parseBidInput({ amount: 5, unit: "tonne", currency: "EUR", firmness: "firm" })).toHaveProperty("error");
  });

  it("requires a buyer name on create and only known statuses", () => {
    expect(parseBuyerInput({ contact: "Jason" }, true)).toEqual({ error: "name is required." });
    expect(parseBuyerInput({ status: "Maybe" }, false)).toHaveProperty("error");
    expect(parseBuyerInput({ status: "Declined: timing", chase_on: "" }, false))
      .toEqual({ value: { status: "Declined: timing", chase_on: null } });
  });

  it("only takes http(s) source links", () => {
    expect(parseFieldInput({ source_url: "javascript:alert(1)" })).toHaveProperty("error");
    expect(parseFieldInput({ source_url: "https://mail.google.com/x", visibility: "after_nda" })).toHaveProperty("value");
  });
});

describe("labels", () => {
  it("formats bids and WhatsApp numbers", () => {
    expect(bidLabel({ amount: "22.50", unit: "kWh", currency: "EUR", firmness: "indicative" } as never)).toBe("€22.5/kWh ind.");
    expect(bidLabel({ amount: "1200", unit: "pack", currency: "USD", firmness: "firm" } as never)).toBe("$1,200/pack");
    expect(whatsappNumber("+39 347 123 4567")).toBe("393471234567");
    expect(whatsappNumber(null)).toBeNull();
  });
});
