// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { BulkListingView } from "@/lib/bulk-listing";
import { ListingDetail } from "./listing-detail";

vi.mock("./use-registry", () => ({ useRegistry: () => ({ fields: { packs: [] }, specLists: {}, specNumbers: {}, specLabels: {}, specGroups: {} }) }));
afterEach(() => vi.unstubAllGlobals());
const listing = (id: string): BulkListingView => ({
  id, kind: "supply", party: "Example seller", title: "24 EV packs", summary: "Available packs", note: null,
  company_id: null, person_id: null, contact: null, email: null, quantity: "24", location: "Berlin", status: "open", closed_reason: null,
  observed_on: null, next_action: null, next_due: null, waiting_on: "us", waiting_since: "2026-10-20", spec: {}, context: { trade_kind: "packs" }, created_at: "2026-10-20", updated_at: "2026-10-20", is_trade: true, furthest_stage: "contract_out", stage: "Signed & Paid",
});
const mount = (id: string) => render(<ListingDetail id={id} today="2026-10-21" onClose={() => {}} onOpenListing={() => {}} />);
function mockListing(row: BulkListingView | null) {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/context") ? { person: null, buyer: null, mail: [{ id: "fallback", subject: "Unrelated email", at: "2026-10-20", direction: "inbound" }] }
      : url.endsWith("/conversation") ? { conversation: [{ id: "m1", channel: "mail", direction: "inbound", title: "Batch confirmed", body: "All 24 packs ready", at: "2026-10-20", href: null, ref: null }] }
      : url.endsWith("/fields") ? { fields: [] } : url.endsWith("/offers") ? { offers: [] }
      : url.endsWith("/activity") ? { activity: [] } : url.endsWith("/supply") ? { groups: [], shortlisted: [], requirement: { pinned: [] } }
      : { listing: row }
  )));
  vi.stubGlobal("fetch", fetch);
  return fetch;
}
it("renders a supply trade, the ordered tabs and its labelled seller conversation", async () => {
  const fetch = mockListing(listing("s1")); mount("s1");
  expect(await screen.findByRole("heading", { name: "24 EV packs" })).toBeInTheDocument();
  expect(screen.getByText("TRADE")).toBeInTheDocument();
  expect(document.querySelector("[data-waiting-on=us]")).toHaveTextContent(/On us/);
  expect(Array.from(screen.getByRole("navigation", { name: "Detail sections" }).querySelectorAll("button")).map((t) => t.textContent)).toEqual(["Details", "Matcha", "Matches", "Offers", "Documents", "History"]);
  expect(await screen.findByRole("heading", { name: "Conversation with Example seller" })).toBeInTheDocument();
  fireEvent.click(await screen.findByRole("button", { name: /Email.*1 message/ }));
  expect(screen.getByText("Batch confirmed")).toBeInTheDocument();
  expect(screen.queryByText("Unrelated email")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Offers" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/bulk-listings/s1/offers", expect.anything()));
  expect(screen.queryByRole("button", { name: /Suggested/ })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/bulk-listings/s1/activity", expect.anything()));
});
it("shimmers while loading a listing", () => {
  vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {}))); mount("loading");
  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByText("Loading listing")).toBeInTheDocument();
});
it("keeps a demand in the existing demand panel using listing context routes", async () => {
  const row = listing("d-new"); row.kind = "demand";
  row.demand = { id: row.id, buyer: "Example buyer", wants: "12 Ioniq packs", kind: "standing", spec: {}, context: {}, context_notes: [], status: "open", fits: [], trades: [], missing: [], inventory_matches: [] } as unknown as NonNullable<BulkListingView["demand"]>;
  const fetch = mockListing(row); mount(row.id);
  expect(await screen.findByRole("region", { name: "Demand detail" })).toBeInTheDocument();
  expect(screen.getByRole("heading", { name: "12 × Ioniq packs" })).toBeInTheDocument();
  await waitFor(() => expect(fetch).toHaveBeenCalledWith("/api/bulk-listings/d-new/context", expect.anything()));
});
it("shows not-found text for a missing listing", async () => {
  mockListing(null); mount("missing");
  expect(await screen.findByText("This listing no longer exists.")).toBeInTheDocument();
});

it("keeps a listing whose fields have no alternatives (null) from crashing the page", async () => {
  const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(
    url.endsWith("/fields") ? { fields: [{ field_key: "model", value: "EPES233", status: "confirmed", visibility: "teaser", source_label: null, source_url: null, source_date: null, alternatives: null }] }
      : url.endsWith("/context") ? { person: null, mail: [] } : url.endsWith("/conversation") ? { conversation: [] } : { listing: listing("s2") })));
  vi.stubGlobal("fetch", fetch);
  mount("s2");
  expect(await screen.findByRole("heading", { name: "24 EV packs" })).toBeInTheDocument();
  expect(screen.queryByRole("alert")).toBeNull();
});
it("shows a back link instead of a blank page when a listing cannot render", async () => {
  const onClose = vi.fn();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/fields") ? { fields: "oops" } : url.endsWith("/context") ? { person: null, mail: [] } : url.endsWith("/conversation") ? { conversation: [] } : { listing: listing("s3") }))));
  render(<ListingDetail id="s3" today="2026-10-21" onClose={onClose} onOpenListing={() => {}} />);
  const alert = await screen.findByRole("alert");
  expect(alert).toHaveTextContent("could not be displayed");
  fireEvent.click(screen.getByRole("button", { name: /Bulk Trades/ }));
  expect(onClose).toHaveBeenCalled();
});
