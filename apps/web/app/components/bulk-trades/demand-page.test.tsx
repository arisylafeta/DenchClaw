// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Demand } from "@/lib/bulk-demand";
import { DemandPage } from "./demand-page";
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

afterEach(() => vi.unstubAllGlobals());
function setup(rows: Demand[]) {
  const fetchMock = vi.fn(
    async (url: string, _init?: RequestInit) =>
      new Response(
        JSON.stringify(
          url.endsWith("/activity") ? { activity: [] } : { demand: rows },
        ),
      ),
  );
  vi.stubGlobal("fetch", fetchMock);
  render(<DemandPage today="2026-10-16" onOpenTrade={() => {}} />);
  return fetchMock;
}
describe("Demand visualization", () => {
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
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Category" }), "duplicate");
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/demand/research",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ action: "category", reason: "duplicate" }) }));
    expect(screen.getByRole("button", { name: "Reopen" })).toBeInTheDocument();
  });
  it("keeps status actions and the activity composer working behind the visual sheet", async () => {
    const fetchMock = setup([row({})]);
    await userEvent.click(
      await screen.findByRole("button", { name: /Green Voltage/ }),
    );
    const sheet = screen.getByRole("dialog", { name: "Demand detail" });
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Still wanted" }),
    );
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
    const sheet = screen.getByRole("dialog", { name: "Demand detail" });
    expect(within(sheet).getByText("Missing to move this")).toBeInTheDocument();
    expect(
      within(sheet).getByRole("button", { name: "Edit demand" }),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole("button", { name: "Still wanted" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Suitable supply" }),
    );
    expect(within(sheet).getByText("Strong fit")).toBeInTheDocument();
    expect(
      within(sheet).getByText("No market candidates yet"),
    ).toBeInTheDocument();
    expect(
      within(sheet).getByRole("button", { name: "Copy ID" }),
    ).toBeInTheDocument();
    await userEvent.click(
      within(sheet).getByRole("button", { name: "Activity" }),
    );
    expect(
      within(sheet).getByRole("textbox", { name: "Activity title" }),
    ).toBeInTheDocument();
  });
  it("shows failed status actions visibly in Overview without opening Activity", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "PATCH")
          return new Response(
            JSON.stringify({ error: "Could not confirm demand." }),
            { status: 500 },
          );
        return new Response(
          JSON.stringify(
            url.endsWith("/activity")
              ? { activity: [] }
              : { demand: [row({})] },
          ),
        );
      }),
    );
    render(<DemandPage today="2026-10-16" onOpenTrade={() => {}} />);
    await userEvent.click(
      await screen.findByRole("button", { name: /Green Voltage/ }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Still wanted" }));
    expect(await screen.findByText("Could not confirm demand.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Overview" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });
});
