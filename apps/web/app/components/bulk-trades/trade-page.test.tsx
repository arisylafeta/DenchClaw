// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { todayInLondon, type BulkTrade } from "@/lib/bulk-trades";
import type { Buyer, TradeDetail, TradeField } from "@/lib/bulk-trade-details";
import { TradePage } from "./trade-page";

const today = todayInLondon();

const TRADE: BulkTrade = {
  id: "bt_1", title: "Synthetic eBS37", trade_stage: "With buyers", trade_kind: "packs",
  fact_line: "161 packs · NMC", next_step: "Follow up supplier", next_step_due: today, waiting_on: "us",
  waiting_since: null, owner_user_id: null, owner_name: null, value: null, last_touched: null, clear_by: null,
  ship_by: null, transport_class: null, tfs_needed: "unknown", updated_at: "2026-09-28T09:00:00Z",
};

const BUYER: Buyer = {
  id: "btb_1", name: "Synthetic Storage", contact: "Test Person", wants: "36-pack pilot", status: "To contact",
  last_touch_on: null, last_touch_via: null, chase_on: null, latest_bid: null,
};

const field = (field_key: string, value: string, visibility: TradeField["visibility"] = "teaser"): TradeField => ({
  field_key, value, status: "confirmed", visibility, source_label: null, source_url: null, source_date: null, alternatives: [],
});

const DETAIL: TradeDetail = {
  trade: TRADE,
  buyers: [BUYER],
  contacts: [{ id: "btc_1", name: "Sam Supplier", company: "Synthetic Co", email: null, phone: "+44 7700 900123" }],
  fields: [field("model", "FPT eBS37"), field("chemistry", "NMC"), field("seller_price", "€20/kWh", "never"), field("location", "Turin", "after_loi")],
  files: [],
};

function mockFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH" && url.includes("/buyers/")) {
      return new Response(JSON.stringify({ buyer: { ...BUYER, ...JSON.parse(String(init.body)), last_touch_on: today } }));
    }
    if (init?.method === "POST" && url.endsWith("/bids")) {
      return new Response(JSON.stringify({
        buyer: { ...BUYER, status: "Bid in", latest_bid: { id: "1", buyer_id: "btb_1", created_at: "", ...JSON.parse(String(init.body)) } },
      }), { status: 201 });
    }
    return new Response(JSON.stringify(DETAIL));
  });
}

function renderPage() {
  return render(<TradePage tradeId="bt_1" owners={[]} today={today} onBack={() => {}} onTradeSaved={() => {}} />);
}

describe("TradePage overview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the next step, missing data by step and a WhatsApp link to the first contact", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();

    const bar = await screen.findByRole("region", { name: "Next step" });
    expect(bar).toHaveTextContent("Follow up supplier");
    expect(within(bar).getByRole("link", { name: "WhatsApp" }).getAttribute("href")).toMatch(/^https:\/\/wa\.me\/447700900123\?text=Hi%20Sam/);

    const missing = screen.getByRole("region", { name: "Missing" });
    expect(within(missing).getByText("Manufacture date").nextSibling).toHaveTextContent("Teaser");
    expect(within(missing).getByRole("link", { name: /Ask Sam for all/ })).toBeInTheDocument();
  });

  it("saves a buyer status change straight away", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.selectOptions(await screen.findByLabelText("Status for Synthetic Storage"), "NDA, specs sent");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_1/buyers/btb_1", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ status: "NDA, specs sent" }),
    })));
  });

  it("records a structured bid and shows it on the row", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Add bid" }));
    await userEvent.type(screen.getByLabelText("Amount"), "22");
    await userEvent.click(screen.getByRole("button", { name: "Save bid" }));

    expect(await screen.findByRole("button", { name: "€22/kWh ind." })).toBeInTheDocument();
    expect(screen.getByLabelText("Status for Synthetic Storage")).toHaveValue("Bid in");
  });

  it("drafts a teaser without price or location and marks buyers only on confirm", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByLabelText("Select Synthetic Storage"));
    await userEvent.click(screen.getByRole("button", { name: "Send teaser to selected" }));
    const draft = (screen.getByLabelText("Teaser text") as HTMLTextAreaElement).value;
    expect(draft).toContain("Pack model: FPT eBS37");
    expect(draft).not.toMatch(/€20|Turin|Synthetic Co/);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/buyers/"), expect.anything());

    await userEvent.click(screen.getByRole("button", { name: "Mark 1 as Teaser sent" }));
    await waitFor(() => expect(screen.getByLabelText("Status for Synthetic Storage")).toHaveValue("Teaser sent"));
  });

  it("shows both sides of a conflict and settles it with Alex's pick", async () => {
    const conflicted: TradeField = {
      ...field("quantity", "161 + 9 incomplete"), status: "conflict", source_label: "Gmail · Sam",
      alternatives: [{ value: "about 200", source_label: "Call with Sam", source_url: null, source_date: "2026-09-18" }],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/fields/quantity/resolve")) {
        return new Response(JSON.stringify({ field: { ...conflicted, status: "confirmed", alternatives: [] } }));
      }
      return new Response(JSON.stringify({ ...DETAIL, fields: [...DETAIL.fields, conflicted], files: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole("tab", { name: "Data and files" }));
    const row = screen.getByRole("button", { name: "Edit Quantity" });
    expect(row).toHaveTextContent("161 + 9 incomplete");
    expect(row).toHaveTextContent("about 200");
    expect(row).toHaveTextContent("Call with Sam · 18 Sep");
    expect(screen.getByText(/Still needed: photos, bms or test report/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Keep 161 + 9 incomplete" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_1/fields/quantity/resolve", expect.objectContaining({
      body: JSON.stringify({ choice: -1 }),
    })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Quantity" })).toHaveTextContent("Confirmed"));
  });
});
