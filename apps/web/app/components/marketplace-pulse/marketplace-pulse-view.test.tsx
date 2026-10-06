// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { mondayOf, type PulseData } from "@/lib/marketplace-pulse";
import type { Plan, PlanVersion } from "@/lib/marketplace-pulse-plan";
import { MarketplacePulseView } from "./marketplace-pulse-view";

const monday = (weeksAgo: number) => {
  const day = new Date(`${mondayOf(new Date())}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() - 7 * weeksAgo);
  return day.toISOString().slice(0, 10);
};

const PLAN: Plan = {
  target_paid: 9, target_date: "2099-01-05", start: { date: "2026-10-06", paid: 2 },
  levers: [
    { id: "answer", name: "Answer every buyer within a day", owner: "Alex", status: "Done", steps: { deal: 0.45 } },
    { id: "channels", name: "Channels pointed at listings", owner: "Ari", status: "Planned", steps: { visitors: 690, started: 0.1 } },
  ],
  channels: [{ channel: "Organic search", goal: 6, owner: "Ari", action: "Model pages" }],
};
const OLD: PlanVersion = { id: "v1", plan: { ...PLAN, target_paid: 5 }, created_at: "2026-10-01T10:00:00Z", created_by_name: "Ari" };

const DATA: PulseData = {
  weeks: [
    { week_start: monday(2), values: { visitors: 100, viewed_listing: 60, started_contact: 6, sent_contact: 3, deals_created: 1, deals_paid: 0, paid_value_gbp: 0 } },
    { week_start: monday(1), values: { visitors: 120, viewed_listing: 70, started_contact: 8, sent_contact: 2, deals_created: 1, deals_paid: 1, paid_value_gbp: 3440, drop_no_price: 30, drop_signin_wall: 5, drop_offers_expired: 2 } },
    { week_start: monday(0), values: { visitors: 20, viewed_listing: 13, started_contact: 0, listings_live: 542 } },
  ],
  targets: { visitors: 150 },
  collected_at: "2026-10-06T08:40:00Z",
  follow_ups: [
    {
      key: "acc-2", name: "Waiting Buyer", email: "w@example.org", person_id: null, first_name: null, subscribed: false, opted_out: false, last_contact: null, contacted_since: false,
      latest: { kind: "deal", status: "cancelled", text: "Deal cancelled at payment pending EUR 4,490", listing_title: null, listing_url: null, at: "2026-09-30T10:00:00Z" }, more: 2, similar: [],
    },
    {
      key: "acc-1", name: "Answered Buyer", email: "a@example.org", person_id: "p1", first_name: "Sam", subscribed: false, opted_out: false, last_contact: "2026-10-03T10:00:00Z", contacted_since: true,
      latest: { kind: "offer", status: "expired", text: "Offer expired GBP 900", listing_title: "Kia packs", listing_url: "https://rebattery.io/marketplace/kia", at: "2026-10-01T10:00:00Z" }, more: 0,
      similar: [{ title: "Kia packs B", url: "https://rebattery.io/marketplace/kia-b" }],
    },
  ],
  waiting: [
    { kind: "offer", text: "Offer GBP 900 × 2", buyer: "Offer Buyer", seller: "Seller Ltd", listing_title: "Kia packs", listing_url: "https://rebattery.io/marketplace/kia", at: "2026-10-05T10:00:00Z", expires_at: "2099-10-12T10:00:00Z" },
  ],
  follow_up_error: null,
  sender: "Alex",
  plan: { id: "v2", plan: PLAN, created_at: "2026-10-06T10:00:00Z", created_by_name: "Alex" },
  plan_versions: [{ id: "v2", created_at: "2026-10-06T10:00:00Z", created_by_name: "Alex" }, { id: "v1", created_at: OLD.created_at, created_by_name: "Ari" }],
  breakdowns: [
    ...[[2, 100, 60, 6, 3], [1, 120, 70, 8, 2]].flatMap(([ago, reached, viewed, started, sent]) =>
      ([["funnel_reached", reached], ["funnel_viewed", viewed], ["funnel_started", started], ["funnel_sent", sent]] as const).flatMap(([metric, all]) => [
        { week_start: monday(ago), metric, dimension: "All", value: all },
        { week_start: monday(ago), metric, dimension: "Direct", value: Math.round(all / 2) },
      ])),
    { week_start: monday(1), metric: "channel_visitors", dimension: "Organic search", value: 80 },
    { week_start: monday(1), metric: "channel_viewed", dimension: "Organic search", value: 40 },
    { week_start: monday(1), metric: "channel_sent", dimension: "Organic search", value: 1 },
    { week_start: monday(1), metric: "channel_visitors", dimension: "Paid", value: 13 },
    { week_start: monday(1), metric: "landing_visitors", dimension: "Listing page", value: 40 },
    { week_start: monday(1), metric: "landing_sent", dimension: "Listing page", value: 2 },
    { week_start: monday(1), metric: "referrer_visitors", dimension: "chatgpt.com", value: 11 },
  ],
  suggestions: [
    { id: "s1", batch: "2026-10-06", title: "Answer offers within a day", evidence: "2 offers expired unanswered", action: "Check Waiting on us every morning",
      metric: "drop_offers_expired", owner: "Alex", status: "New", before_week: monday(1), before_value: 2, status_changed_at: null },
    { id: "s2", batch: "2026-10-03", title: "Show prices on offer-only listings", evidence: "30 people saw no price", action: "Ask sellers for a guide price",
      metric: "drop_no_price", owner: "Product", status: "Done", before_week: monday(2), before_value: 40, status_changed_at: "2026-10-05T10:00:00Z" },
  ],
};

type Call = { url: string; method: string; body: Record<string, unknown> | null };

function mockFetch(calls: Call[]) {
  return vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, method, body });
    if (method === "PUT") return new Response(JSON.stringify(body));
    if (url === "/api/marketplace-pulse/email-draft") return new Response(JSON.stringify({ url: "https://mail.google.com/x" }), { status: 201 });
    if (method === "PATCH" && url.startsWith("/api/marketplace-pulse/suggestions/")) {
      const one = DATA.suggestions.find((x) => url.endsWith(x.id))!;
      return new Response(JSON.stringify({ suggestion: { ...one, ...body, status_changed_at: "2026-10-06T12:00:00Z" } }));
    }
    if (url === "/api/marketplace-pulse/plan" && method === "POST") {
      return new Response(JSON.stringify({ plan: { id: "v3", plan: body!.plan, created_at: "2026-10-07T10:00:00Z", created_by_name: "Alex" } }), { status: 201 });
    }
    if (url === "/api/marketplace-pulse/plan/v1") return new Response(JSON.stringify({ plan: OLD }));
    if (url === "/api/marketplace-pulse/buyers") return new Response(JSON.stringify({ person_id: "p9", subscribed: true }), { status: 201 });
    return new Response(JSON.stringify(DATA));
  });
}

describe("MarketplacePulseView", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.unstubAllGlobals());

  it("shows last full week against the week before, its target, and the biggest funnel drop", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);

    const scorecard = await screen.findByRole("region", { name: "Scorecard" });
    expect(scorecard).toHaveTextContent("Visitors120+20% vs week before");
    expect(within(scorecard).getByRole("button", { name: "Target 150 · 80%" })).toBeInTheDocument();
    expect(scorecard).toHaveTextContent("£3,440");

    await userEvent.click(screen.getByRole("tab", { name: "This week so far" }));
    const partial = screen.getByRole("region", { name: "Scorecard" });
    expect(partial).toHaveTextContent("Live listings542");
    expect(partial).not.toHaveTextContent("vs week before");
    expect(within(partial).getByRole("button", { name: "Target 150" })).toBeInTheDocument();
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

  it("shows offers waiting on us, drafts an email with similar listings, and adds a buyer to the CRM", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", mockFetch(calls));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);

    const waiting = await screen.findByRole("region", { name: "Waiting on us" });
    expect(waiting).toHaveTextContent("Offer Buyer");
    expect(waiting).toHaveTextContent("seller Seller Ltd");
    expect(waiting).toHaveTextContent(/Expires in \d+ days/);

    const followUp = screen.getByRole("region", { name: "Follow up" });
    const rows = within(followUp).getAllByRole("row").slice(1);
    await userEvent.click(within(rows[1]).getByRole("button", { name: "Draft email" }));
    await userEvent.click(screen.getByRole("button", { name: "Create Gmail draft" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/marketplace-pulse/email-draft")).toBeDefined());
    const draft = calls.find((c) => c.url === "/api/marketplace-pulse/email-draft")!.body!;
    expect(draft).toMatchObject({ to: "a@example.org", subject: "Kia packs" });
    expect(draft.body).toBe([
      "Hi Sam,", "", "I saw your offer on the Kia packs on ReBattery expired before you got an answer.", "https://rebattery.io/marketplace/kia",
      "", "We also have this one, in case it fits:", "Kia packs B - https://rebattery.io/marketplace/kia-b",
      "", "Is it still of interest?", "", "Alex",
    ].join("\n"));
    expect(await screen.findByText("Draft ready in Gmail")).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);

    await userEvent.click(within(rows[0]).getByRole("button", { name: "Add to CRM" }));
    await waitFor(() => expect(calls.find((c) => c.url === "/api/marketplace-pulse/buyers")?.body).toEqual({ email: "w@example.org", name: "Waiting Buyer" }));
    expect(await within(rows[0]).findByText("On supply updates")).toBeInTheDocument();
  });

  it("shows where buyers drop off for the week and the last 4 weeks, with recordings", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Funnel" }));

    const drops = await screen.findByRole("region", { name: "Where buyers drop off" });
    const row = (label: string) => within(drops).getByText(label).closest("tr")!;
    // 70 viewed, 8 started; over 4 weeks 60 + 70 viewed less 6 + 8 started.
    expect(row("Viewed a listing but started nothing")).toHaveTextContent(/62\s*116/);
    expect(row("Saw no price (offer only)")).toHaveTextContent("30");
    expect(row("Offers expired unanswered")).toHaveTextContent("2");
    const link = within(row("Hit the sign-in box")).getByRole("link", { name: "Watch sessions" });
    expect(decodeURIComponent(link.getAttribute("href")!)).toContain('"id":"auth_dialog_viewed"');
    const noPrice = decodeURIComponent(within(row("Saw no price (offer only)")).getByRole("link").getAttribute("href")!);
    expect(noPrice).toContain('"key":"price_visibility","value":["offer_only"]');
    expect(within(row("Offers expired unanswered")).queryByRole("link")).toBeNull();
  });

  it("shows open suggestions, moves one to Doing, and keeps done ones in the learning log", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", mockFetch(calls));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);

    const box = await screen.findByRole("region", { name: "Suggestions" });
    expect(box).toHaveTextContent("Answer offers within a day");
    expect(box).toHaveTextContent("Should move Offers expired unanswered, 2 in the week of");
    const log = within(box).getByRole("region", { name: "Learning log" });
    // 40 people saw no price when suggested; 30 in the last full week.
    expect(log).toHaveTextContent("Saw no price (offer only): 40 → 30");

    await userEvent.click(within(box).getByRole("button", { name: "Doing: Answer offers within a day" }));
    await waitFor(() => expect(calls.find((c) => c.method === "PATCH")).toMatchObject({ url: "/api/marketplace-pulse/suggestions/s1", body: { status: "Doing" } }));
    expect(await within(box).findByRole("button", { name: "Done: Answer offers within a day" })).toBeInTheDocument();
    expect(within(box).queryByRole("button", { name: "Doing: Answer offers within a day" })).toBeNull();
  });

  it("shows the ordered funnel with its biggest drop and reasons, by channel", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Funnel" }));

    const funnel = screen.getByRole("region", { name: "Funnel" });
    // Last 4 weeks: 220 reached, 130 viewed, 14 started, 5 sent; 14 of 130 is the weakest step.
    expect(funnel).toHaveTextContent("Reached the marketplace220");
    expect(within(funnel).getByText(/11% continue/)).toHaveTextContent("biggest drop");
    expect(within(funnel).getByText(/11% continue/)).toHaveTextContent("30 saw a listing with no price");
    expect(funnel).toHaveTextContent("Deals created");

    await userEvent.click(within(funnel).getByRole("button", { name: "Direct" }));
    expect(funnel).toHaveTextContent("Reached the marketplace110");
    expect(funnel).not.toHaveTextContent("Deals created");
  });

  it("shows where visitors come from and which channels and landing pages convert", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Acquisition" }));

    const channels = screen.getByRole("table", { name: "Channel" });
    const organic = within(channels).getByText("Organic search").closest("tr")!;
    expect(organic).toHaveTextContent("8050%");
    expect(organic).toHaveTextContent("1 (1.3%)");
    expect(organic).toHaveTextContent(/80$/);
    expect(within(channels).getByText("Paid").closest("tr")).toHaveTextContent("No paid visitor viewed a listing.");
    expect(within(screen.getByRole("table", { name: "Landed on" })).getByText("Listing page").closest("tr")).toHaveTextContent("2 (5%)");
    expect(screen.getByRole("region", { name: "Referring sites" })).toHaveTextContent("chatgpt.com11");
  });

  it("remembers the chosen section and shows trends with targets", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    const { unmount } = render(<MarketplacePulseView onOpenPerson={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Trends" }));
    expect(within(screen.getByRole("region", { name: "Conversion rates" })).getByText("Viewed a listing, of visitors").closest("figure")).toHaveTextContent("58.3%");
    expect(screen.getByRole("region", { name: "Weekly history" })).toBeInTheDocument();
    unmount();

    render(<MarketplacePulseView onOpenPerson={() => {}} />);
    expect(await screen.findByRole("region", { name: "Conversion rates" })).toBeInTheDocument();
  });

  it("sums only weeks that have funnel rows and never calls the ReBattery deal steps the biggest drop", async () => {
    const older = { week_start: monday(3), values: { visitors: 500, viewed_listing: 300, started_contact: 30, sent_contact: 20, deals_created: 9, deals_paid: 0 } };
    const data = { ...DATA, weeks: [older, ...DATA.weeks], breakdowns: DATA.breakdowns.filter((b) => b.week_start === monday(1)) };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(data))));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Funnel" }));

    const funnel = screen.getByRole("region", { name: "Funnel" });
    // Only the week of monday(1) has funnel rows: 120 reached, 1 deal, 1 paid; not 500 or 9 from older weeks.
    expect(funnel).toHaveTextContent("in the week of");
    expect(funnel).toHaveTextContent("Reached the marketplace120");
    expect(funnel).toHaveTextContent("Deals createdReBattery1");
    expect(within(funnel).getAllByText(/then, on ReBattery/)).toHaveLength(2);
    expect(within(funnel).getByText(/biggest drop/).parentElement).toHaveTextContent("11% continue");
  });

  it("shows the plan: target, standing, growth model, what each fix is worth, channels and plan against actual", async () => {
    vi.stubGlobal("fetch", mockFetch([]));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Plan" }));

    const head = screen.getByRole("region", { name: "Plan" });
    expect(head).toHaveTextContent("Target: 9.0 paid deals a month by 5 Jan 2099");
    expect(head).toHaveTextContent("Plan saved 6 Oct 2026 by Alex");
    expect(head).toHaveTextContent(/On track|Slightly behind|Off track/);
    const model = screen.getByRole("region", { name: "Growth model" });
    // Today's deal rate is the planned 45%: no week has deals and sends together, so the first fix fills it in.
    expect(within(model).getByRole("listitem", { name: "Deal agreed" })).toHaveTextContent("Plan45%");
    expect(within(model).getByRole("listitem", { name: "Deal agreed" })).toHaveTextContent("Fix: Answer every buyer within a day (Alex)");
    expect(within(model).getByRole("listitem", { name: "Visitors" })).toHaveTextContent("Plan690");
    expect(screen.getByRole("region", { name: "What each fix is worth" })).toBeInTheDocument();
    const channels = screen.getByRole("region", { name: "Channel plan" });
    // One week with 1 send is about 4 a month.
    expect(channels).toHaveTextContent("Organic search4 / 6");
    expect(channels).toHaveTextContent("They are more than 20% apart");
    expect(channels).toHaveTextContent(/Channel goals add up to 6 sends a month; the model needs \d+/);
    expect(screen.getByRole("region", { name: "Plan against actual" })).toBeInTheDocument();
  });

  it("edits the plan into a new version, and restores an older one", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", mockFetch(calls));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Plan" }));

    await userEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    const target = screen.getByLabelText("Target paid deals a month");
    await userEvent.clear(target);
    await userEvent.type(target, "12");
    const fix2 = screen.getByRole("group", { name: "Fix 2" });
    await userEvent.clear(within(fix2).getByLabelText("Started target"));
    await userEvent.type(within(fix2).getByLabelText("Started target"), "12");
    await userEvent.click(screen.getByRole("button", { name: "Move fix 2 up" }));
    await userEvent.click(screen.getByRole("button", { name: "Save as new version" }));

    await waitFor(() => expect(calls.find((c) => c.url === "/api/marketplace-pulse/plan")).toBeDefined());
    const saved = calls.find((c) => c.url === "/api/marketplace-pulse/plan")!.body!.plan as Plan;
    expect(saved.target_paid).toBe(12);
    expect(saved.levers.map((l) => l.id)).toEqual(["channels", "answer"]);
    expect(saved.levers[0].steps).toEqual({ visitors: 690, started: 0.12 });
    expect(saved.channels).toEqual(PLAN.channels);
    expect(await screen.findByText(/Target: 12.0 paid deals a month/)).toBeInTheDocument();

    await userEvent.selectOptions(screen.getByLabelText("Version"), "v1");
    expect(await screen.findByText(/Viewing an older version, read only/)).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Plan" })).toHaveTextContent("Target: 5.0");
    await userEvent.click(screen.getByRole("button", { name: "Restore this version" }));
    await waitFor(() => expect(calls.filter((c) => c.url === "/api/marketplace-pulse/plan")).toHaveLength(2));
    expect((calls.filter((c) => c.url === "/api/marketplace-pulse/plan")[1].body!.plan as Plan).target_paid).toBe(5);
  });

  it("refuses to save a plan that cannot be right", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", mockFetch(calls));
    render(<MarketplacePulseView onOpenPerson={() => {}} />);
    await userEvent.click(await screen.findByRole("tab", { name: "Plan" }));
    await userEvent.click(screen.getByRole("button", { name: "Edit plan" }));
    await userEvent.type(within(screen.getByRole("group", { name: "Fix 1" })).getByLabelText("Paid target"), "150");
    await userEvent.click(screen.getByRole("button", { name: "Save as new version" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("between 0% and 100%");
    expect(calls.some((c) => c.url === "/api/marketplace-pulse/plan")).toBe(false);
  });
});
