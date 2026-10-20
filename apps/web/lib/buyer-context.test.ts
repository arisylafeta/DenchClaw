import { describe, expect, it } from "vitest";
import { parseDemandInput } from "./bulk-demand";
import { TEST_REGISTRY } from "./bulk-registry.fixture";
import { parseBuyerContext } from "./buyer-context";

const contextFixture = {
  listing_title: "12x EV Packs for Storage Pilot",
  application: "Synthetic container storage pilot",
  min_usable_energy_kwh_per_pack: 42,
  homogeneous_within_container: true,
  repeat_supply_required: false,
  container_design_finalized: null,
  pilot_quantity_conflict: true,
  pilot_quantities_observed: [
    { packs: 12, date: "2026-08-01", source: "Synthetic email", source_ref: "email-test-1" },
    { packs: 18, date: "2026-08-02", source: "Synthetic call" },
  ],
  alternatives_to_confirm: ["Different pack family"],
  latest_buyer_response_on: "2026-08-02",
  missing_documents: ["Pack test report"],
  next_action: "Confirm pack count and design status",
  sources: [
    {
      kind: "email",
      id: "email-test-1",
      url: "https://example.test/thread/1",
      label: "Synthetic buyer email",
    },
  ],
  reviewed_at: "2026-08-03T10:00:00Z",
};

describe("buyer context validation", () => {
  it("preserves typed context on create and patch without changing demand facts", () => {
    expect(parseDemandInput({ context: contextFixture }, false, TEST_REGISTRY)).toEqual({
      value: { context: contextFixture },
    });
    expect(
      parseDemandInput({ buyer: "Synthetic buyer", wants: "Packs", context: contextFixture }, true, TEST_REGISTRY),
    ).toMatchObject({ value: { context: contextFixture } });
    expect(parseDemandInput({ note: "Only narrative changed" }, false, TEST_REGISTRY)).toEqual({
      value: { note: "Only narrative changed" },
    });
    expect(parseDemandInput({ context: {} }, false, TEST_REGISTRY)).toEqual({ value: { context: {} } });
  });
  it.each([null, [], "text", 4, true])("rejects non-object context: %j", (context) => {
    expect(parseDemandInput({ context }, false, TEST_REGISTRY)).toEqual({ error: "context must be an object." });
  });
  it.each([
    { listing_title: 12 },
    { container_design_finalized: "unknown" },
    { repeat_supply_required: null },
    { min_usable_energy_kwh_per_pack: -1 },
    { missing_documents: "test report" },
    { pilot_quantities_observed: [{ packs: 2, date: "2026-02-30", source: "Call" }] },
    { sources: [{ kind: "url", label: "Unsafe", url: "javascript:alert(1)" }] },
    { unknown: true },
    { reviewed_at: "2026-02-30T10:00:00Z" },
    { sources: [{ kind: "url", label: " ", url: "https://example.test" }] },
  ])("rejects malformed fields: %j", (context) => {
    expect(parseBuyerContext(context)).toHaveProperty("error");
  });
  it("retains explicit false as distinct from unknown", () => {
    expect(parseBuyerContext({ container_design_finalized: false })).toEqual({
      value: { container_design_finalized: false },
    });
  });
});