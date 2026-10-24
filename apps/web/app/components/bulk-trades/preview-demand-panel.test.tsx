// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Demand } from "@/lib/bulk-demand";
import { PreviewDemandPanel } from "./preview-demand-panel";

vi.mock("./use-registry", () => ({ useRegistry: () => null }));
afterEach(() => vi.unstubAllGlobals());

it("shimmers header and buyer values in their real shell until async reads finish", async () => {
  const releases: Record<string, (response: Response) => void> = {};
  vi.stubGlobal("fetch", vi.fn((url: string) => new Promise<Response>((resolve) => { releases[url] = resolve; })));
  const demand = {
    id: "d1", buyer: "Example company", wants: "12 Ioniq packs", kind: "standing", spec: {}, context: {}, context_notes: [],
    status: "open", company_id: null, person_id: null, contact: null, email: null, tier: null, score: null,
    activity_count: 0, fits: [], trades: [], missing: [], inventory_matches: [],
  } as unknown as Demand;
  render(<PreviewDemandPanel demand={demand} today="2026-10-20" onChanged={() => {}} onClose={() => {}} onOpenTrade={() => {}} />);
  expect(screen.getByRole("heading", { name: "12 × Ioniq packs" })).toBeInTheDocument();
  expect(screen.getByText("Supplier")).toBeInTheDocument();
  expect(screen.getByText("Capacity per unit").parentElement!.querySelector('[aria-hidden="true"]')).not.toBeNull();
  expect(screen.getByText("Stage")).toBeInTheDocument();
  expect(screen.getByText("Loading demand details")).toBeInTheDocument();
  const card = document.querySelector('[aria-label="Buyer card"]')!;
  expect(card.querySelectorAll('[aria-hidden="true"]').length).toBeGreaterThan(3);
  releases["/api/bulk-trades/demand/d1/supply"](new Response(JSON.stringify({ groups: [], shortlisted: [{ seller: "Example supplier" }], requirement: { pinned: [] } })));
  releases["/api/bulk-listings/d1/context"](new Response(JSON.stringify({ buyer: { profile: { tier: "A", owner: "Alex" }, demand: [] }, mail: [], person: { name: "Example buyer", email: "buyer@example.test", company_name: "Example company" } })));
  expect(await screen.findByText("Example supplier")).toBeInTheDocument();
  expect(await screen.findByRole("heading", { name: "Example buyer" })).toBeInTheDocument();
  expect(screen.getByText("buyer@example.test")).toBeInTheDocument();
  expect(screen.getByText("Alex")).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText("Loading demand details")).not.toBeInTheDocument());
});

it("keeps the buyer's email thread under their card, each message opening in place and linking to the exact email", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.endsWith("/context")
      ? { buyer: null, person: null, mail: [{ id: "m1", thread_id: "gmail_thread_9", direction: "inbound", subject: "Re: pilot", preview: "Still reviewing", body: "Still reviewing internally, LFP alternatives welcome.", from_email: "buyer@example.test", at: "2026-10-06T09:00:00Z" }] }
      : url.endsWith("/supply") ? { groups: [], shortlisted: [], requirement: { pinned: [] } }
      : url.endsWith("/conversation") ? { conversation: null } : {};
    return new Response(JSON.stringify(body));
  }));
  const demand = {
    id: "d2", buyer: "Example company", contact: "Markus Nolden", wants: "24 packs", kind: "request", spec: {}, context: {}, context_notes: [],
    status: "open", company_id: null, person_id: null, email: null, tier: null, score: null,
    activity_count: 0, fits: [], trades: [], missing: [], inventory_matches: [],
  } as unknown as Demand;
  render(<PreviewDemandPanel demand={demand} today="2026-10-20" onChanged={() => {}} onClose={() => {}} onOpenTrade={() => {}} />);
  expect(screen.queryByRole("button", { name: /WhatsApp/ })).not.toBeInTheDocument();
  const accordion = await screen.findByRole("button", { name: /Email.*1 message/ });
  expect(screen.queryByRole("heading", { name: /Email with/ })).not.toBeInTheDocument();
  // The accordion sits inside the buyer card and links to the thread itself.
  expect(screen.getByRole("region", { name: "Buyer card" })).toContainElement(accordion);
  expect(screen.getByRole("link", { name: "Open email thread" })).toHaveAttribute("href", "/?crm=inbox&view=conversations&thread=gmail_thread_9&crmOnly=false");
  expect(accordion).toHaveAttribute("aria-expanded", "false");
  expect(screen.queryByText("Re: pilot")).not.toBeInTheDocument();
  fireEvent.click(accordion);
  expect(await screen.findByRole("link", { name: "Open email" })).toHaveAttribute("href", "/?crm=inbox&view=conversations&thread=gmail_thread_9&crmOnly=false");
  const row = screen.getByRole("button", { name: /Re: pilot/ });
  expect(row).toHaveAttribute("aria-expanded", "false");
});

it("shows the labelled conversation, email and WhatsApp, when threads are labelled for this demand", async () => {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const body = url.endsWith("/context") ? { buyer: null, person: null, mail: [{ id: "m1", thread_id: "t_other", direction: "inbound", subject: "Unrelated mail", preview: "x", from_email: "b@e.test", at: "2026-10-06T09:00:00Z" }] }
      : url.endsWith("/supply") ? { groups: [], shortlisted: [], requirement: { pinned: [] } }
      : url.endsWith("/conversation") ? { conversation: [
        { id: "wa1", channel: "whatsapp", direction: "inbound", title: "Prince", body: "Can you do the Tesla modules?", at: "2026-10-08T10:00:00Z", ref: "wa_t1", href: "/?crm=inbox&view=whatsapp&thread=wa_t1" },
        { id: "m2", channel: "mail", direction: "outbound", subject: null, title: "Re: shortlist", body: "Sent the eight packs", at: "2026-10-07T10:00:00Z", ref: "t1", href: "/?crm=inbox&view=conversations&thread=t1&crmOnly=false" }] } : {};
    return new Response(JSON.stringify(body));
  }));
  const demand = { id: "d3", buyer: "Prince", contact: "Prince", wants: "8 packs", kind: "request", spec: {}, context: {}, context_notes: [], status: "open", company_id: null, person_id: null, email: null, tier: null, score: null,
    activity_count: 0, fits: [], trades: [], missing: [], inventory_matches: [] } as unknown as Demand;
  render(<PreviewDemandPanel demand={demand} today="2026-10-20" onChanged={() => {}} onClose={() => {}} onOpenTrade={() => {}} />);
  expect(screen.queryByRole("heading", { name: /Conversation with/ })).not.toBeInTheDocument();
  const whatsapp = await screen.findByRole("button", { name: /WhatsApp.*1 message/ });
  const email = screen.getByRole("button", { name: /Email.*1 message/ });
  expect(screen.getByRole("link", { name: "Open WhatsApp chat" })).toHaveAttribute("href", "/?crm=inbox&view=whatsapp&thread=wa_t1");
  expect(screen.getByRole("region", { name: "Buyer card" })).toContainElement(whatsapp);
  // Each channel is one accordion, closed until opened.
  expect(screen.queryByText("Can you do the Tesla modules?")).not.toBeInTheDocument();
  expect(screen.queryByText("Re: shortlist")).not.toBeInTheDocument();
  fireEvent.click(whatsapp);
  fireEvent.click(email);
  expect(screen.getByText("Re: shortlist")).toBeInTheDocument();
  expect(screen.getByText("Can you do the Tesla modules?")).toBeInTheDocument();
  expect(screen.queryByText("Unrelated mail")).not.toBeInTheDocument();
});

it("shows several pack types as a table under Product, one row each, with prices when set, and drops the single-value cells it replaces", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ groups: [], shortlisted: [], requirement: { pinned: [] }, conversation: null, buyer: null, mail: [], person: null }))));
  const demand = {
    id: "d3", buyer: "Example company", contact: "Prince", wants: "10 packs", kind: "request", volume: 10, volume_unit: "packs", quantity: "10 packs", status: "open",
    spec: { chemistries: ["LFP", "NMC"], formats: ["Packs"] }, context_notes: [], company_id: null, person_id: null, email: null, tier: null, score: null,
    activity_count: 0, fits: [], trades: [], missing: [], inventory_matches: [],
    context: { packs: [
      { title: "Tesla Model 3 RWD 57kWh", chemistry: "LFP", kwh: 57, location: "Adwick-le-Street", url: "https://www.rebattery.io/marketplace/tesla-model-3-rwd-57kwh-c204", seen_on: "2026-10-04", supply_price: 1895, suggested_price: 2550 },
      { title: "Second Tesla Model 3 RWD 57kWh", chemistry: "LFP", kwh: 57, status: "possible" },
    ] },
  } as unknown as Demand;
  render(<PreviewDemandPanel demand={demand} today="2026-10-21" onChanged={() => {}} onClose={() => {}} onOpenTrade={() => {}} />);
  const table = await screen.findByRole("table", { name: "Packs asked for" });
  expect(Array.from(table.querySelectorAll("th")).map((th) => th.textContent)).toEqual(["Pack", "Chemistry", "Capacity", "Collection", "Supply price", "Suggested price", "Named"]);
  expect(screen.getByRole("link", { name: "Tesla Model 3 RWD 57kWh" })).toHaveAttribute("href", "https://www.rebattery.io/marketplace/tesla-model-3-rwd-57kwh-c204");
  expect(screen.getByText("£1,895")).toBeInTheDocument();
  expect(screen.getByText("£2,550")).toBeInTheDocument();
  expect(screen.getByText("to confirm")).toBeInTheDocument();
  expect(screen.queryByRole("link", { name: "Second Tesla Model 3 RWD 57kWh" })).not.toBeInTheDocument();
  expect(screen.getByText("Quantity")).toBeInTheDocument();
  expect(screen.queryByText("Capacity per unit")).not.toBeInTheDocument();
});

it("has a Matches tab, the Bulk Trades supply matching list, with the group count and the same verdict actions", async () => {
  const unit = {
    key: "mp:1", source: "marketplace", seller: "Example Breakers", title: "Volkswagen ID.3", make: "Volkswagen", model: "ID.3", format: "Packs",
    chemistry: "NMC", location: "Yorkshire, United Kingdom", country: "GB", kwh: 58, kwhEstimated: false, units: 1, price: 2400, currency: "GBP",
    currencyAssumed: false, eurPerKwh: 48, eurPerUnit: 2784, marginPct: null, spreadEur: null, cheapestRank: 0, peers: 3, verdict: "exact",
    checks: [], photos: 0, soh: null, year: 2021, partNumber: null, href: "https://www.rebattery.io/marketplace/example", seen: null, ai: null, userVerdict: null,
  };
  const supply = {
    requirement: { pinned: [], unitsNeeded: 10, kwhNeeded: null, buyerEurPerKwh: null, buyerEurPerUnit: null, country: "GB" },
    groups: [{ key: "vw|id.3|58|Packs", label: "Volkswagen ID.3 · 58 kWh", verdict: "exact", units: 3, sellers: ["Example Breakers"], sources: ["marketplace"],
      eurPerKwh: { min: 48, max: 52 }, bestMarginPct: null, covers: { have: 3, need: 10 }, small: false, checks: [], items: [unit], more: 0,
      bySeller: [{ key: "example", name: "Example Breakers", country: "GB", location: "Yorkshire", sources: ["marketplace"], units: 3, kwh: { min: 58, max: 58 },
        eurPerKwh: { min: 48, max: 52 }, totalEur: 8350, pricedUnits: 3, verdict: "exact", withPhotos: 0, items: [unit], more: 0 }],
      fill: { sellers: [{ name: "Example Breakers", units: 3 }], units: 3, need: 10, eurPerKwh: 48 } }],
    totalGroups: 1, smallGroups: 0, totalUnits: 3, considered: { marketplace: 900, trades: 20 }, hiddenCount: 0,
    shortlisted: [], shortlistGone: [], targetBuyEurPerKwh: null, blocked: null, errors: [], fxNote: "Approximate FX",
  };
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/supply") ? supply : url.endsWith("/context") ? { buyer: null, mail: [] } : url.endsWith("/conversation") ? { conversation: null } : {},
  ))));
  const demand = {
    id: "d9", buyer: "Example company", wants: "10 ID.3 packs", kind: "request", spec: {}, context: {}, context_notes: [],
    status: "open", company_id: null, person_id: null, contact: null, email: null, tier: null, score: null,
    activity_count: 0, fits: [], trades: [], missing: [], inventory_matches: [],
  } as unknown as Demand;
  render(<PreviewDemandPanel demand={demand} today="2026-10-20" onChanged={() => {}} onClose={() => {}} onOpenTrade={() => {}} />);
  const tabs = screen.getByRole("navigation", { name: "Detail sections" });
  await waitFor(() => expect(Array.from(tabs.querySelectorAll("button")).map((t) => t.textContent)).toEqual(["Details", "Matches · 1", "Offers", "Documents", "History"]));
  fireEvent.click(screen.getByRole("button", { name: "Matches · 1" }));
  expect(await screen.findByText("Volkswagen ID.3 · 58 kWh")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Marketplace" })).toBeInTheDocument();
});
