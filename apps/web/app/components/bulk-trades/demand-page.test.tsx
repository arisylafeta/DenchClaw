// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Demand } from "@/lib/bulk-demand";
import type { Check } from "@/lib/demand-match";
import type { BestMatchLine, DemandSupply, SupplyUnitView } from "@/lib/demand-supply-types";
import { DemandPage } from "./demand-page";
import { forgetShared } from "./trade-ui";
vi.mock("./use-registry", async () => {
  const { TEST_REGISTRY } = await import("@/lib/bulk-registry.fixture");
  return { useRegistry: () => TEST_REGISTRY };
});
function row(overrides: Partial<Demand>): Demand {
  return {
    priority: false,
    missing: [],
    context_notes: [],
    inventory_matches: [],
    id: "btd_1",
    kind: "standing",
    basis: "stated",
    buyer: "Green Voltage",
    company_id: null,
    person_id: null,
    contact: "Adam Baker",
    email: "adam@gv.example",
    wants: "Matched packs in repeat batches",
    quantity: "MWh a year",
    location: "UK",
    note: null,
    needed_by: null,
    volume: null,
    volume_unit: null,
    max_price: null,
    price_currency: null,
    price_unit: null,
    spec: {},
    context: {},
    source_kind: "email",
    source_label: "Gmail · adam@gv.example",
    source_url: null,
    source_quote: "Can you supply matched packs?",
    observed_on: "2026-09-18",
    status: "open",
    closed_reason: null,
    confirmed_on: "2026-09-18",
    product_family: "VW MEB",
    fee_eur: 10000,
    price_basis: "buyer",
    reputation: "active",
    qualify_question: null,
    qualify_asked_on: null,
    qualify_entered_on: null,
    activity_count: 0,
    last_activity_at: null,
    moved_to: null,
    asked_on: "2026-09-18",
    score: null,
    expected_fee: null,
    has_stock: false,
    updated_at: "2026-09-18T10:00:00Z",
    fits: [],
    trades: [],
    waiting: null,
    tier: null,
    ...overrides,
  };
}

const check = (key: Check["key"], label: string, state: Check["state"], detail: string): Check => ({ key, label, state, detail });
const unit: SupplyUnitView = {
  key: "listing:l1", source: "marketplace", alsoIn: ["stock"], title: "Volkswagen ID.3 58 kWh", seller: "Example Breakers",
  make: "Volkswagen", model: "ID.3", format: "Packs", chemistry: "NMC", location: "Yorkshire, United Kingdom", country: "GB",
  kwh: 58, kwhEstimated: false, units: 1, price: 2400, currency: "GBP", currencyAssumed: false, eurPerKwh: 48, eurPerUnit: 2784,
  marginPct: null, spreadEur: null, cheapestRank: 0, peers: 3, verdict: "exact",
  checks: [check("product", "Product", "pass", "Volkswagen ID.3"), check("capacity", "Capacity", "pass", "58 kWh")],
  photos: 2, soh: null, year: 2021, partNumber: "1EA915105", href: "https://www.rebattery.io/marketplace/example", seen: null,
  ai: null, userVerdict: null,
};
const sampleSupply: DemandSupply = {
  requirement: { pinned: ["MEB", "Packs"], unitsNeeded: 10, kwhNeeded: null, buyerEurPerKwh: null, buyerEurPerUnit: null, country: "GB" },
  groups: [{ key: "vw|id.3|58|Packs", label: "Volkswagen ID.3 · 58 kWh", verdict: "exact", units: 3,
    sellers: ["Example Breakers"], sources: ["marketplace", "stock"], eurPerKwh: { min: 48, max: 52 }, bestMarginPct: null,
    covers: { have: 3, need: 10 }, small: false, checks: unit.checks, items: [unit], more: 0,
    bySeller: [{ key: "example", name: "Example Breakers", country: "GB", location: "Yorkshire, United Kingdom", sources: ["marketplace", "stock"],
      units: 3, kwh: { min: 58, max: 58 }, eurPerKwh: { min: 48, max: 52 }, totalEur: 8350, pricedUnits: 3, verdict: "exact", withPhotos: 1,
      items: [unit], more: 0 }],
    fill: { sellers: [{ name: "Example Breakers", units: 3 }], units: 3, need: 10, eurPerKwh: 48 } }],
  totalGroups: 1, smallGroups: 0, totalUnits: 3, considered: { marketplace: 900, stock: 2000, trades: 20 }, hiddenCount: 0,
  shortlisted: [], shortlistGone: [], targetBuyEurPerKwh: null, blocked: null, errors: [], fxNote: "Approximate FX",
};

afterEach(() => vi.unstubAllGlobals());
function respond(url: string, rows: Demand[], matches: Record<string, BestMatchLine> = {}) {
  if (url.endsWith("/activity")) return { activity: [] };
  if (url.endsWith("/demand/matches")) return { matches };
  if (url.endsWith("/supply")) return sampleSupply;
  if (url.endsWith("/context")) return { buyer: null, mail: [] };
  return { demand: rows };
}
function setup(rows: Demand[], matches: Record<string, BestMatchLine> = {}, pageProps: Partial<React.ComponentProps<typeof DemandPage>> = {}) {
  forgetShared();
  const fetchMock = vi.fn(
    async (url: string, _init?: RequestInit) => new Response(JSON.stringify(respond(url, rows, matches))),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<DemandPage today="2026-10-16" onOpenTrade={() => {}} {...pageProps} />);
  return fetchMock;
}
describe("Demand visualization", () => {
  it("opens a demand, filter and search from the URL and reports changes back to it", async () => {
    const onRouteChange = vi.fn();
    setup([
      row({ id: "live", buyer: "Live buyer" }),
      row({ id: "reply", buyer: "Reply buyer", status: "closed", closed_reason: "offer_reply" }),
    ], {}, { route: { demand: null, status: "closed", query: "reply", category: null }, onRouteChange });
    expect(await screen.findByRole("button", { name: /Reply buyer/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Live buyer/ })).not.toBeInTheDocument();
    expect(screen.getByRole("searchbox")).toHaveValue("reply");

    await userEvent.click(screen.getByRole("button", { name: /Reply buyer/ }));
    expect(onRouteChange).toHaveBeenCalledWith({ demand: "reply" }, "push");
  });

  it("renders context conflicts and unknown design without changing quantity", async () => {
    setup([row({ quantity: "12 packs", context: {
      application: "Synthetic storage pilot", min_usable_energy_kwh_per_pack: 42,
      homogeneous_within_container: true, repeat_supply_required: false,
      container_design_finalized: null, pilot_quantity_conflict: true,
      pilot_quantities_observed: [{ packs: 12, date: "2026-08-01", source: "Synthetic email" },
        { packs: 18, date: "2026-08-02", source: "Synthetic call" }],
      missing_documents: ["Pack test report"], alternatives_to_confirm: ["Different pack family"],
      next_action: "Confirm pack count and design status",
      sources: [{ kind: "email", id: "test-email-1", url: "https://example.test/thread", label: "Synthetic source" }],
    } })]);
    await userEvent.click(await screen.findByRole("button", { name: /Green Voltage/ }));
    await userEvent.click(screen.getByRole("button", { name: "Details" }));
    const context = within(screen.getByRole("region", { name: "Buyer context" }));
    for (const text of ["Unknown / to confirm", "42 kWh per pack", "Not required", "Pack test report", "Different pack family", "Confirm pack count and design status"]) {
      expect(context.getByText(text)).toBeVisible();
    }
    expect(context.getByText(/Pilot quantity conflict:/)).toBeVisible();
    expect(context.getByText(/18 packs · 2026-08-02 · Synthetic call/)).toBeVisible();
    expect(context.getByRole("link", { name: "Synthetic source" })).toHaveAttribute("href", "https://example.test/thread");
    expect(screen.getByText("12 packs")).toBeVisible();
  });
  it("filters History categories without swamping All with research and patches only the category", async () => {
    const fetchMock = setup([
      row({ id: "live", buyer: "Live buyer" }),
      row({ id: "reply", buyer: "Reply buyer", status: "closed", closed_reason: "offer_reply" }),
      row({ id: "research", buyer: "Research buyer", status: "closed", closed_reason: "research_profile" }),
    ]);
    await screen.findByRole("button", { name: /Live buyer/ });
    await userEvent.click(screen.getByRole("button", { name: "History 2" }));
    expect(screen.getByRole("button", { name: "All 2" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("button", { name: /Research buyer/ })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Research profile 1" }));
    expect(screen.getByRole("button", { name: /Research buyer/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Reply buyer/ })).not.toBeInTheDocument();
    await userEvent.type(screen.getByRole("searchbox"), "unmatched");
    expect(screen.queryByRole("button", { name: /Research buyer/ })).not.toBeInTheDocument();
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.click(screen.getByRole("button", { name: /Research buyer/ }));
    await userEvent.click(screen.getByRole("button", { name: "Status: History · Research profile" }));
    expect(screen.getByRole("menuitem", { name: /Reopen/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("menuitem", { name: /^Duplicate/ }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/research",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "category", reason: "duplicate" }) }));
  });
  it("keeps status actions and the activity composer working behind the visual sheet", async () => {
    const fetchMock = setup([row({})]);
    await userEvent.click(
      await screen.findByRole("button", { name: /Green Voltage/ }),
    );
    const sheet = screen.getByRole("region", { name: "Demand detail" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Status: Demand" }));
    await userEvent.click(within(sheet).getByRole("menuitem", { name: /Buyer confirmed it today/ }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bulk-trades/demand/btd_1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ action: "confirm" }),
      }),
    );
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Activity" }),
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Log activity" }));
    await userEvent.type(
      within(sheet).getByRole("textbox", { name: "Activity title" }),
      "Called buyer",
    );
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Add activity" }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bulk-trades/demand/btd_1/activity",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ kind: "note", title: "Called buyer" }),
      }),
    );
  });
  it("keeps the add form and rejects incomplete demand without submitting", async () => {
    const fetchMock = setup([]);
    await userEvent.click(screen.getByRole("button", { name: "Add demand" }));
    const sheet = screen.getByRole("dialog", { name: "Add demand" });
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Add demand" }),
    );
    expect(within(sheet).getByText("Enter a buyer.")).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === "POST"),
    ).toBe(false);
  });
  it("preserves the server's flat band and priority ranking and separates fee and missing info", async () => {
    setup([
      row({ id: "high", buyer: "High", score: 90 }),
      row({
        id: "priority",
        buyer: "Priority buyer",
        score: 30,
        priority: true,
        missing: ["no timeline"],
        kind: "request",
        basis: null,
      }),
      row({ id: "low", buyer: "Low", score: 20 }),
    ]);
    const priority = await screen.findByRole("button", {
      name: /Priority buyer/,
    });
    const high = screen.getByRole("button", { name: /High/ });
    expect(
      high.compareDocumentPosition(priority) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(within(priority).getByText("No timeline")).toBeInTheDocument();
    expect(screen.queryByText("0 —")).not.toBeInTheDocument();
  });
  it("opens visual tabs and retains editing and agent correction context", async () => {
    setup([
      row({
        missing: ["no price"],
        inventory_matches: [
          {
            id: "trade:lot",
            kind: "trade",
            title: "Matched lot",
            seller: null,
            size: null,
            location: null,
            seen: null,
            status: "open",
            href: "/?path=bulk_trade&trade=lot",
            suppliers: [],
            verified: null,
            count: null,
            strength: "strong",
            reason: "Matching product family",
          },
        ],
      }),
    ]);
    expect(await screen.findByText("1 supply match")).toBeInTheDocument();
    expect(screen.queryByText("No price")).not.toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole("button", { name: /Green Voltage/ }),
    );
    let sheet = screen.getByRole("region", { name: "Demand detail" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Details" }));
    // Nothing is recorded for this ask yet, so there is no empty "The ask" block.
    expect(within(sheet).queryByText("The ask")).not.toBeInTheDocument();
    expect(
      within(sheet).getByRole("button", { name: "Edit demand" }),
    ).toBeInTheDocument();
    expect(within(sheet).getByRole("button", { name: "Status: Demand" })).toBeInTheDocument();
    await userEvent.click(await within(sheet).findByRole("button", { name: "Supply matching · 1" }));
    expect(within(sheet).getAllByText("Volkswagen ID.3 · 58 kWh").length).toBeGreaterThan(0);
    expect(within(sheet).getByText("3 / 10")).toBeInTheDocument();
    expect(within(sheet).getByText(/once Ari's market finder is connected/)).toBeInTheDocument();
    expect(
      within(sheet).getByRole("button", { name: "Copy ID" }),
    ).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "← Demand" }));
    expect(await screen.findByRole("button", { name: /Green Voltage/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Green Voltage/ }));
    sheet = screen.getByRole("region", { name: "Demand detail" });
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Activity" }),
    );
    expect(within(sheet).getByText("Email with the buyer")).toBeInTheDocument();
    await userEvent.click(within(sheet).getByRole("button", { name: "Log activity" }));
    expect(
      within(sheet).getByRole("textbox", { name: "Activity title" }),
    ).toBeInTheDocument();
  });
  it("shows the best inventory match in the list and shortlists a unit from the supply tab", async () => {
    const fetchMock = setup([row({})], { btd_1: { verdict: "exact", text: "Volkswagen ID.3 · 58 kWh · 3/10", groups: 1, shortlisted: 0 } });
    expect(await screen.findByText("Volkswagen ID.3 · 58 kWh · 3/10")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Green Voltage/ }));
    const sheet = screen.getByRole("region", { name: "Demand detail" });
    expect(await within(sheet).findAllByLabelText("Exact")).not.toHaveLength(0);
    await userEvent.click(await within(sheet).findByRole("button", { name: "Shortlist" }));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/bulk-trades/demand/btd_1/supply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ key: "listing:l1", verdict: "shortlist", title: "Volkswagen ID.3", seller: "Example Breakers",
          eurPerKwh: 48, href: "https://www.rebattery.io/marketplace/example" }),
      }),
    );
  });
  it("shows failed status actions visibly next to the ask", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH")
          return new Response(
            JSON.stringify({ error: "Could not confirm demand." }),
            { status: 500 },
          );
        return new Response(JSON.stringify(respond(url, [row({})])));
      }),
    );
    render(<DemandPage today="2026-10-16" onOpenTrade={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Green Voltage/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Status: Demand" }));
    await userEvent.click(screen.getByRole("menuitem", { name: /Buyer confirmed it today/ }));
    expect(await screen.findByText("Could not confirm demand.")).toBeVisible();
    expect(screen.getByRole("button", { name: "← Demand" })).toBeInTheDocument();
  });
  it("moves a row to Qualifying with a question built from its gaps, and back to Demand", async () => {
    const fetchMock = setup([row({ max_price: null, needed_by: null, kind: "request", basis: null })]);
    await userEvent.click(await screen.findByRole("button", { name: /Green Voltage/ }));
    const sheet = screen.getByRole("region", { name: "Demand detail" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Status: Demand" }));
    await userEvent.click(within(sheet).getByRole("menuitem", { name: /Needs info/ }));
    expect(within(sheet).getByRole("textbox", { name: "Question to ask" })).toHaveValue(
      "Could you confirm what price you can pay (per kWh or per unit) and by when you need them?",
    );
    await userEvent.click(within(sheet).getByRole("button", { name: "Move to Qualifying" }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ status: "qualifying", qualify_question: "Could you confirm what price you can pay (per kWh or per unit) and by when you need them?" }),
    }));
  });
  it("lists the open question on Qualifying rows and moves an answered row back to Demand", async () => {
    const fetchMock = setup([row({ status: "qualifying", qualify_question: "What price per kWh?", qualify_asked_on: null })]);
    await userEvent.click(await screen.findByRole("button", { name: /Qualifying 1/ }));
    expect(await screen.findByText("What price per kWh?")).toBeInTheDocument();
    expect(screen.getByText("Not asked yet")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Green Voltage/ }));
    const sheet = screen.getByRole("region", { name: "Demand detail" });
    await userEvent.click(within(sheet).getByRole("button", { name: "Status: Qualifying" }));
    await userEvent.click(within(sheet).getByRole("menuitem", { name: /Answered, back to Demand/ }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_1/activity", expect.objectContaining({
      method: "POST", body: JSON.stringify({ kind: "status", title: "Answered: What price per kWh?" }),
    }));
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/btd_1", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ status: "open", qualify_question: null, qualify_asked_on: null }),
    }));
  });
});
