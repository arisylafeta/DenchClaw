// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SheetRow } from "@/lib/bulk-sheet";
import { computeScorecard } from "@/lib/bulk-scorecard";
import { forgetShared } from "./trade-ui";
import { TodayView } from "./today-view";

const row = (o: Partial<SheetRow>): SheetRow => ({
  key: o.id ?? "r", id: o.id ?? "r", kind: "supply", side: "seller", title: `Lot ${o.id}`, company: "Seller Ltd", company_id: null, category: null,
  progress: "Qualified", tone: "new", score: null, latest: null, next_action: null, next_due: null, owner: "Alex", touched: null, ...o,
});
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function stubFetch(mentions: unknown[] = [], scorecard: unknown = {}) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === "/api/bulk-scorecard") return new Response(JSON.stringify(scorecard));
    if (url.startsWith("/api/bulk-mentions?") || url === "/api/bulk-mentions") return new Response(JSON.stringify({ person: "Alex", me: "Alex", mentions }));
    return new Response("{}");
  }));
  return calls;
}

const view = (rows: SheetRow[], extra: Partial<Parameters<typeof TodayView>[0]> = {}) => render(
  <TodayView rows={rows} owner="all" loading={false} error={null} today={new Date().toISOString().slice(0, 10)}
    onOpen={vi.fn()} onNext={vi.fn(async () => undefined)} onOpenBoard={vi.fn()} {...extra} />);

describe("Today (slice 3)", () => {
  afterEach(() => { vi.unstubAllGlobals(); forgetShared(); });

  it("lists deals in New for more than 7 days with Move on and Remove, and removes one with a reason", async () => {
    const calls = stubFetch();
    const onOpen = vi.fn();
    const onChanged = vi.fn();
    view([row({ id: "old", progress: "New", stage_since: daysAgo(9) }), row({ id: "week", progress: "New", stage_since: daysAgo(6) })], { onOpen, onChanged });
    const block = screen.getByRole("region", { name: "Stuck in New" });
    expect(within(block).getByText("Seller Ltd: Lot old")).toBeTruthy();
    expect(within(block).queryByText(/Lot week/)).toBeNull();
    fireEvent.click(within(block).getByRole("button", { name: "Move on" }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: "old" }));
    fireEvent.click(within(block).getAllByRole("button", { name: "Remove" })[0]);
    fireEvent.change(within(block).getByLabelText("Why it is removed"), { target: { value: "no_longer_needed" } });
    fireEvent.change(within(block).getByLabelText("In a few words"), { target: { value: "Sold elsewhere" } });
    fireEvent.click(within(block).getAllByRole("button", { name: "Remove" }).at(-1)!);
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const post = calls.find((c) => c.url === "/api/bulk-listings/old/stuck");
    expect(JSON.parse(String(post?.init?.body))).toEqual({ reason: "no_longer_needed", why: "Sold elsewhere" });
  });

  it("warns plainly when an owner has more than 20 active deals", () => {
    stubFetch();
    const many = Array.from({ length: 21 }, (_, i) => row({ id: `s${i}`, owner: "Sean", progress: "Available" }));
    view([...many, row({ id: "a1" })]);
    expect(screen.getByText(/Sean has 21 active deals\. More than 20 is more than one person can work well/)).toBeTruthy();
    expect(screen.queryByText(/Alex has/)).toBeNull();
  });

  it("groups overdue next steps by owner and shows whose move it is from the last message", () => {
    stubFetch();
    view([
      row({ id: "x", owner: "Sean", next_action: "Call Sean's seller", next_due: "2026-01-01", last_in_at: "2026-11-02T09:00:00Z", last_out_at: "2026-11-03T09:00:00Z", waiting_from: "2026-11-03T09:00:00Z" }),
      row({ id: "y", owner: "Alex", next_action: "Send Alex's offer", next_due: "2026-01-02" }),
    ]);
    const overdue = screen.getByRole("region", { name: "Overdue" });
    expect(within(overdue).getAllByRole("region").map((r) => r.getAttribute("aria-label"))).toEqual(["Overdue: Sean", "Overdue: Alex"]);
    expect(within(screen.getByRole("region", { name: "Overdue: Sean" })).getByText(/^Waiting on them · \d+ working days$/)).toBeTruthy();
  });

  it("shows the scorecard: each measure against target, the arrow, and how it is counted one click away", async () => {
    const card = computeScorecard({
      enquiries: [{ id: "e", arrived_at: "2026-12-07T10:00:00Z", replied_at: "2026-12-07T10:30:00Z", card_status: "sent", route: null, sent: null, dismissed_at: null, deal_id: null, deal_created_at: null }],
      listings: [], sheet: [], events: [], runs: [], offers: [],
    }, new Date("2026-12-15T09:00:00Z"));
    stubFetch([], card);
    view([row({ id: "x" })]);
    const block = await screen.findByRole("region", { name: "Scorecard" });
    expect(within(block).getByText(/Week of 7 Dec 2026/)).toBeTruthy();
    const lines = within(block).getAllByRole("listitem");
    expect(lines).toHaveLength(11);
    expect(lines[0]).toHaveTextContent("Enquiries answered within 2 working hours100% (1 of 1)target 80%");
    expect(lines[9]).toHaveTextContent("no data yet");
    expect(within(block).queryByText(/How counted|working hours \(Mon to Fri/)).toBeNull();
    fireEvent.click(within(lines[0]).getByRole("button"));
    expect(within(lines[0]).getByText(/Mon to Fri, 09:00 to 18:00 London/)).toBeTruthy();
    expect(within(lines[0]).getByText(/Baseline 12 Nov 2026: under 11%/)).toBeTruthy();
  });

  it("shows the signed-in person's mentions until they tick them", async () => {
    const calls = stubFetch([{ id: "41", listing_id: "x", listing_title: "Kona lot", text: "@Alex call them", by: "sean@rebattery.io", at: "2026-11-12T09:00:00Z", mentions: ["Alex"], ticked: {} }]);
    view([row({ id: "x" })]);
    const block = await screen.findByRole("region", { name: "Mentions" });
    expect(within(block).getByText("@Alex call them")).toBeTruthy();
    fireEvent.click(within(block).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(calls.some((c) => c.url === "/api/bulk-mentions/41" && c.init?.method === "POST")).toBe(true));
  });
});
