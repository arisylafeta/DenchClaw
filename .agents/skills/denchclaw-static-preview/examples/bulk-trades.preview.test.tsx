// @vitest-environment jsdom
// Example render test for the denchclaw-static-preview skill. Copy it next to the component
// (apps/web/app/components/bulk-trades/zz-preview.test.tsx), run it, then delete the copy.
// Sample data is the Bulk Trades design canvas's illustrative data as of 28 Sep 2026; it is not
// production data. PREVIEW_OUT is the folder the rendered views are written to.
import React from "react";
import { writeFileSync } from "node:fs";
import { it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import type { BulkTrade } from "@/lib/bulk-trades";
import type { TradeDetail, TradeField } from "@/lib/bulk-trade-details";
import { BulkTradesView } from "./bulk-trades-view";

const T = (o: Partial<BulkTrade>): BulkTrade => ({
  id: o.title!, title: "", trade_stage: "Needs info", trade_kind: null, fact_line: null, next_step: null,
  next_step_due: null, waiting_on: "us", waiting_since: null, owner_user_id: null, owner_name: null, value: null,
  last_touched: null, clear_by: null, ship_by: null, transport_class: null, tfs_needed: "unknown",
  updated_at: "2026-09-28T09:00:00Z", ...o,
});
const TRADES = [
  T({ title: "Unbox Robotics", fact_line: "Recycling · 6 batteries, Istanbul", value: "[fee]", next_step: "Send recycling quote (chased 3 times)", next_step_due: "2026-09-19", last_touched: "2026-09-23" }),
  T({ title: "Connected Energy · 2× E-STOR", trade_stage: "With buyers", fact_line: "Recycling · 51 Kangoo packs, 2 × 14.5 t", value: "[fee]", next_step: "Send Eneris and Fivrec quotes, with loading", next_step_due: "2026-09-25", last_touched: "2026-09-25" }),
  T({ title: "Iveco FPT eBS69", trade_stage: "With buyers", fact_line: "200 packs · 13.8 MWh", value: "€276–345k", next_step: "Send Markus 5 bulk options", next_step_due: "2026-09-26", last_touched: "2026-09-18" }),
  T({ title: "LKQ Synetiq", trade_stage: "With buyers", fact_line: "20 Vivaro packs + forecasting pilot", value: "[value]", next_step: "Send pilot proposal", next_step_due: "2026-09-24", last_touched: "2026-09-17" }),
  T({ title: "Oklahoma LG Chem cells", trade_stage: "Closing", fact_line: "WHS Energy → Ashish · LC received", value: "$500–600k", next_step: "Send letter of credit to supplier, then inspect", next_step_due: "2026-09-28", last_touched: "2026-09-28" }),
  T({ title: "Iveco FPT eBS37", trade_kind: "packs", clear_by: "2026-11-15", trade_stage: "With buyers", fact_line: "161 packs · 5.9 MWh · auction live", value: "€119–149k", next_step: "Follow up Fabio: auction interest and missing specs", next_step_due: "2026-09-28", last_touched: "2026-09-28" }),
  T({ title: "Opium Power", fact_line: "90 MW BESS portfolio", value: "[value]", last_touched: "2026-09-13" }),
  T({ title: "GSR Energy · Peugeot e-208", fact_line: "7 packs >87% SoH + 14 other", value: "[value]", next_step: "Reply to stock details", last_touched: "2026-09-24" }),
  T({ title: "Kokam / SolarEdge NMC cells", trade_stage: "With buyers", fact_line: "~50,000 cells", value: "€38.50/cell", next_step: "Take to buyer network", last_touched: "2026-09-24" }),
  T({ title: "Stellantis · Fiat 500e", fact_line: "600 packs · 14.3 MWh", value: "[quote]", next_step: "They send manufacture date and photos. Our quote due 30 Sep", waiting_on: "them", waiting_since: "2026-09-22", next_step_due: "2026-09-30", last_touched: "2026-09-22" }),
  T({ title: "S2A Modular · Tesla Megapack", fact_line: "1 Megapack", value: "$450k floor", next_step: "They send documentation", waiting_on: "them", waiting_since: "2026-09-22", last_touched: "2026-09-22" }),
  T({ title: "Armex Energy · 12 BESS sites", fact_line: "BYD LFP, NEC, Tesla Powerpack · 22.7 MWh", value: "[indicative]", next_step: "Send indicative resale values", next_step_due: "2026-10-02", last_touched: "2026-09-25" }),
];

const F = (field_key: string, value: string, status: TradeField["status"], visibility: TradeField["visibility"], source_label: string | null, source_date: string | null = null, alternatives: TradeField["alternatives"] = []): TradeField =>
  ({ field_key, value, status, visibility, source_label, source_url: source_label ? "https://mail.google.com/" : null, source_date, alternatives });
const EBS37 = TRADES.find((t) => t.title === "Iveco FPT eBS37")!;
const DETAIL: TradeDetail = {
  trade: { ...EBS37, fact_line: "161 packs + 9 incomplete · NMC · 36.9 kWh · Supplier: Iveco (Fabio Papa) · Clear warehouse by mid-Nov", next_step: "Follow up Fabio: share auction interest and ask for the 5 missing items" },
  buyers: [
    { id: "b1", name: "Markus", contact: "German 10 MW storage park", wants: "36-pack pilot", status: "To contact", last_touch_on: "2026-09-23", last_touch_via: "Call", chase_on: null, latest_bid: null },
    { id: "b2", name: "STN Power Systems", contact: "Jason Lovell", wants: "7–8 / month", status: "To contact", last_touch_on: "2026-09-23", last_touch_via: "Call", chase_on: null, latest_bid: null },
    { id: "b3", name: "Fenecon", contact: "[contact]", wants: "[volume]", status: "To contact", last_touch_on: null, last_touch_via: null, chase_on: null, latest_bid: null },
    { id: "b4", name: "Zibi", contact: "[company]", wants: "[volume]", status: "To contact", last_touch_on: null, last_touch_via: null, chase_on: null, latest_bid: null },
  ],
  contacts: [
    { id: "c1", name: "Fabio Papa", company: "Iveco", email: null, phone: null },
    { id: "c2", name: "Alessandro Delbue", company: "FPT", email: null, phone: null },
    { id: "c3", name: "Domenico Mangiola", company: "Iveco", email: null, phone: null },
  ],
  fields: [
    F("model", "FPT eBS37", "confirmed", "teaser", "Gmail · Fabio Papa", "2026-09-11"),
    F("chemistry", "NMC", "confirmed", "teaser", "Auction listing"),
    F("capacity", "36.9 kWh", "confirmed", "teaser", "Auction listing"),
    F("quantity", "161 + 9 incomplete", "conflict", "teaser", "Gmail · Fabio Papa", "2026-09-11",
      [{ value: "about 200", source_label: "Call with Fabio", source_url: "https://mail.google.com/", source_date: "2026-09-18" }]),
    F("soh", ">90% on complete packs (supplier estimate)", "unverified", "after_nda", "Gmail · Fabio Papa", "2026-09-11"),
    F("test_data", "Not performed", "missing", "after_loi", "Gmail · Fabio Papa", "2026-09-11"),
    F("seller_price", "€20–25/kWh net", "unverified", "never", "Call with Fabio", "2026-09-18"),
    F("sale_route", "Invite-only two-week auction", "confirmed", "teaser", "Call with Fabio", "2026-09-18"),
    F("clear_by", "Mid-Nov to early Dec", "unverified", "after_nda", "Call with Fabio", "2026-09-18"),
  ],
  files: [
    { id: "f1", file_name: "[Iveco inventory list].xlsx", file_type: "Stock list", byte_size: 1, source_label: "Gmail · Fabio Papa", source_date: "2026-09-11", visibility: "never", created_at: "" },
    { id: "f2", file_name: "[ReBattery case study].pdf", file_type: "Deck", byte_size: 1, source_label: "Gmail · sent by Alex", source_date: "2026-09-24", visibility: "teaser", created_at: "" },
  ],
};

it("renders the preview views", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-28T12:00:00Z"));
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.includes("/api/bulk-trades/") ? DETAIL : { trades: TRADES, owners: [] }))));
  render(<BulkTradesView />);
  await screen.findByText("Unbox Robotics");
  writeFileSync(process.env.PREVIEW_OUT + "/list.html", document.body.innerHTML);
  fireEvent.click(screen.getByRole("button", { name: "Board" }));
  await screen.findByRole("region", { name: "Closing" });
  writeFileSync(process.env.PREVIEW_OUT + "/board.html", document.body.innerHTML);
  fireEvent.click(screen.getByRole("button", { name: "List" }));
  fireEvent.click(await screen.findByRole("button", { name: /Iveco FPT eBS37/ }));
  await screen.findByRole("heading", { level: 1, name: "Iveco FPT eBS37" });
  writeFileSync(process.env.PREVIEW_OUT + "/overview.html", document.body.innerHTML);
  fireEvent.click(screen.getByRole("tab", { name: "Data and files" }));
  await screen.findByText("Still needed", { exact: false });
  writeFileSync(process.env.PREVIEW_OUT + "/data.html", document.body.innerHTML);
});
