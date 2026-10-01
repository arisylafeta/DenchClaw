// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { todayInLondon, type BulkTrade } from "@/lib/bulk-trades";
import type { Buyer, TradeDetail, TradeField } from "@/lib/bulk-trade-details";
import { TradePage } from "./trade-page";

const today = todayInLondon();

const TRADE: BulkTrade = {
  id: "bt_1", title: "Synthetic eBS37", trade_stage: "With buyers", trade_kind: "packs",
  fact_line: "161 packs · NMC", next_step: "Follow up supplier", next_step_due: today, waiting_on: "us",
  next_step_contact_id: null, next_step_buyer_id: null,
  waiting_since: null, owner_user_id: null, owner_name: null, value: null, last_touched: null, clear_by: null,
  ship_by: null, transport_class: null, tfs_needed: "unknown", listing_id: "lst_1", auction_slug: null, auction_status: null, auction_closes_at: null, updated_at: "2026-09-28T09:00:00Z",
};

const BUYER: Buyer = {
  id: "btb_1", name: "Synthetic Storage", person_id: null, person_email: null, email_tracking: null, link_clicked_at: null, contact: "Test Person", wants: "36-pack pilot", status: "To contact",
  last_touch_on: null, last_touch_via: null, chase_on: null, latest_bid: null, auction: null,
};

const field = (field_key: string, value: string, visibility: TradeField["visibility"] = "teaser"): TradeField => ({
  field_key, value, status: "confirmed", visibility, source_label: null, source_url: null, source_date: null, alternatives: [],
});

const DETAIL: TradeDetail = {
  trade: TRADE,
  buyers: [BUYER],
  contacts: [{ id: "btc_1", name: "Sam Supplier", company: "Synthetic Co", email: "sam@example.test", phone: null }],
  fields: [field("model", "FPT eBS37"), field("chemistry", "NMC"), field("seller_price", "€20/kWh", "never"), field("location", "Turin", "after_loi")],
  files: [],
};

function mockFetch() {
  return vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "PATCH" && url.includes("/buyers/")) {
      return new Response(JSON.stringify({ buyer: { ...BUYER, ...JSON.parse(String(init.body)), last_touch_on: today } }));
    }
    if (url.startsWith("/api/bulk-trades/people")) {
      return new Response(JSON.stringify({
        people: [{ id: "p_1", name: "Tess Buyer", company: "Synthetic Storage", email: "tess@example.test", opted_out: false }],
        companies: [{ id: "c_1", name: "Fresh Storage GmbH", people: 3 }],
      }));
    }
    if (init?.method === "POST" && url.endsWith("/email-draft")) {
      return new Response(JSON.stringify({ url: "https://mail.google.com/mail/u/#drafts" }), { status: 201 });
    }
    if (init?.method === "POST" && url.endsWith("/bids")) {
      return new Response(JSON.stringify({
        buyer: { ...BUYER, status: "Bid in", latest_bid: { id: "1", buyer_id: "btb_1", created_at: "", ...JSON.parse(String(init.body)) } },
      }), { status: 201 });
    }
    return new Response(JSON.stringify(DETAIL));
  });
}

function renderPage() {
  return render(<TradePage tradeId="bt_1" owners={[]} today={today} onBack={() => {}} onTradeSaved={() => {}} />);
}

describe("TradePage overview", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("shows the next step and what is missing for each step", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();

    const bar = await screen.findByRole("region", { name: "Next step" });
    expect(bar).toHaveTextContent("Follow up supplier");
    expect(within(bar).queryByText("WhatsApp")).not.toBeInTheDocument();

    const missing = screen.getByRole("region", { name: "Missing" });
    expect(within(missing).getByText("Manufacture date").nextSibling).toHaveTextContent("Teaser");
  });

  it("asks the supplier for missing items through a Gmail draft", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /Ask Sam for all/ }));
    expect(screen.getByLabelText("To")).toHaveValue("sam@example.test");
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).value).toMatch(/Hi Sam,[\s\S]*- Manufacture date/);

    await userEvent.click(screen.getByRole("button", { name: "Create Gmail draft" }));
    expect(await screen.findByRole("link", { name: "Open in Gmail" })).toHaveAttribute("href", "https://mail.google.com/mail/u/#drafts");
    const [, init] = fetchMock.mock.calls.find(([url]) => url === "/api/bulk-trades/bt_1/email-draft")!;
    expect(JSON.parse(String(init!.body))).toMatchObject({ to: "sam@example.test", subject: "Synthetic eBS37" });
  });

  it("saves a buyer status change straight away", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.selectOptions(await screen.findByLabelText("Status for Synthetic Storage"), "NDA, specs sent");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_1/buyers/btb_1", expect.objectContaining({
      method: "PATCH", body: JSON.stringify({ status: "NDA, specs sent" }),
    })));
  });

  it("records a structured bid and shows it on the row", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Add bid" }));
    await userEvent.type(screen.getByLabelText("Amount"), "22");
    await userEvent.click(screen.getByRole("button", { name: "Save bid" }));

    expect(await screen.findByRole("button", { name: "€22/kWh ind." })).toBeInTheDocument();
    expect(screen.getByLabelText("Status for Synthetic Storage")).toHaveValue("Bid in");
  });

  it("drafts a teaser without price or location and marks buyers only on confirm", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByLabelText("Select Synthetic Storage"));
    await userEvent.click(screen.getByRole("button", { name: "Send teaser to selected" }));
    const draft = (screen.getByLabelText("Teaser text") as HTMLTextAreaElement).value;
    expect(draft).toContain("Pack model: FPT eBS37");
    expect(draft).not.toMatch(/€20|Turin|Synthetic Co/);
    expect(fetchMock).not.toHaveBeenCalledWith(expect.stringContaining("/buyers/"), expect.anything());

    await userEvent.click(screen.getByRole("button", { name: "Mark 1 as Teaser sent" }));
    await waitFor(() => expect(screen.getByLabelText("Status for Synthetic Storage")).toHaveValue("Teaser sent"));
  });

  it("shows both sides of a conflict and settles it with Alex's pick", async () => {
    const conflicted: TradeField = {
      ...field("quantity", "161 + 9 incomplete"), status: "conflict", source_label: "Gmail · Sam",
      alternatives: [{ value: "about 200", source_label: "Call with Sam", source_url: null, source_date: "2026-09-18" }],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/fields/quantity/resolve")) {
        return new Response(JSON.stringify({ field: { ...conflicted, status: "confirmed", alternatives: [] } }));
      }
      return new Response(JSON.stringify({ ...DETAIL, fields: [...DETAIL.fields, conflicted], files: [] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole("tab", { name: "Data and files" }));
    const row = screen.getByRole("button", { name: "Edit Quantity" });
    expect(row).toHaveTextContent("161 + 9 incomplete");
    expect(row).toHaveTextContent("about 200");
    expect(row).toHaveTextContent("Call with Sam · 18 Sep");
    expect(screen.getByText(/Still needed: photos, bms or test report/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "Keep 161 + 9 incomplete" }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_1/fields/quantity/resolve", expect.objectContaining({
      body: JSON.stringify({ choice: -1 }),
    })));
    await waitFor(() => expect(screen.getByRole("button", { name: "Edit Quantity" })).toHaveTextContent("Confirmed"));
  });

  it("shows campaign email tracking on a linked buyer", async () => {
    const tracked = {
      ...BUYER, person_id: "p_1", person_email: "tess@example.test",
      email_tracking: { campaign: "eBS37 teaser", sent_at: "2026-09-24T09:00:00Z", delivered_at: "2026-09-24T09:01:00Z", bounced_at: null, opened_at: "2026-09-25T08:00:00Z", clicked_at: "2026-09-25T08:02:00Z" },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...DETAIL, buyers: [tracked] }))));
    renderPage();
    expect(await screen.findByText("Teaser email: Clicked 25 Sep")).toBeInTheDocument();
  });

  it("links a buyer to a CRM person", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: /Synthetic Storage/ }));
    await userEvent.type(screen.getByPlaceholderText("Search people or companies"), "tess");
    await userEvent.click(await screen.findByRole("option", { name: /Tess Buyer/ }));
    await userEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([url, init]) => url === "/api/bulk-trades/bt_1/buyers/btb_1" && init?.method === "PATCH");
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({ person_id: "p_1" });
    });
  });

  it("drafts a teaser per emailable buyer with a neutral subject", async () => {
    const withEmail = { ...BUYER, person_id: "p_1", person_email: "tess@example.test", contact: "Tess Buyer" };
    const noEmail = { ...BUYER, id: "btb_2", name: "No Email Ltd" };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/email-draft")) return new Response(JSON.stringify({ url: "https://mail.google.com/", tracked_links: 0 }), { status: 201 });
      return new Response(JSON.stringify({ ...DETAIL, buyers: [withEmail, noEmail] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByLabelText("Select Synthetic Storage"));
    await userEvent.click(screen.getByLabelText("Select No Email Ltd"));
    await userEvent.click(screen.getByRole("button", { name: "Send teaser to selected" }));
    expect(screen.getByText(/No email for No Email Ltd/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Create 1 Gmail draft" }));

    expect(await screen.findByRole("status")).toHaveTextContent("1 Gmail draft created");
    const drafts = fetchMock.mock.calls.filter(([url]) => url.endsWith("/email-draft"));
    expect(drafts).toHaveLength(1);
    const body = JSON.parse(String(drafts[0][1]!.body));
    expect(body).toMatchObject({ to: "tess@example.test", subject: "Battery batch available", buyer_id: "btb_1" });
    expect(body.subject + body.body).not.toMatch(/Synthetic eBS37|€20|Turin/);
    expect(body.body).toMatch(/^Hi Tess,/);
  });

  it("shows a click on a tracked email link", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      ...DETAIL, buyers: [{ ...BUYER, link_clicked_at: "2026-09-26T10:00:00Z" }],
    }))));
    renderPage();
    expect(await screen.findByText("Clicked email link 26 Sep")).toBeInTheDocument();
  });

  it("retries only the teaser drafts that failed", async () => {
    const first = { ...BUYER, person_id: "p_1", person_email: "tess@example.test", contact: "Tess Buyer" };
    const second = { ...BUYER, id: "btb_2", name: "Second Buyer", person_id: "p_2", person_email: "sid@example.test", contact: "Sid" };
    let failSecond = true;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/email-draft")) {
        const body = JSON.parse(String(init!.body));
        if (body.buyer_id === "btb_2" && failSecond) {
          failSecond = false;
          return new Response(JSON.stringify({ error: "Gmail did not accept the draft." }), { status: 502 });
        }
        return new Response(JSON.stringify({ url: "https://mail.google.com/", tracked_links: 0 }), { status: 201 });
      }
      return new Response(JSON.stringify({ ...DETAIL, buyers: [first, second] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByLabelText("Select Synthetic Storage"));
    await userEvent.click(screen.getByLabelText("Select Second Buyer"));
    await userEvent.click(screen.getByRole("button", { name: "Send teaser to selected" }));
    await userEvent.click(screen.getByRole("button", { name: "Create 2 Gmail drafts" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Gmail did not accept the draft.");

    await userEvent.click(screen.getByRole("button", { name: "Create 1 Gmail draft" }));
    expect(await screen.findByRole("status")).toHaveTextContent("2 Gmail drafts created");
    const ids = fetchMock.mock.calls.filter(([url]) => url.endsWith("/email-draft")).map(([, init]) => JSON.parse(String(init!.body)).buyer_id);
    expect(ids).toEqual(["btb_1", "btb_2", "btb_2"]);
  });

  it("closes the snooze menu with Escape", async () => {
    vi.stubGlobal("fetch", mockFetch());
    renderPage();
    await userEvent.click(await screen.findByRole("button", { name: "Snooze" }));
    expect(screen.getByRole("menu")).toBeInTheDocument();
    await userEvent.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("shows an inbox-check finding under the buyers and applies it only on accept", async () => {
    const proposal = {
      id: "41", lot_id: "bt_1", kind: "buyer_update", target: "btb_1", proposed: { status: "Bid in" },
      summary: "Synthetic Storage sent a bid", quote: "We can offer 22 per kWh", source_kind: "gmail",
      source_url: "https://mail.google.com/x", source_label: "Gmail · tess@example.test", source_at: "2026-09-29T09:00:00Z",
      created_at: "2026-09-29T12:00:00Z",
    };
    let decided = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === "/api/bulk-trades/proposals/41") { decided = true; return new Response(JSON.stringify({ lot_id: "bt_1" })); }
      return new Response(JSON.stringify({ ...DETAIL, proposals: decided ? [] : [proposal] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const row = await screen.findByRole("group", { name: "New: Synthetic Storage sent a bid" });
    expect(row).toHaveTextContent("“We can offer 22 per kWh”");
    expect(within(row).getByRole("link", { name: /Gmail · tess@example.test/ })).toHaveAttribute("href", "https://mail.google.com/x");
    await userEvent.click(within(row).getByRole("button", { name: "Update buyer" }));
    await waitFor(() => expect(screen.queryByRole("group", { name: /New:/ })).not.toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/proposals/41", expect.objectContaining({ body: JSON.stringify({ action: "accept" }) }));
  });

  it("adds a buyer by picking a CRM company or person", async () => {
    const fetchMock = mockFetch();
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Add buyer" }));
    await userEvent.type(screen.getByPlaceholderText("Search people or companies"), "fresh");
    await userEvent.click(await screen.findByRole("option", { name: /Fresh Storage GmbH/ }));
    expect(screen.getByLabelText("Buyer")).toHaveValue("Fresh Storage GmbH");

    await userEvent.type(screen.getByPlaceholderText("Search people or companies"), "tess");
    await userEvent.click(await screen.findByRole("option", { name: /Tess Buyer/ }));
    expect(screen.getByLabelText("Contact")).toHaveValue("Tess Buyer");
    expect(screen.getByText("Tess Buyer · tess@example.test")).toBeInTheDocument();
  });

  it("opens PDFs and photos in a new tab and shows photos as thumbnails", async () => {
    const files = [
      { id: "f1", file_name: "pack.jpg", file_type: "Photos", byte_size: 1, source_label: null, source_date: null, visibility: "never", created_at: "" },
      { id: "f2", file_name: "Datasheet.pdf", file_type: "Datasheet", byte_size: 1, source_label: null, source_date: null, visibility: "teaser", created_at: "" },
      { id: "f3", file_name: "stock.xlsx", file_type: "Stock list", byte_size: 1, source_label: null, source_date: null, visibility: "never", created_at: "" },
    ];
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ ...DETAIL, files }))));
    renderPage();

    const card = await screen.findByRole("region", { name: "Files" });
    const pdf = within(card).getByRole("link", { name: /Datasheet.pdf/ });
    expect(pdf).toHaveAttribute("href", "/api/bulk-trades/bt_1/files/f2?view=1");
    expect(pdf).toHaveAttribute("target", "_blank");
    expect(within(card).getByRole("link", { name: /stock.xlsx/ })).toHaveAttribute("href", "/api/bulk-trades/bt_1/files/f3");
    expect(card.querySelector("img")).toHaveAttribute("src", "/api/bulk-trades/bt_1/files/f1?view=1");
  });

  it("shows the next step as one line with who it is for, and emails that person", async () => {
    const withWho = {
      ...DETAIL,
      trade: { ...TRADE, next_step: "Send the BMS answers", next_step_buyer_id: "btb_1" },
      buyers: [{ ...BUYER, contact: "Tess Buyer", person_email: "tess@example.test" }],
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/email-draft")) return new Response(JSON.stringify({ url: "https://mail.google.com/", tracked_links: 0 }), { status: 201 });
      if (init?.method === "PATCH") return new Response(JSON.stringify({ trade: { ...withWho.trade, ...JSON.parse(String(init.body)) } }));
      return new Response(JSON.stringify(withWho));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const strip = await screen.findByRole("region", { name: "Next step" });
    expect(strip).toHaveTextContent("Due today");
    expect(strip).toHaveTextContent("For Tess Buyer · Synthetic Storage (buyer)");
    await userEvent.click(within(strip).getByRole("button", { name: "Email Tess" }));
    expect(screen.getByLabelText("To")).toHaveValue("tess@example.test");
    expect(screen.getByLabelText("Subject")).toHaveValue("Battery batch available");
    await userEvent.click(screen.getByRole("button", { name: "Close" }));

    await userEvent.click(within(strip).getByRole("button", { name: "Done, set next" }));
    await userEvent.type(screen.getByLabelText("Next step (one action)"), "Chase Sam for the address");
    await userEvent.selectOptions(screen.getByLabelText("For"), "contact:btc_1");
    await userEvent.click(screen.getByRole("button", { name: "Save next step" }));
    await waitFor(() => {
      const call = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH");
      expect(JSON.parse(String(call![1]!.body))).toMatchObject({
        next_step: "Chase Sam for the address", next_step_contact_id: "btc_1", next_step_buyer_id: null,
      });
    });
  });

  it("offers to mark a buyer as Teaser sent when a teaser email went out", async () => {
    const tracked = { ...BUYER, email_tracking: { campaign: "eBS37", sent_at: "2026-09-24T09:00:00Z", delivered_at: "2026-09-24T09:01:00Z", bounced_at: null, opened_at: null, clicked_at: null } };
    const fetchMock = mockFetch();
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === "PATCH") return new Response(JSON.stringify({ buyer: { ...tracked, ...JSON.parse(String(init.body)) } }));
      return new Response(JSON.stringify({ ...DETAIL, buyers: [tracked] }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    await userEvent.click(await screen.findByRole("button", { name: "Mark as Teaser sent?" }));
    await waitFor(() => expect(screen.getByLabelText("Status for Synthetic Storage")).toHaveValue("Teaser sent"));
    expect(screen.queryByRole("button", { name: "Mark as Teaser sent?" })).not.toBeInTheDocument();
  });

  it("reads a trade's past emails on request and says when it last did", async () => {
    let started = false;
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith("/history") && init?.method === "POST") { started = true; return new Response(JSON.stringify({ started: true }), { status: 202 }); }
      return new Response(JSON.stringify({
        ...DETAIL,
        history: started
          ? { status: "running", started_at: "2026-09-29T21:00:00Z", finished_at: null, emails_read: 0, notes_read: 0, proposals_made: 0 }
          : { status: "ok", started_at: "2026-09-28T10:00:00Z", finished_at: "2026-09-28T10:02:00Z", emails_read: 74, notes_read: 1, proposals_made: 12 },
      }));
    });
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    expect(await screen.findByText("Read 28 Sep · 12 updates")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Find data in emails" }));
    expect(await screen.findByRole("button", { name: "Reading emails…" })).toBeDisabled();
    expect(fetchMock).toHaveBeenCalledWith("/api/bulk-trades/bt_1/history", expect.objectContaining({ method: "POST" }));
  });
});
