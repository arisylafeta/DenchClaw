// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MailMessageRow } from "@/lib/mail-types";
import { InboxView, mailQuery } from "./inbox-view";
import { QuickReply, draftCommand } from "./quick-reply";
import InboxPage from "../../../inbox/page";
import CampaignsPage from "../../../campaigns/page";
import CampaignPage from "../../../campaigns/[id]/page";

const navigation = vi.hoisted(() => ({ replace: vi.fn(), redirect: vi.fn(), params: new URLSearchParams() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: navigation.replace }), useSearchParams: () => navigation.params, redirect: navigation.redirect }));
vi.mock("./inbox-layout", () => ({ InboxLayout: ({ list, conversation }: { list: React.ReactNode; conversation: React.ReactNode }) => <div>{list}{conversation}</div> }));
vi.mock("./conversation-pane", () => ({ ConversationPane: () => <div>Conversation pane</div> }));
const at = "2026-10-16T10:00:00Z";
const message = (overrides: Partial<MailMessageRow>): MailMessageRow => ({
  id: "message", thread_id: "thread", campaign_id: null, identity_key: "alex", direction: "inbound", transport: "gmail", purpose: "personal", state: "received", subject: "Synthetic conversation", from_email: "buyer@example.test", from_person_id: null, to_emails: ["alex@rebattery.io"], cc_emails: [], recipient_email: null, person_id: null,
  body_text: "Hello", body_html: null, body_preview: "Hello", sent_at: at, created_at: at, accepted_at: null, delivered_at: null, bounced_at: null, opened_at: null, clicked_at: null, replied_at: null, crm_visible: true, has_attachments: false, gmail_message_id: null, is_self: false, ...overrides,
});
beforeEach(() => {
  navigation.params = new URLSearchParams(); navigation.replace.mockClear(); navigation.redirect.mockClear(); localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }))));
});
afterEach(() => vi.unstubAllGlobals());

describe("merged mail", () => {
  it("does not navigate again when the Mail URL is already synchronized", async () => {
    navigation.params = new URLSearchParams("crm=inbox&view=conversations&crmOnly=true");
    render(<InboxView />);
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    await screen.findByRole("combobox", { name: "direction" });
    expect(navigation.replace).not.toHaveBeenCalled();
  });
  it("switches the mail views and loads the matching shared-store APIs", async () => {
    render(<InboxView />);
    expect(screen.getByRole("tab", { name: "Conversations" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByRole("tab", { name: "Follow-ups" })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Inbox" })).toBeInTheDocument();
    const upper = within(screen.getByRole("tablist", { name: "Inbox sections" }));
    expect(upper.getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Mail", "WhatsApp", "Campaigns"]);
    expect(upper.getByRole("tab", { name: "Mail" })).toHaveAttribute("aria-selected", "true");
    expect(within(screen.getByRole("tablist", { name: "Mail folders" })).getAllByRole("tab").map((tab) => tab.textContent)).toEqual(["Conversations", "Drafts", "Sent"]);
    for (const label of ["Drafts", "Sent", "Conversations"]) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      expect(screen.getByRole("tabpanel", { name: label })).toBeInTheDocument();
    }
    fireEvent.click(upper.getByRole("tab", { name: "Campaigns" }));
    expect(screen.getByRole("tabpanel", { name: "Campaigns" })).toBeInTheDocument();
    expect(screen.queryByRole("tablist", { name: "Mail folders" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "Mail accounts" })).not.toBeInTheDocument();
    fireEvent.click(upper.getByRole("tab", { name: "Mail" }));
    expect(screen.getByRole("tabpanel", { name: "Conversations" })).toBeInTheDocument();
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/mail/messages?"), expect.anything()));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/mail/campaigns?"), expect.anything());
  });
  it("counts unread per server thread, keeps real message totals and includes latest outbound replies", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [
      {...message({}),message_count:3},
      {...message({ id: "latest", thread_id: "replied-thread", campaign_id: "campaign", subject: "Latest outbound reply", direction: "outbound", is_self:true }),message_count:7},
      {...message({ id: "campaign-reply", thread_id: "reply-thread", campaign_id: "campaign", subject: "Campaign reply" }),message_count:2},
    ], nextCursor: null })));
    render(<InboxView />);
    await screen.findByText("Synthetic conversation");
    expect(screen.queryByLabelText("Unread conversations")).toBeNull();
    expect(screen.queryByTitle("Keyboard shortcuts (?)")).toBeNull();
    expect(screen.getByText("Campaign reply")).toBeInTheDocument();
    expect(screen.getByText("Latest outbound reply")).toBeInTheDocument();
    expect(screen.getByText("(7)")).toBeInTheDocument();
    expect(screen.getAllByRole("checkbox")).toHaveLength(5);
  });
  it("hides internal mail by default and requests it only when Show internal is ticked", async () => {
    render(<InboxView />);
    await screen.findByRole("checkbox", { name: /show internal/i });
    expect(vi.mocked(fetch).mock.calls.every(([url]) => !String(url).includes("showInternal"))).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: /show internal/i }));
    await waitFor(() => expect(vi.mocked(fetch)).toHaveBeenLastCalledWith(expect.stringContaining("showInternal=true"), expect.anything()));
  });
  it.each(["conversations", "sent"] as const)("shows counterparties instead of You in %s", async (view) => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [
      message({ id: "out", thread_id: "out", is_self: true, direction: "outbound", from_email: "admin@rebattery.io", to_emails: ["alex@rebattery.io", "buyer@example.test"], counterparty: { email: "buyer@example.test", name: "Synthetic Buyer" } }),
      message({ id: "internal", thread_id: "internal", is_self: true, from_email: "alex@rebattery.io", to_emails: ["ari@rebattery.io"], counterparty: { email: "ari@rebattery.io", name: null } }),
      message({ id: "missing", thread_id: "missing", from_email: null }),
    ], nextCursor: null })));
    render(<InboxView initialView={view} />);
    await screen.findByText("Synthetic Buyer");
    expect(screen.getByText("Unknown sender")).toBeInTheDocument();
    expect(screen.queryByText("You")).not.toBeInTheDocument();
    expect(screen.getAllByText("To:")).toHaveLength(2);
    expect(screen.getByText("ari@rebattery.io")).toBeInTheDocument();
  });
  it("maps all filters to API query parameters including whole-log scope", async () => {
    render(<InboxView initialView="sent" />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search mail" }), { target: { value: "battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Filters" }));
    fireEvent.click(screen.getByRole("button", { name: /^ari/ }));
    fireEvent.change(screen.getByRole("combobox", { name: "event" }), { target: { value: "clicked" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "CRM-only" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/messages\?.*q=battery.*identity=ari.*event=clicked.*crmOnly=false/), expect.anything()));
    expect(screen.getByRole("button", { name: "Remove identity filter" })).toHaveTextContent("ari");
    fireEvent.click(screen.getByRole("button", { name: "Remove identity filter" }));
    await waitFor(() => expect(new URLSearchParams(vi.mocked(fetch).mock.calls.map(([url]) => String(url)).filter((url) => url.includes("/api/mail/messages")).at(-1)!.split("?")[1]).has("identity")).toBe(false));
    const query = new URLSearchParams(mailQuery({ q: "battery & pack", from: "a@example.test", to: "b@example.test", identity: "supply", direction: "outbound", transport: "postmark-broadcast", purpose: "marketing", state: "accepted", event: "opened", campaign: "campaign", thread: "thread", since: "2026-10-01", until: "2026-10-16", crmOnly: false }));
    expect(Object.fromEntries(query)).toEqual({ q: "battery & pack", from: "a@example.test", to: "b@example.test", identity: "supply", direction: "outbound", transport: "postmark-broadcast", purpose: "marketing", state: "accepted", event: "opened", campaign: "campaign", thread: "thread", since: "2026-10-01", until: "2026-10-16", crmOnly: "false" });
  });
  it("lists every account plus Other in the rail with counts, and Other filters to mail with no identity", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("/api/mail/identities")
      ? { items: [{ identity_key: "alex", count: 3 }, { identity_key: null, count: 625 }] }
      : { items: [], nextCursor: null })));
    render(<InboxView />);
    const rail = await screen.findByRole("navigation", { name: "Mail accounts" });
    await waitFor(() => expect(within(rail).getByRole("button", { name: /^Other/ })).toHaveTextContent("625"));
    expect(within(rail).getByRole("button", { name: /^alex/ })).toHaveTextContent("3");
    expect(within(rail).getByRole("button", { name: /^All/ })).toHaveTextContent("628");
    expect(within(rail).getByRole("button", { name: /^supply/ })).toHaveTextContent("0");
    fireEvent.click(within(rail).getByRole("button", { name: /^Other/ }));
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/messages\?.*identity=none/), expect.anything()));
    expect(within(rail).getByRole("button", { name: /^Other/ })).toHaveAttribute("aria-current", "true");
  });
  it.each(["sent", "drafts"] as const)("renders %s as single Gmail-style lines with a hover copy-id button", async (view) => {
    vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("/api/mail/drafts")
      ? { items: [{ id: "d1", state: "draft", identity_key: "alex", from_email: "alex@rebattery.io", to_emails: ["buyer@example.test"], subject: "Draft subject", created_at: at, body_preview: "Draft body" }] }
      : { items: [message({ id: "s1", direction: "outbound", is_self: true, state: "accepted", subject: "Sent subject", body_preview: "Sent body", counterparty: { email: "buyer@example.test", name: "Synthetic Buyer" } })], nextCursor: null })));
    render(<InboxView initialView={view} />);
    const subject = await screen.findByText(view === "sent" ? "Sent subject" : "Draft subject");
    const row = subject.closest("[data-mail-row]")!;
    expect(row.querySelector('[data-mail-line="sender"]')).toBeTruthy();
    expect(within(row as HTMLElement).getByText(view === "sent" ? "— Sent body" : "— Draft body")).toBeInTheDocument();
    expect(within(row as HTMLElement).getByRole("button", { name: "Copy id" })).toBeInTheDocument();
  });
  it("opens a WhatsApp chat list from the upper tab", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => new Response(JSON.stringify(String(url).includes("/api/whatsapp/inbox")
      ? { threads: [{ id: "t1", kind: "direct", name: "Mathieu", last_captured_at: at, message_count: 4, last_body: "Collection is Thursday", last_direction: "inbound", last_at: at }] }
      : { items: [], nextCursor: null })));
    render(<InboxView />);
    fireEvent.click(screen.getByRole("tab", { name: "WhatsApp" }));
    expect(await screen.findByText("Collection is Thursday")).toBeInTheDocument();
    expect(screen.getByRole("tabpanel", { name: "WhatsApp" })).toBeInTheDocument();
    expect(screen.getByText("Mathieu").closest("a")).toHaveAttribute("href", "/whatsapp/threads/t1");
    expect(screen.getByText("1:1 · 4")).toBeInTheDocument();
  });
  it("flags sending and unknown outcomes without offering a send action", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [message({ id: "unknown", state: "unknown", direction: "outbound" }), message({ id: "sending", state: "sending", direction: "outbound" })], nextCursor: null })));
    render(<InboxView initialView="sent" />);
    expect(await screen.findByText("Reconcile before retrying: unknown")).toBeInTheDocument();
    expect(screen.getByText("Reconcile before retrying: sending")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^send$/i })).not.toBeInTheDocument();
  });
  it("shows due and paused follow-ups with the reason", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [{ id: "due", state: "pending", due_at: "2020-01-01T00:00:00Z", identity_key: "alex" }, { id: "paused", state: "paused", due_at: at, paused_reason: "reply_received" }] })));
    render(<InboxView initialView="followups" />);
    expect(await screen.findByText("Due")).toBeInTheDocument();
    expect(screen.getByText("Paused: reply_received")).toBeInTheDocument();
  });
  it("redirects legacy routes and preserves encoded campaign deep links", async () => {
    InboxPage(); CampaignsPage(); await CampaignPage({ params: Promise.resolve({ id: "campaign/one" }) });
    expect(navigation.redirect.mock.calls.map(([url]) => url)).toEqual(["/?crm=inbox&view=conversations", "/?crm=inbox&view=campaigns", "/?crm=inbox&view=campaigns&campaignDetail=campaign%2Fone"]);
  });
  it("copies a shell-quoted draft command without writing or sending", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    render(<QuickReply threadId="thread-synthetic" recipientName="Synthetic Buyer" recipientEmail="buyer@example.test" subject="Battery enquiry" />);
    fireEvent.click(screen.getByRole("button", { name: /Prepare reply to/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Draft reply" }), { target: { value: "Buyer's reply\n$(touch /tmp/not-run)" } });
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    expect(await screen.findByRole("status")).toHaveTextContent("No draft has been saved or sent");
    expect(writeText).toHaveBeenCalledWith(`rebattery-mail draft --thread 'thread-synthetic' --identity 'alex' --to 'buyer@example.test' --subject 'Battery enquiry' --body 'Buyer'\"'\"'s reply\n$(touch /tmp/not-run)'`);
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("Prepare this draft with rebattery-mail; approval and send happen in the CLI")).toBeInTheDocument();
  });
  it("quotes every shell argument and does not invent a missing reply address", () => {
    expect(draftCommand("thread'unsafe", "ari", "buyer@example.test", "Subject", "`id`")).toContain(`--thread 'thread'\"'\"'unsafe'`);
    render(<QuickReply threadId="thread" recipientEmail={null} subject={null} />);
    fireEvent.click(screen.getByRole("button", { name: "Prepare reply" }));
    expect(screen.getByRole("button", { name: "Copy" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent("No reply address");
    expect(fetch).not.toHaveBeenCalled();
  });
});
