// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Offer, ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import { OffersTab } from "./offers-tab";
import { forgetShared } from "./trade-ui";

const offer: Offer = {
  id: "bof_1", listing_id: "d1", role: "counterparty", person_id: null, company_id: null, name: "Attero Recycling", contact: "a@attero.example",
  stage: "offered", declined_reason: null, wants: null, last_touch_on: "2026-10-12", last_touch_via: "mail",
  terms: { amount: 380, currency: "EUR", unit: "pack", firmness: "firm" }, next_step: "Send specs", next_due: null, waiting_on: "them", waiting_since: "2026-10-12",
  updated_at: "2026-10-12T10:00:00Z", last_message_at: "2026-10-12T10:00:00Z", messages: 2, threads: [], incoming: false,
  counterpart_id: null, from_kind: null, from_label: null, link_options: [],
  quantity: null, paid_on: null, paid_amount: null, paid_currency: null, take_gbp: null,
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
    const view = render(<OffersTab demandId="d1" onChanged={() => {}} />);
    expect(screen.getByRole("status")).toHaveTextContent("Loading");
    expect(screen.getByRole("button", { name: "New offer" })).toBeEnabled();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    // One list for every listing: no Suggested toggle (suggestions live on Matches).
    expect(screen.queryByRole("button", { name: /Suggested/ })).not.toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(4);
    await act(async () => resolve(new Response(JSON.stringify({ offers: [offer] }))));
    view.rerender(<OffersTab demandId="d1" onChanged={() => {}} />);
    expect(await screen.findByText("Attero Recycling")).toBeInTheDocument();
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Offers · 1" })).toBeInTheDocument();
    expect(screen.getByText(/Waiting on them since/).closest("[data-waiting-on]")).toHaveAttribute("data-waiting-on", "them");
    expect(screen.getByText(/2 messages/)).toBeInTheDocument();
    expect(screen.getByText("Offered").closest("[data-stage]")).toHaveAttribute("data-stage", "offered");
  });

  it("keeps the thread controls and timeline visible but disabled during hydration", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn((url: string) => url.endsWith("/offers")
      ? Promise.resolve(new Response(JSON.stringify({ offers: [offer] })))
      : new Promise<Response>((r) => { resolve = r; })));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
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
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
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

  it("asks for a reason before saving Declined or Lost, then saves both together", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    stub(calls);
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    await userEvent.click(await screen.findByText("Attero Recycling"));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Stage" }), "declined");
    // Nothing is saved until the reason is written.
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const reason = screen.getByLabelText("Outcome reason") as HTMLInputElement;
    const save = screen.getByRole("button", { name: "Save outcome" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(reason, { target: { value: "Price too high" } });
    expect(save.disabled).toBe(false);
    fireEvent.submit(save.closest("form")!);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH"
      && c.body === JSON.stringify({ stage: "declined", declinedReason: "Price too high" }))).toBe(true));
  });

  it("asks for the paid details before saving Paid, then saves them with the stage", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    stub(calls);
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    await userEvent.click(await screen.findByText("Attero Recycling"));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Stage" }), "paid");
    expect(calls.some((c) => c.method === "PATCH")).toBe(false);
    const form = screen.getByRole("form", { name: "Paid details" });
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Paid on"), { target: { value: "2026-12-03" } });
    fireEvent.change(screen.getByLabelText("Amount paid"), { target: { value: "18000" } });
    fireEvent.change(screen.getByLabelText("Quantity (pack)"), { target: { value: "48" } });
    fireEvent.change(screen.getByLabelText("Our take (£)"), { target: { value: "1500" } });
    expect(save.disabled).toBe(false);
    fireEvent.submit(form);
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH"
      && c.body === JSON.stringify({ stage: "paid", paidOn: "2026-12-03", paidAmount: 18000, paidCurrency: "EUR", quantity: 48, takeGbp: 1500 }))).toBe(true));
  });

  it("drafts the offer email and opens it in the side panel", async () => {
    const calls: { url: string; method: string; body?: string }[] = [];
    const draft = {
      id: "d1", state: "draft", identity_key: "alex", transport: "gmail", purpose: "personal", from_email: "alex@rebattery.io",
      to_emails: ["a@attero.example"], cc_emails: [], bcc_emails: [], subject: "40 x 50 kWh NMC packs", body_text: "Hi there,\n\nWe have the packs.\n\nBest,\nAlex",
      body_html: null, thread_id: null, campaign_id: null, created_at: "2026-11-08T10:00:00Z", updated_at: "2026-11-08T10:00:00Z",
      links: [], warnings: [], approval: null, attachments: [], editable: { main: "Hi there,\n\nWe have the packs.\n\nBest,\nAlex", signature: null },
    };
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });
      if (url.endsWith("/offers") && !init?.method) return json({ offers: [offer] });
      if (url.endsWith("/offers/bof_1/draft")) return json({ draftId: "d1", kind: "chase", subject: draft.subject, body: draft.body_text, reused: false });
      if (url.endsWith("/api/mail/drafts/d1")) return json(draft);
      if (url.endsWith("/offers/bof_1")) return json({ offer, thread });
      return json({});
    }));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    await userEvent.click(await screen.findByText("Attero Recycling"));
    await userEvent.click(await screen.findByRole("button", { name: /Draft email/ }));
    expect(calls.some((c) => c.method === "POST" && c.url.endsWith("/offers/bof_1/draft"))).toBe(true);
    expect(await screen.findByRole("region", { name: "Email draft" })).toBeInTheDocument();
    expect((await screen.findAllByText(draft.subject)).length).toBeGreaterThan(0);
  });

  it("marks a chase on an offered row whose email has gone unanswered", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ offers: [{ ...offer, chase_due: true }] }), { status: 200 })));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    expect(await screen.findByText(/Chase due/)).toBeInTheDocument();
    expect(screen.getByText("Chase")).toBeInTheDocument();
  });

  it("offers 'No stock' as a quick decline reason on a request", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/offers") ? { offers: [offer] } : { offer, thread }), { status: 200 })));
    render(<OffersTab demandId="d1" request onChanged={() => {}} />);
    await userEvent.click(await screen.findByText("Attero Recycling"));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Stage" }), "declined");
    await userEvent.click(screen.getByRole("button", { name: "No stock" }));
    expect((screen.getByLabelText("Outcome reason") as HTMLInputElement).value).toBe("No stock");
  });

  it("shows a lost or declined reason on the row", async () => {
    const declined = { ...offer, stage: "declined" as const, declined_reason: "Chose another supplier" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ offers: [declined] }), { status: 200 })));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    expect(await screen.findByText(/Why: Chose another supplier/)).toBeInTheDocument();
  });
});

describe("offer pairing labels (REB-565)", () => {
  beforeEach(() => forgetShared());
  it("labels a mirrored offer with the listing that holds it", async () => {
    const mirrored = { ...offer, id: "bof_2", incoming: true, counterpart_id: "d1", from_kind: "supply" as const, from_label: "WHS Energy, Panasonic Oklahoma" };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ offers: [mirrored] }), { status: 200 })));
    render(<OffersTab demandId="d1" listingId="d1" onChanged={() => {}} />);
    expect(await screen.findByText(/From supply: WHS Energy, Panasonic Oklahoma/)).toBeTruthy();
  });
  it("offers to link an unlinked offer when the buyer has a live listing", async () => {
    const open = { ...offer, link_options: [{ id: "btd_1", label: "ELG Battery, 100k cells" }] };
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? "GET"} ${url}`);
      return new Response(JSON.stringify(url.endsWith("/offers") ? { offers: [open] } : { offer: open, thread: [] }), { status: 200 });
    }));
    render(<OffersTab demandId="s1" listingId="s1" onChanged={() => {}} />);
    fireEvent.click(await screen.findByText("Attero Recycling"));
    const select = await screen.findByLabelText("Link to listing");
    fireEvent.change(select, { target: { value: "btd_1" } });
    await waitFor(() => expect(calls.some((c) => c.startsWith("PATCH"))).toBe(true));
  });
});
