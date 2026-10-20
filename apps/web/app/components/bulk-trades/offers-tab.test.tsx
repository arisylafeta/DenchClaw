// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Offer, ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import { OffersTab } from "./offers-tab";
import { forgetShared } from "./trade-ui";

const offer: Offer = {
  id: "bof_1", listing_id: "d1", role: "counterparty", person_id: null, company_id: null, name: "Attero Recycling", contact: "a@attero.example",
  stage: "bid_in", declined_reason: null, wants: null, last_touch_on: "2026-10-12", last_touch_via: "mail",
  terms: { amount: 380, currency: "EUR", unit: "pack", firmness: "firm" }, next_step: "Send specs", next_due: null,
  updated_at: "2026-10-12T10:00:00Z", last_message_at: "2026-10-12T10:00:00Z", messages: 2,
};
const thread: ThreadEntry[] = [
  { id: "m1", channel: "mail", direction: "inbound", title: "Re: packs", body: "We can bid 380 per pack", at: "2026-10-12T10:00:00Z", ref: "t1" },
  { id: "a1", channel: "note", direction: null, title: "Called, wants specs", body: null, at: "2026-10-11T09:00:00Z", ref: null },
];

function stub(calls: { url: string; method: string; body?: string }[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/offers") && !init?.method) return json({ offers: [offer] });
    if (url.endsWith("/offers/bof_1") && init?.method === "PATCH") return json({ offer: { ...offer, stage: "loi" } });
    if (url.endsWith("/offers/bof_1")) return json({ offer, thread });
    return json({});
  }));
}

describe("Offers tab", () => {
  afterEach(() => { vi.unstubAllGlobals(); forgetShared(); });

  it("lists a thread per person and opens the full conversation", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    stub(calls);
    render(<OffersTab demandId="d1" supply={null} onChanged={() => {}} />);
    expect(await screen.findByText("Attero Recycling")).toBeInTheDocument();
    expect(screen.getByText("Bid in")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Attero Recycling"));
    expect(await screen.findByText("Re: packs")).toBeInTheDocument();
    expect(screen.getByText("Called, wants specs")).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByRole("combobox", { name: "Stage" }), "loi");
    expect(calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ stage: "loi" }))).toBe(true);
  });
});
