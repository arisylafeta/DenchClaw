// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { MailMessageRow } from "@/lib/mail-types";
import { InboxView, mailQuery } from "./inbox-view";
import { QuickReply } from "./quick-reply";
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
  body_text: "Hello", body_html: null, body_preview: "Hello", sent_at: at, created_at: at, accepted_at: null, delivered_at: null, bounced_at: null, opened_at: null, clicked_at: null, replied_at: null, crm_visible: true, has_attachments: false, gmail_message_id: null, ...overrides,
});
beforeEach(() => {
  navigation.params = new URLSearchParams(); navigation.replace.mockClear(); navigation.redirect.mockClear(); localStorage.clear();
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ items: [], nextCursor: null }))));
});
afterEach(() => vi.unstubAllGlobals());

describe("merged mail", () => {
  it("switches all four views and loads the matching shared-store APIs", async () => {
    render(<InboxView />);
    expect(screen.getByRole("tab", { name: "Conversations" })).toHaveAttribute("aria-selected", "true");
    for (const label of ["Campaigns", "Sent", "Follow-ups", "Conversations"]) {
      fireEvent.click(screen.getByRole("tab", { name: label }));
      expect(screen.getByRole("tabpanel", { name: label })).toBeInTheDocument();
    }
    await waitFor(() => expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/mail/messages?"), expect.anything()));
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/mail/campaigns?"), expect.anything());
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("/api/mail/followups?"), expect.anything());
  });
  it("excludes bulk campaigns from the conversation rows and unread badge", async () => {
    vi.mocked(fetch).mockImplementation(async () => new Response(JSON.stringify({ items: [message({}), message({ id: "bulk", thread_id: "bulk-thread", campaign_id: "campaign", subject: "Bulk campaign" })], nextCursor: null })));
    render(<InboxView />);
    expect(await screen.findByLabelText("Unread conversations")).toHaveTextContent("0 unread conversations");
    await screen.findByText("Synthetic conversation");
    expect(screen.getByLabelText("Unread conversations")).toHaveTextContent("1 unread conversations");
    expect(screen.queryByText("Bulk campaign")).not.toBeInTheDocument();
  });
  it("maps all filters to API query parameters including whole-log scope", async () => {
    render(<InboxView initialView="sent" />);
    fireEvent.change(screen.getByRole("searchbox", { name: "Search" }), { target: { value: "battery" } });
    fireEvent.change(screen.getByRole("combobox", { name: "identity" }), { target: { value: "ari" } });
    fireEvent.change(screen.getByRole("combobox", { name: "event" }), { target: { value: "clicked" } });
    fireEvent.click(screen.getByRole("checkbox", { name: "CRM-only" }));
    await waitFor(() => expect(fetch).toHaveBeenLastCalledWith(expect.stringMatching(/q=battery.*identity=ari.*event=clicked.*crmOnly=false/), expect.anything()));
    const query = new URLSearchParams(mailQuery({ q: "battery & pack", from: "a@example.test", to: "b@example.test", identity: "supply", direction: "outbound", transport: "postmark-broadcast", purpose: "marketing", state: "accepted", event: "opened", campaign: "campaign", thread: "thread", since: "2026-10-01", until: "2026-10-16", crmOnly: false }));
    expect(Object.fromEntries(query)).toEqual({ q: "battery & pack", from: "a@example.test", to: "b@example.test", identity: "supply", direction: "outbound", transport: "postmark-broadcast", purpose: "marketing", state: "accepted", event: "opened", campaign: "campaign", thread: "thread", since: "2026-10-01", until: "2026-10-16", crmOnly: "false" });
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
  it("creates a draft and never invokes a send endpoint", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ id: "draft-synthetic", state: "draft" })));
    render(<QuickReply threadId="thread-synthetic" recipientName="Synthetic Buyer" />);
    fireEvent.click(screen.getByRole("button", { name: /Create draft to/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Draft reply" }), { target: { value: "Thanks for your reply." } });
    fireEvent.click(screen.getByRole("button", { name: "Create draft" }));
    expect(await screen.findByRole("status")).toHaveTextContent("Not sent");
    expect(fetch).toHaveBeenCalledExactlyOnceWith("/api/mail/threads/thread-synthetic/draft", expect.objectContaining({ method: "POST", body: JSON.stringify({ body_text: "Thanks for your reply.", identity: "alex" }) }));
  });
});
