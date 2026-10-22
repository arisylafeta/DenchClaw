// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildHome, type HomeData } from "@/lib/home";
import { weekRange } from "@/lib/home-metrics";
import type { PlatformHome } from "@/lib/home-platform";
import type { BulkHome } from "@/lib/home-bulk";
import type { MetricKey, PulseWeek } from "@/lib/marketplace-pulse";
import { HomeView } from "./home-view";
import { niceMax } from "./home-chart";

const NOW = new Date("2026-10-22T15:00:00Z");
const F = {
  visitors: [254, 234, 137, 85, 95, 101, 110, 113, 142, 97],
  viewed_listing: [115, 110, 83, 49, 62, 64, 71, 66, 94, 50],
  started_contact: [7, 8, 1, 2, 8, 1, 8, 5, 6, 14],
  sent_contact: [1, 4, 1, 1, 6, 1, 4, 1, 4, 3],
  deals_paid: [1, 0, 0, 0, 0, 0, 0, 2, 0, 0],
};
const WEEKS: PulseWeek[] = weekRange("2026-10-12", 10).map((week_start, i) =>
  ({ week_start, values: Object.fromEntries(Object.entries(F).map(([k, v]) => [k as MetricKey, v[i]])) }));
const ENQ = [1, 0, 1, 3, 0, 1, 3, 1, 4, 1, 5, 5, 8];
const PLATFORM: PlatformHome = {
  paid_this_month: 1,
  last_paid_at: "2026-10-02T15:33:27Z",
  fees: { ytd_gbp: 24_618, month_gbp: 6926.6, top_share: 0.966, top_deal_id: "d1", skipped: 0, top_label: "Pylon Technologies", paid_deals_ytd: 4 },
  reply: { within: 7, later: 2, never: 12, open: 2 },
  since_deal: { last_at: "2026-10-02T15:33:25Z", days: 20, enquiries_since: 17 },
  overview: {
    weeks: weekRange("2026-10-19", 13).map((week_start, i) => ({ week_start, enquiries: ENQ[i], opened: 0, paid: 0, partial: i === 12 })),
    enquiries_30d: 22, opened_30d: 1, enquiry_blocks: [4, 5, 22], opened_blocks: [1, 4, 1],
  },
};
const BULK: BulkHome = {
  closed_this_month: 0, lost_this_month: 2,
  closing: [{ title: "Oklahoma Panasonic 2170 cells", value: "$516,800" }],
  order_book: { open: 18, priced: 6, quiet: 7, buy_boxes: 22, buy_boxes_priced: 5 },
  bids: { since: "2026-09-29T20:11:19Z", total_30d: 7, firm_30d: 1, weekly: [
    { week_start: "2026-09-28", all: 4, firm: 1 }, { week_start: "2026-10-05", all: 0, firm: 0 },
    { week_start: "2026-10-12", all: 3, firm: 0 }, { week_start: "2026-10-19", all: 0, firm: 0 },
  ] },
  buyers: { steps: [
    { label: "To contact", count: 17, past: false }, { label: "Teaser sent", count: 42, past: false },
    { label: "NDA, specs", count: 1, past: true }, { label: "Bid in", count: 4, past: true }, { label: "LOI, deposit", count: 1, past: true },
  ], teaser_passed: 6, teaser_total: 48 },
};

const home = (over: Partial<Parameters<typeof buildHome>[0]> = {}): HomeData =>
  buildHome({ now: NOW, weeks: WEEKS, collectedAt: "2026-10-18T08:40:59Z", platform: PLATFORM, platformError: null, bulk: BULK, crmError: null, ...over });

function serve(body: HomeData | { error: string }, status = 200) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe("HomeView", () => {
  it("shows the month's goals, marketplace health, the chart and bulk trades", async () => {
    serve(home());
    render(<HomeView />);
    expect(await screen.findByText("Thursday 22 October · day 22 of 31")).toBeInTheDocument();
    expect(screen.getByText("weekly funnel stale since 18 Oct")).toBeInTheDocument();
    expect(screen.getByText(/Targets: 4 paid a month \(Pulse\) · 2 bulk a month \(19 Oct call\)/)).toBeInTheDocument();

    const goals = within(screen.getByRole("region", { name: "Monthly goals" }));
    expect(goals.getByText("Pace for today: 2.8")).toBeInTheDocument();
    expect(goals.getByText("3 to go")).toBeInTheDocument();
    expect(goals.getByText("3 paid of 26 sent")).toBeInTheDocument();
    expect(goals.getByText("Oklahoma Panasonic 2170 cells, $516,800")).toBeInTheDocument();
    expect(goals.getByText("Lost in October")).toBeInTheDocument();
    expect(goals.getByText("£24.6k")).toBeInTheDocument();
    expect(goals.getByText("97% from one deal (Pylon Technologies). 4 paid deals in total.")).toBeInTheDocument();
    expect(goals.getByText("£6.9k")).toBeInTheDocument();

    const health = within(screen.getByRole("region", { name: "Marketplace health" }));
    expect(health.getByText("of 21 since Aug")).toBeInTheDocument();
    expect(health.getByText("17 enquiries have come in since 2 Oct")).toBeInTheDocument();

    expect(screen.getByRole("heading", { name: "Intent in, deals out" })).toBeInTheDocument();
    expect(screen.getByText("No deals opened since 2 Oct")).toBeInTheDocument();
    expect(screen.getByText("6 / 18")).toBeInTheDocument();
    expect(screen.getByText("5 / 22")).toBeInTheDocument();
    expect(screen.getByText(/6 of 48 buyers who got a teaser/)).toBeInTheDocument();
    expect(screen.getByText("Visitors about half")).toBeInTheDocument();
    expect(screen.getByText("Weekly funnel stale")).toBeInTheDocument();
  });

  it("switches the chart to a funnel step and flags the biggest drop", async () => {
    serve(home());
    render(<HomeView />);
    const send = await screen.findByRole("button", { name: /Start to send/ });
    expect(within(send).getByText("Biggest drop")).toBeInTheDocument();
    expect(within(send).getByText("-39 pts")).toBeInTheDocument();
    await userEvent.click(send);
    expect(send).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("heading", { name: "Start to send" })).toBeInTheDocument();
    expect(screen.getByText("Last 4 weeks (12 of 33)")).toBeInTheDocument();
    expect(screen.getByText("14 started, 3 sent")).toBeInTheDocument();
  });

  it("shows No data yet for the parts it could not read, never 0", async () => {
    serve(home({ platform: null, platformError: "Could not read ReBattery just now, so live marketplace numbers are missing." }));
    render(<HomeView />);
    expect(await screen.findByText(/^Platform data missing/)).toBeInTheDocument();
    expect(screen.getByText("£10k")).toBeInTheDocument();
    expect(screen.getAllByText("No data yet").length).toBeGreaterThan(3);
    expect(screen.getByText("Platform numbers missing:")).toBeInTheDocument();
    // The CRM side still shows.
    expect(screen.getByText("6 / 18")).toBeInTheDocument();
  });

  it("says when Home cannot be loaded and can try again", async () => {
    serve({ error: "Unauthorized" }, 401);
    render(<HomeView />);
    expect(await screen.findByText("Unauthorized")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("niceMax", () => {
  it("rounds an axis up to 1, 2, 2.5, 5 or 10 times a power of ten", () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(8)).toBe(10);
    expect(niceMax(142)).toBe(200);
    expect(niceMax(210)).toBe(250);
    expect(niceMax(4)).toBe(5);
  });
});
