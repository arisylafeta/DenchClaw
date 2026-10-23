// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Offer, ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import { OffersTab } from "./offers-tab";
import { forgetShared } from "./trade-ui";

const offer: Offer = {
  id: "bof_1", listing_id: "d1", role: "counterparty", person_id: null, company_id: null, name: "Attero Recycling", contact: "a@attero.example",
  stage: "offered", declined_reason: null, wants: null, last_touch_on: "2026-10-12", last_touch_via: "mail",
  terms: { amount: 380, currency: "EUR", unit: "pack", firmness: "firm" }, next_step: "Send specs", next_due: null,
  updated_at: "2026-10-12T10:00:00Z", last_message_at: "2026-10-12T10:00:00Z", messages: 2, threads: [], incoming: false,
};
const thread: ThreadEntry[] = [
  { id: "m1", channel: "mail", direction: "inbound", title: "Re: packs", body: "We can bid 380 per pack", at: "2026-10-12T10:00:00Z", ref: "t1", href: "/?crm=inbox&view=conversations&thread=t1&crmOnly=false" },
  { id: "a1", channel: "note", direction: null, title: "Called, wants specs", body: null, at: "2026-10-11T09:00:00Z", ref: null, href: null },
];

function stub(calls: { url: string; method: string; body?: string }[]) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
    const json = (b: unknown) => ({ ok: true, status: 200, json: async () => b });
    if (url.endsWith("/offers") && !init?.method) return json({ offers: [offer] });
    if (url.endsWith("/offers/bof_1") && init?.method === "PATCH") return json({ offer: { ...offer, stage: "contract_out" } });
    if (url.endsWith("/offers/bof_1")) return json({ offer, thread });
    return json({});
  }));
}

describe("Offers tab", () => {
  afterEach(() => { vi.unstubAllGlobals(); forgetShared(); });

  it("keeps list rows and inventory actions visible until values arrive", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
    const view = render(<OffersTab demandId="d1" supply={null} supplyLoading onChanged={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.getByRole("button", { name: "New offer" })).toBeEnabled();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    // Suggestions never mix with threads: they live behind their own toggle and are inert while loading.
    await userEvent.click(screen.getByRole("button", { name: /Suggested/ }));
    expect(screen.getAllByRole("listitem")).toHaveLength(3);
    for (const button of screen.getAllByRole("button", { name: "Start thread" })) expect(button).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Threads/ }));
    expect(screen.queryByText("Attero Recycling")).not.toBeInTheDocument();
    await act(async () => resolve(new Response(JSON.stringify({ offers: [offer] }))));
    view.rerender(<OffersTab demandId="d1" supply={null} onChanged={() => {}} />);
    expect(await screen.findByText("Attero Recycling")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Threads/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("Offered").closest("[data-stage]")).toHaveAttribute("data-stage", "offered");
  });

  it("keeps the thread controls and timeline visible but disabled during hydration", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/offers")
      ? Promise.resolve(new Response(JSON.stringify({ offers: [offer] })))
      : new Promise<Response>((r) => { resolve = r; })));
    render(<OffersTab demandId="d1" supply={null} onChanged={() => {}} />);
    await userEvent.click(await screen.findByText("Attero Recycling"));
    expect(screen.getByRole("status")).toHaveTextContent("Loading thread");
    expect(screen.getByRole("button", { name: /Attero Recycling/ })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("combobox", { name: "Stage" })).toBeDisabled();
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    expect(screen.queryByText("Re: packs")).not.toBeInTheDocument();
    await act(async () => resolve(new Response(JSON.stringify({ offer, thread }))));
    expect(await screen.findByText("Re: packs")).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Stage" })).toBeEnabled();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("lists a thread per person and opens the full conversation", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    stub(calls);
    render(<OffersTab demandId="d1" supply={null} onChanged={() => {}} />);
    expect(await screen.findByText("Attero Recycling")).toBeInTheDocument();
    expect(screen.getByText("Offered")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Attero Recycling"));
    expect(await screen.findByText("Re: packs")).toBeInTheDocument();
    expect(screen.getByText("Called, wants specs")).toBeInTheDocument();
    // Each mail points at the exact email in the inbox.
    expect(screen.getByRole("link", { name: /Open email/ })).toHaveAttribute("href", "/?crm=inbox&view=conversations&thread=t1&crmOnly=false");
    // Threads and messages are accordions: the row stays, a message opens to its full text.
    expect(screen.getByRole("button", { name: /Attero Recycling/ })).toHaveAttribute("aria-expanded", "true");
    const message = screen.getByRole("button", { name: /Re: packs/ });
    expect(message).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(message);
    expect(message).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(screen.getByRole("button", { name: /Attero Recycling/ }));
    expect(screen.queryByText("Called, wants specs")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Attero Recycling/ }));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Stage" }), "contract_out");
    expect(calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ stage: "contract_out" }))).toBe(true);
  });
});
