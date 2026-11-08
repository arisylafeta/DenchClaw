import { describe, expect, it } from "vitest";
import { stockCandidate, stockSourceKind, stockUnits, type StockRow } from "./demand-matches-v2";
import { requirementFor, scoreCandidate } from "../demand-match";
import { fitMarks, holdsLine, sourceLine } from "../match/fit-marks";
import type { Demand } from "../bulk-demand";

// Shapes of real stock lines (8 Nov), as the request query returns them.
const stockRow = (o: Partial<StockRow> = {}): StockRow => ({
  id: "sto_1", company_id: "comp_1", person_id: "p_1", supplier: "Ro Cell", make: "LISHEN", model: "LR21700LH", format: "cell",
  chemistry: "Li-ion NMC", capacity_kwh: 0.011, quantity: 1, price_eur: null, location: null, country: "Romania",
  seen_on: "2026-10-08", title: "LISHEN LR21700LH", quantity_available: null, quantity_stated: false,
  soh_percent: null, year: null, part_numbers: null, supplier_ref: "rocell-2026-10-08-r15",
  description: "Cell: LISHEN LR21700LH - 10,8Wh 3Ah 3,6V", source: "supplier list",
  evidence_source: "Ro Cell catalogue CATALOG_FINAL.xlsx (sheet Foaie1), received from Alex in chat", observed_on: "2026-10-08", ...o,
});

const demand = (o: Partial<Demand>): Demand => ({
  id: "btd_t", kind: "request", basis: null, buyer: "Battery Partners", company_id: null, person_id: null, contact: null, email: null,
  wants: "", quantity: null, location: null, note: null, needed_by: null, volume: null, volume_unit: null, max_price: null,
  price_currency: null, price_unit: null, spec: {}, source_kind: null, source_label: null, source_url: null, source_quote: null,
  observed_on: null, status: "open", product_family: null, fee_eur: null, price_basis: null, reputation: null, qualify_question: null,
  qualify_asked_on: null, qualify_entered_on: null, activity_count: 0, last_activity_at: null, moved_to: null, asked_on: null,
  score: null, expected_fee: null, has_stock: false, closed_reason: null, confirmed_on: null, updated_at: "", fits: [], trades: [],
  tier: null, waiting: null, priority: false, missing: [], context_notes: [], inventory_matches: [], context: {}, ...o,
});

const NOW = new Date("2026-11-08T12:00:00Z");

describe("stock lines on a request", () => {
  it("reads the stated quantity: quantity_stated=false is not stated, quantity_available wins, a lone 1 is bare", () => {
    expect(stockUnits({ quantity: 1, quantity_available: null, quantity_stated: false })).toEqual({ units: null, bare: false });
    expect(stockUnits({ quantity: 1, quantity_available: 12_400, quantity_stated: null })).toEqual({ units: 12_400, bare: false });
    expect(stockUnits({ quantity: 1, quantity_available: null, quantity_stated: null })).toEqual({ units: 1, bare: true });
    expect(stockUnits({ quantity: 6, quantity_available: null, quantity_stated: null })).toEqual({ units: 6, bare: false });
  });

  it("carries SoH, year, part numbers, the seller's reference and the source onto the candidate", () => {
    const c = stockCandidate(stockRow({
      make: "Toyota", model: "Proace", format: "pack", capacity_kwh: 50, quantity: 1, quantity_available: 1, quantity_stated: null,
      soh_percent: 96, year: 2024, part_numbers: ["G9510-K0010", "G951K0010"], supplier_ref: "O209498", source: "website",
      evidence_source: null, observed_on: "2026-10-27", title: "Toyota Proace 50 kWh battery pack", description: null,
    }));
    expect(c).toMatchObject({
      soh: 96, year: 2024, partNumber: "G9510-K0010", partNumbers: ["G9510-K0010", "G951K0010"], supplierRef: "O209498",
      sourceKind: "salvage listing", observedOn: "2026-10-27", units: 1, unitsBare: false, format: "Packs",
    });
    expect(holdsLine(c)).toBe("Toyota Proace · 1 pack · 50 kWh · SoH 96% · 2024 · part G9510-K0010");
  });

  it("names the source the way a trader would", () => {
    expect(stockSourceKind(stockRow())).toBe("catalogue");
    expect(stockSourceKind(stockRow({ evidence_source: "supplier stock sheet" }))).toBe("stock list");
    expect(stockSourceKind(stockRow({ source: "supplier email" }))).toBe("email");
    expect(stockSourceKind(stockRow({ source: "pipeline", evidence_source: null, title: "Seller email 22 Oct 2026: loose cells" }))).toBe("email");
    expect(stockSourceKind(stockRow({ source: "ebay" }))).toBe("eBay listing");
    expect(sourceLine(stockCandidate(stockRow({ source: "ebay", observed_on: "2026-10-27" })), NOW)).toBe("eBay listing, 27 Oct");
  });

  it("gives the Lishen line its evidence line: product, quantity not stated, catalogue and date", () => {
    const c = stockCandidate(stockRow());
    expect(c.units).toBeNull();
    expect(holdsLine(c)).toBe("Lishen LR21700LH cells · quantity not stated");
    expect(sourceLine(c, NOW)).toBe("Catalogue, 8 Oct");
  });

  it("marks the INR21700-50E line against the 50E request, and never says 1 of 500,000", () => {
    const ask = requirementFor(demand({
      product_family: "Samsung 50E-equivalent 21700 cells", wants: "500,000 Samsung 50E (21700) cylindrical cells or equivalent",
      volume: 500_000, volume_unit: "cells", quantity: "500,000", location: "Poland (delivery site tbc)", max_price: 1, price_currency: "EUR", price_unit: "cell",
      spec: { formats: ["Cells"], cell_makers: ["Samsung SDI"], cell_formats: ["Cylindrical"] },
    }));
    const c = stockCandidate(stockRow({
      id: "sto_91fe9a2f", supplier: "E-bike seller", make: null, model: null, format: null, chemistry: null, capacity_kwh: null,
      quantity: 1, quantity_stated: null, country: null, title: "Seller email 22 Oct 2026: loose cells from e-bike packs, shipping from Florida, USA",
      description: "Seller email 22 Oct 2026: loose cells from e-bike packs. Seller wrote '2170' for the 21700 type.",
      supplier_ref: "INR21700-50E", source: "pipeline", evidence_source: null, observed_on: "2026-10-27",
    }));
    const m = scoreCandidate(ask, c)!;
    expect(holdsLine(m.candidate)).toBe("Samsung INR21700-50E · quantity not stated");
    expect(sourceLine(m.candidate, NOW)).toBe("Email, 27 Oct");
    expect(fitMarks(ask, m)).toEqual([
      { key: "model", label: "Samsung 50E", state: "fits" },
      { key: "size", label: "21700 size", state: "fits" },
      { key: "format", label: "Format", state: "unstated" },
      { key: "quantity", label: "Quantity", state: "unstated" },
      { key: "price", label: "Price", state: "unstated" },
      { key: "location", label: "Location", state: "unstated" },
    ]);
    // Lishen is a different maker: no match at all on this request.
    expect(scoreCandidate(ask, stockCandidate(stockRow()))).toBeNull();
  });

  it("keeps one pack as one pack on a pack request, with coverage marks", () => {
    const ask = requirementFor(demand({ wants: "20 Kia EV6 77.4 kWh packs", volume: 20, volume_unit: "packs", location: "Poland" }), new Set(["kia", "ev6"]));
    const c = stockCandidate(stockRow({ make: "Kia", model: "EV6", format: "pack", capacity_kwh: 77.4, quantity: 1, quantity_stated: null, country: "Norway", title: "Kia EV6 77 kWh battery pack", source: "supplier email" }));
    const m = scoreCandidate(ask, c)!;
    expect(m.candidate.units).toBe(1);
    expect(fitMarks(ask, m).find((mark) => mark.key === "quantity")).toEqual({ key: "quantity", label: "1 of 20", state: "close" });
    expect(fitMarks(ask, m).find((mark) => mark.key === "location")).toEqual({ key: "location", label: "NO → PL", state: "close" });
  });
});
