// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
  releases["/api/bulk-trades/demand/d1/context"](new Response(JSON.stringify({ buyer: { profile: { tier: "A", owner: "Alex" }, demand: [] }, mail: [], person: { name: "Example buyer", email: "buyer@example.test", company_name: "Example company" } })));
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
      : url.endsWith("/supply") ? { groups: [], shortlisted: [], requirement: { pinned: [] } } : {};
    return new Response(JSON.stringify(body));
  }));
  const demand = {
    id: "d2", buyer: "Example company", contact: "Markus Nolden", wants: "24 packs", kind: "request", spec: {}, context: {}, context_notes: [],
    status: "open", company_id: null, person_id: null, email: null, tier: null, score: null,
    activity_count: 0, fits: [], trades: [], missing: [], inventory_matches: [],
  } as unknown as Demand;
  render(<PreviewDemandPanel demand={demand} today="2026-10-20" onChanged={() => {}} onClose={() => {}} onOpenTrade={() => {}} />);
  expect(await screen.findByRole("heading", { name: "Email with Markus" })).toBeInTheDocument();
  expect(await screen.findByRole("link", { name: /Open email/ })).toHaveAttribute("href", "/?crm=inbox&view=conversations&thread=gmail_thread_9&crmOnly=false");
  const row = screen.getByRole("button", { name: /Re: pilot/ });
  expect(row).toHaveAttribute("aria-expanded", "false");
});
