// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mondayOf, type PulseData } from "@/lib/marketplace-pulse";
import { MarketplacePulseView } from "./marketplace-pulse-view";

const monday = (weeksAgo: number) => {
  const day = new Date(`${mondayOf(new Date())}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 7 * weeksAgo);
  return day.toISOString().slice(0, 10);
};

const DATA: PulseData = {
  weeks: [
    { week_start: monday(2), values: { visitors: 100, viewed_listing: 60, started_contact: 6, sent_contact: 3, deals_created: 1, deals_paid: 0, paid_value_gbp: 0 } },
    { week_start: monday(1), values: { visitors: 120, viewed_listing: 70, started_contact: 8, sent_contact: 2, deals_created: 1, deals_paid: 1, paid_value_gbp: 3440 } },
    { week_start: monday(0), values: { visitors: 20, viewed_listing: 13, started_contact: 0, listings_live: 542 } },
  ],
  targets: { visitors: 150 },
  collected_at: "2026-10-06T08:40:00Z",
  follow_ups: [
    {
      key: "acc-2", name: "Waiting Buyer", email: "w@example.org", person_id: null, last_contact: null, contacted_since: false,
      latest: { kind: "deal", text: "Deal cancelled at payment pending EUR 4,490", listing_title: null, listing_url: null, at: "2026-09-30T10:00:00Z" }, more: 2,
    },
    {
      key: "acc-1", name: "Answered Buyer", email: "a@example.org", person_id: "p1", last_contact: "2026-10-03T10:00:00Z", contacted_since: true,
      latest: { kind: "offer", text: "Offer expired GBP 900", listing_title: "Kia packs", listing_url: "https://rebattery.io/marketplace/kia", at: "2026-10-01T10:00:00Z" }, more: 0,
    },
  ],
  follow_up_error: null,
};

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function mockFetch(calls: Call[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (method === "PUT") return new Response(JSON.stringify(body));
    return new Response(JSON.stringify(DATA));
  });
}

describe("MarketplacePulseView", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows last full week against the week before, its target, and the biggest funnel drop", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);

    const scorecard = await screen.findByRole("region", { name: "Scorecard" });
    expect(scorecard).toHaveTextContent("Visitors120+20% vs week before");
    expect(within(scorecard).getByRole("button", { name: "Target 150 · 80%" })).toBeInTheDocument();
    expect(scorecard).toHaveTextContent("£3,440");

    // 8 of 70 started, the lowest step rate of the week.
    const funnel = screen.getByRole("region", { name: "Funnel" });
    expect(within(funnel).getByText(/11% of the step above/)).toHaveTextContent("biggest drop");

    await userEvent.click(within(funnel).getByRole("button", { name: "Last 4 weeks" }));
    expect(funnel).toHaveTextContent("Visitors220");

    await userEvent.click(screen.getByRole("tab", { name: "This week so far" }));
    expect(screen.getByRole("region", { name: "Scorecard" })).toHaveTextContent("Live listings542");
  });

  it("lists buyers in the order given, with their latest signal, and opens a CRM person", async () => {
    const open = vi.fn();
    vi.stubGlobal("fetch", mockFetch([]));
    render(<MarketplacePulseView onOpenPerson={open} />);

    const followUp = await screen.findByRole("region", { name: "Follow up" });
    expect(followUp).toHaveTextContent("1 not contacted since");
    const rows = within(followUp).getAllByRole("row").slice(1);
    expect(rows[0]).toHaveTextContent("Waiting Buyer");
    expect(rows[0]).toHaveTextContent("+2 more in 30 days");
    expect(rows[0]).toHaveTextContent("Not in CRM");
    expect(within(rows[1]).getByRole("link", { name: "Kia packs" })).toHaveAttribute("href", "https://rebattery.io/marketplace/kia");

    await userEvent.click(within(rows[1]).getByRole("button", { name: "Answered Buyer" }));
    expect(open).toHaveBeenCalledWith("p1");
  });

  it("sets a weekly target", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", mockFetch(calls));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);

    const scorecard = await screen.findByRole("region", { name: "Scorecard" });
    await userEvent.click(within(scorecard).getAllByRole("button", { name: "Set weekly target" })[0]);
    await userEvent.type(screen.getByLabelText("Weekly target for Viewed a listing"), "90");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(calls.find((c) => c.method === "PUT")).toMatchObject({
      url: "/api/marketplace-pulse/targets", body: { metric: "viewed_listing", weekly_target: 90 },
    }));
    expect(await within(scorecard).findByRole("button", { name: /^Target 90/ })).toBeInTheDocument();
  });
});
