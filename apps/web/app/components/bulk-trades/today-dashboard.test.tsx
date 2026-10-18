// @vitest-environment jsdom
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { BulkTrade } from "@/lib/bulk-trades";
import type { Demand } from "@/lib/bulk-demand";
import { TodayDashboard } from "./today-dashboard";
const today = "2026-10-16";
function trade(overrides: Partial<BulkTrade>): BulkTrade {
  return {
    origin: "supply",
    seller_ref: null,
    seller_name: null,
    has_seller: false,
    has_buyer: false,
    id: "t",
    title: "Trade",
    trade_stage: "With buyers",
    trade_kind: null,
    fact_line: null,
    next_step: "Follow up",
    next_step_due: today,
    waiting_on: "us",
    waiting_since: null,
    next_step_contact_id: null,
    next_step_buyer_id: null,
    owner_user_id: null,
    owner_name: null,
    value: null,
    last_touched: null,
    clear_by: null,
    ship_by: null,
    transport_class: null,
    tfs_needed: "unknown",
    listing_id: null,
    auction_slug: null,
    auction_status: null,
    auction_closes_at: null,
    hold_until: null,
    hold_reason: null,
    hold_from_stage: null,
    updated_at: "2026-09-28T09:00:00Z",
    ...overrides,
  };
}

function row(overrides: Partial<Demand>): Demand {
  return {
    priority: false,
    missing: [],
    context_notes: [],
    context: {},
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
it("links overdue work, unsent questions, inbox, missing sides and incomplete demand", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            demand: [
              row({
                status: "qualifying",
                missing: ["no price"],
                qualify_question: "What is the budget?",
              }),
            ],
          }),
        ),
    ),
  );
  const openTrade = vi.fn();
  const openDemand = vi.fn();
  const openInbox = vi.fn();
  render(
    <TodayDashboard
      trades={[trade({ next_step_due: "2026-10-15" })]}
      today={today}
      proposalCount={3}
      onOpenTrade={openTrade}
      onOpenDemand={openDemand}
      onOpenInbox={openInbox}
    />,
  );
  await userEvent.click(
    await screen.findByRole("button", { name: /What is the budget/ }),
  );
  expect(openDemand).toHaveBeenCalledWith("btd_1");
  await userEvent.click(
    screen.getByRole("button", { name: /Trade · Follow up/ }),
  );
  expect(openTrade).toHaveBeenCalledWith("t");
  await userEvent.click(
    screen.getByRole("button", { name: "3 proposals to review" }),
  );
  expect(openInbox).toHaveBeenCalledOnce();
  expect(
    screen.getByRole("button", { name: /No seller yet · No buyer yet/ }),
  ).toBeInTheDocument();
  expect(
    screen.getByRole("button", { name: /Missing: no price/ }),
  ).toBeInTheDocument();
});
it("caps work sections at five and expands the remaining items", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ demand: [] }))),
  );
  render(
    <TodayDashboard
      trades={Array.from({ length: 6 }, (_, index) =>
        trade({
          id: `t${index}`,
          title: `Trade ${index}`,
          next_step_due: "2026-10-07",
        }),
      )}
      today={today}
      proposalCount={1}
      onOpenTrade={() => {}}
      onOpenDemand={() => {}}
      onOpenInbox={() => {}}
    />,
  );
  const section = await screen.findByRole("region", {
    name: "Overdue next steps",
  });
  expect(
    screen.getByRole("button", { name: "1 proposal to review" }),
  ).toBeInTheDocument();
  expect(
    within(section).queryByRole("button", { name: /Trade 5/ }),
  ).not.toBeInTheDocument();
  expect(within(section).getAllByText("7 Oct")).toHaveLength(5);
  await userEvent.click(
    within(section).getByRole("button", { name: "+1 more" }),
  );
  expect(
    within(section).getByRole("button", { name: /Trade 5/ }),
  ).toBeInTheDocument();
});
it("keeps paused trades out of overdue next steps", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify({ demand: [] }))),
  );
  render(
    <TodayDashboard
      trades={[
        trade({ id: "live", title: "Live trade", next_step_due: "2026-10-07" }),
        trade({
          id: "paused",
          title: "Paused trade",
          trade_stage: "On hold",
          next_step_due: "2026-10-07",
          hold_until: "2099-01-01",
          hold_reason: "Wait for removal",
        }),
      ]}
      today={today}
      proposalCount={0}
      onOpenTrade={() => {}}
      onOpenDemand={() => {}}
      onOpenInbox={() => {}}
    />,
  );
  const overdue = await screen.findByRole("region", {
    name: "Overdue next steps",
  });
  expect(
    within(overdue).getByRole("button", { name: /Live trade/ }),
  ).toBeInTheDocument();
  expect(
    within(overdue).queryByRole("button", { name: /Paused trade/ }),
  ).not.toBeInTheDocument();
});
it("refreshes qualifying work when the parent invalidates demand after Inbox acceptance", async () => {
  let accepted = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            demand: accepted
              ? [
                  row({
                    buyer: "Accepted buyer",
                    status: "qualifying",
                    qualify_question: "Confirm budget",
                  }),
                ]
              : [],
          }),
        ),
    ),
  );
  const props = {
    trades: [],
    today,
    proposalCount: 0,
    onOpenTrade: () => {},
    onOpenDemand: () => {},
    onOpenInbox: () => {},
  };
  const { rerender } = render(<TodayDashboard {...props} demandRevision={0} />);
  await screen.findByRole("region", { name: "Qualifying questions not sent" });
  expect(
    screen.queryByRole("button", { name: /Accepted buyer/ }),
  ).not.toBeInTheDocument();
  accepted = true;
  rerender(<TodayDashboard {...props} demandRevision={1} />);
  expect(
    await screen.findByRole("button", { name: /Accepted buyer/ }),
  ).toBeInTheDocument();
});
