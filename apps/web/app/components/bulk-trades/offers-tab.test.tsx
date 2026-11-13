// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Offer, ThreadEntry } from "@/lib/crm-postgres/bulk-offers";
import type { OfferPosition } from "@/lib/bulk-offer-position";
import { OffersTab } from "./offers-tab";
import { forgetShared } from "./trade-ui";

const position: OfferPosition = {
  turn: "them", since: "2026-10-12T10:00:00Z", days: 3, reason: "You wrote on 12 Oct.", chase: false, next: "Waiting for their reply.", source: "message",
  side: "seller", price: { parts: [{ label: "They ask", value: "€380 / pack", note: "firm", kind: "theirs" }, { label: "You bid", value: "not yet", note: null, kind: "none" }], gap: null },
  moves: [{ at: "2026-10-10T12:00:00Z", who: "They", text: "priced it at €380 / pack." }],
  steps: [{ label: "Asked", state: "done" }, { label: "They priced", state: "done" }, { label: "You bid", state: "now" }, { label: "Agreed", state: "todo" }, { label: "Bought", state: "todo" }],
  hint: null, last_channel: "mail",
};
const offer: Offer & { position: OfferPosition } = {
  id: "bof_1", listing_id: "d1", role: "counterparty", person_id: null, company_id: null, name: "Attero Recycling", contact: "a@attero.example",
  stage: "offered", declined_reason: null, wants: null, last_touch_on: "2026-10-12", last_touch_via: "mail",
  terms: { amount: 380, currency: "EUR", unit: "pack", firmness: "firm" }, next_step: "Send specs", next_step_at: null, next_due: null, waiting_on: "them", waiting_since: "2026-10-12",
  waiting_set_at: null, chase_off_at: null, stage_hint_skip: null,
  updated_at: "2026-10-12T10:00:00Z", last_message_at: "2026-10-12T10:00:00Z", messages: 2, threads: [], incoming: false,
  counterpart_id: null, from_kind: null, from_label: null, link_options: [], position,
};
const thread: ThreadEntry[] = [
  { id: "m1", channel: "mail", direction: "inbound", title: "Re: packs", body: "Hi Alex,\n\nWe can bid 380 per pack.\n\nBest,\nSam\n\nOn Mon, 12 Oct 2026 at 09:00, Alex wrote:\n> What can you bid?", at: "2026-10-12T10:00:00Z", ref: "t1", href: "/?crm=inbox&view=conversations&thread=t1&crmOnly=false" },
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
    expect(screen.getByText("Their move · 3 days").closest("[data-turn]")).toHaveAttribute("data-turn", "them");
    expect(screen.getByRole("region", { name: "Their move" })).toHaveTextContent("Their move · 1");
    expect(screen.getByText("Waiting for their reply.")).toBeInTheDocument();
    expect(screen.getByText("€380 / pack")).toBeInTheDocument();
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
    expect(screen.queryByText(/Re: packs/)).not.toBeInTheDocument();
    await act(async () => resolve(new Response(JSON.stringify({ offer, thread }))));
    expect(await screen.findByText(/Re: packs/)).toBeInTheDocument();
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
    expect(await screen.findByText(/Re: packs/)).toBeInTheDocument();
    expect(screen.getByText("Called, wants specs")).toBeInTheDocument();
    // Their words only: no greeting, sign-off or the earlier email quoted under it.
    const thread = screen.getByRole("region", { name: "Thread" });
    expect(within(thread).getByText("We can bid 380 per pack.")).toBeInTheDocument();
    expect(thread).not.toHaveTextContent("What can you bid?");
    // Each mail points at the exact email in the inbox.
    expect(screen.getByRole("link", { name: /Open email/ })).toHaveAttribute("href", "/?crm=inbox&view=conversations&thread=t1&crmOnly=false");
    expect(within(screen.getByRole("region", { name: "How the price moved" })).getByText(/priced it at €380/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Attero Recycling/ })).toHaveAttribute("aria-expanded", "true");
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
    const due = { ...offer, chase_due: true, position: { ...position, chase: true, next: "Chase: no reply since 12 Oct." } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ offers: [due] }), { status: 200 })));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    expect(await screen.findByText("Chase: no reply since 12 Oct.")).toBeInTheDocument();
    expect(screen.getByText("Chase today")).toBeInTheDocument();
  });

  it("puts your move first, longest wait first, and folds closed ones away", async () => {
    const mine = (id: string, name: string, since: string, days: number) => ({ ...offer, id, name, position: { ...position, turn: "us" as const, since, days, reason: "Their email is the newest message.", next: "Answer their email." } });
    const lost = { ...offer, id: "bof_9", name: "Gone Ltd", stage: "lost" as const, declined_reason: "Price", position: { ...position, turn: "closed" as const, since: null } };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ offers: [mine("bof_2", "Newer Co", "2026-10-11T10:00:00Z", 4), offer, mine("bof_3", "Older Co", "2026-10-01T10:00:00Z", 14), lost] }), { status: 200 })));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    const yours = await screen.findByRole("region", { name: "Your move" });
    expect(within(yours).getAllByRole("button", { name: /Co/ }).map((b) => b.textContent?.match(/Older Co|Newer Co/)?.[0])).toEqual(["Older Co", "Newer Co"]);
    expect(within(yours).getByText("Your move · 14 days").closest("[data-turn]")).toHaveAttribute("data-turn", "us");
    expect(screen.queryByText("Gone Ltd")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Closed · 1/ }));
    expect(screen.getByText("Gone Ltd")).toBeInTheDocument();
  });

  it("asks before moving a stage the messages point to, and remembers Not yet", async () => {
    const hinted = { ...offer, position: { ...position, hint: { stage: "paid" as const, messageId: "m7", at: "2026-10-12T10:00:00Z", channel: "mail" as const, quote: "Paid!" } } };
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      return new Response(JSON.stringify(url.endsWith("/offers") ? { offers: [hinted] } : { offer: hinted }), { status: 200 });
    }));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    expect(await screen.findByText(/Move the stage from/)).toHaveTextContent("Their message on 12 Oct: “Paid!” Move the stage from Offered to Paid?");
    await userEvent.click(screen.getByRole("button", { name: "Not yet" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ stageHintSkip: "m7" }))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Move it" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ stage: "paid" }))).toBe(true));
  });

  it("sets whose move by hand and switches a chase off", async () => {
    const due = { ...offer, position: { ...position, chase: true } };
    const calls: { url: string; method: string; body?: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? "GET", body: init?.body as string | undefined });
      return new Response(JSON.stringify(url.endsWith("/offers") ? { offers: [due] } : { offer: due, thread }), { status: 200 });
    }));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    await userEvent.click(await screen.findByText("Attero Recycling"));
    await userEvent.selectOptions(await screen.findByRole("combobox", { name: "Whose move" }), "us");
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ turn: "us" }))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Don't chase" }));
    await waitFor(() => expect(calls.some((c) => c.method === "PATCH" && c.body === JSON.stringify({ chaseOff: true }))).toBe(true));
  });

  it("shows a run of WhatsApp messages as one bubble", async () => {
    const chat: ThreadEntry[] = [
      { id: "w1", channel: "whatsapp", direction: "inbound", title: "Attero Recycling", body: "Can do 4,200", at: "2026-10-12T14:02:00Z", ref: null, href: null },
      { id: "w2", channel: "whatsapp", direction: "inbound", title: "Attero Recycling", body: "if you take two", at: "2026-10-12T14:05:00Z", ref: null, href: null },
    ];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/offers") ? { offers: [offer] } : { offer, thread: chat }), { status: 200 })));
    render(<OffersTab demandId="d1" onChanged={() => {}} />);
    await userEvent.click(await screen.findByText("Attero Recycling"));
    const region = await screen.findByRole("region", { name: "Thread" });
    expect(await within(region).findByText(/· 2 messages/)).toBeInTheDocument();
    expect(within(region).getByLabelText("WhatsApp")).toBeInTheDocument();
    expect(within(region).getByText((_, el) => el?.textContent === "Can do 4,200\nif you take two")).toBeInTheDocument();
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
