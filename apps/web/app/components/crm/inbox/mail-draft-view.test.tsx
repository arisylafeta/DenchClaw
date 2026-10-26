// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailDraft } from "@/lib/mail-types";
import { MailDraftView, approvalLabel, draftSubtitle, sentWhen } from "./mail-draft-view";
import { MailDraftsView } from "./mail-drafts-view";

const draft: MailDraft = {
  id: "d1", state: "draft", identity_key: "ari", transport: "gmail", purpose: "personal", from_email: "ari@rebattery.io",
  to_emails: ["admin@example.test"], cc_emails: [], bcc_emails: [], subject: "Ioniq 5 battery enquiry",
  body_text: "Hi team,\n\nHow many packs?", body_html: null, thread_id: null, campaign_id: null, created_at: "2026-10-20T10:00:00Z", updated_at: "2026-10-20T10:00:00Z",
  editable: { main: "Hi team,\n\nHow many packs?", signature: null },
  attachments: [], links: [{ cta_key: "listing", destination_url: "https://example.test/l" }], warnings: [], approval: null,
};
const respond = (body: unknown, status = 200) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));
afterEach(() => vi.unstubAllGlobals());

describe("approvalLabel", () => {
  const approval = { id: "a", sha256: "x", scope: "full" as const, approved_by: "Ari", approved_at: "2026-10-20T10:00:00Z", expires_at: null, revoked_at: null, recipient_count: 1 };
  it("reports awaiting, approved, pilot, revoked and expired", () => {
    expect(approvalLabel({ state: "draft", approval: null }).text).toBe("Awaiting approval");
    expect(approvalLabel({ state: "draft", approval }).text).toBe("Approved by Ari");
    expect(approvalLabel({ state: "draft", approval: { ...approval, scope: "pilot" } }).text).toBe("Approved by Ari (pilot)");
    expect(approvalLabel({ state: "draft", approval: { ...approval, revoked_at: "2026-10-20T11:00:00Z" } }).tone).toBe("warn");
    expect(approvalLabel({ state: "draft", approval: { ...approval, expires_at: "2020-01-01T00:00:00Z" } }).text).toBe("Approval expired");
  });
});

describe("draftSubtitle", () => {
  it("says who a draft is from, then who sent it and when", () => {
    expect(draftSubtitle({ state: "draft", identity_key: "alex", sent_at: null, accepted_at: null })).toBe("Draft from Alex");
    const local = new Date(2026, 8, 23, 21, 0).toISOString();
    expect(sentWhen(local)).toBe("23rd Sept 2026 at 21:00");
    expect(draftSubtitle({ state: "accepted", identity_key: "alex", sent_at: local, accepted_at: null })).toBe("Sent by Alex on 23rd Sept 2026 at 21:00");
    expect(draftSubtitle({ state: "delivered", identity_key: "supply", sent_at: null, accepted_at: new Date(2026, 9, 2, 9, 5).toISOString() })).toBe("Sent by Supply on 2nd Oct 2026 at 09:05");
    expect(draftSubtitle({ state: "sent", identity_key: null, sent_at: null, accepted_at: null })).toBe("Sent");
    expect(draftSubtitle({ state: "sending", identity_key: "ari", sent_at: null, accepted_at: null })).toBe("Sending from Ari…");
    expect(sentWhen(new Date(2026, 9, 11, 8, 0).toISOString())).toContain("11th Oct");
    expect(sentWhen(new Date(2026, 9, 22, 8, 0).toISOString())).toContain("22nd Oct");
  });
});

describe("MailDraftView", () => {
  it("always shows Cc and Bcc, saying None when empty", async () => {
    respond(draft);
    render(<MailDraftView draftId="d1" />);
    await screen.findByRole("heading", { name: "Ioniq 5 battery enquiry" });
    expect(screen.getByText("Cc").nextSibling).toHaveTextContent("None");
    expect(screen.getByText("Bcc").nextSibling).toHaveTextContent("None");
    expect(screen.getByText("Draft from Ari")).toBeInTheDocument();
  });
  it("shows attachments with name, size, preview and a download link, and lists them in the send confirmation", async () => {
    const sha = "a".repeat(64); const sha2 = "b".repeat(64);
    respond({ ...draft, attachments: [{ filename: "01 - plate.jpg", sha256: sha, mediaType: "image/jpeg", sizeBytes: 201804 }, { filename: "list.csv", sha256: sha2, mediaType: "text/csv", sizeBytes: 900 }] });
    const { container } = render(<MailDraftView draftId="d1" />);
    const link = await screen.findByRole("link", { name: /01 - plate.jpg/ });
    expect(link).toHaveAttribute("href", `/api/mail/drafts/d1/attachments/${sha}`);
    expect(link).toHaveAttribute("download", "01 - plate.jpg");
    expect(link).toHaveTextContent("197 KB");
    expect(container.querySelector(`img[src="/api/mail/drafts/d1/attachments/${sha}?inline=1"]`)).not.toBeNull();
    expect(container.querySelectorAll("img")).toHaveLength(1);
    expect(screen.getByText(/2 attachments/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(screen.getByRole("alertdialog")).toHaveTextContent("With 2 attachments: 01 - plate.jpg, list.csv");
  });
  it("warns when the transport cannot carry the files", async () => {
    respond({ ...draft, transport: "postmark-transactional", attachments: [{ filename: "a.pdf", sha256: "c".repeat(64), mediaType: "application/pdf", sizeBytes: 10 }] });
    render(<MailDraftView draftId="d1" />);
    expect(await screen.findByText(/Postmark, which refuses attachments/)).toBeInTheDocument();
  });
  it("shows recipients, subject, body, frozen links and the approval note", async () => {
    respond(draft);
    render(<MailDraftView draftId="d1" />);
    expect(await screen.findByRole("heading", { name: "Ioniq 5 battery enquiry" })).toBeInTheDocument();
    expect(screen.getByText("admin@example.test")).toBeInTheDocument();
    expect(screen.getByText(/How many packs\?/)).toBeInTheDocument();
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getByText(/listing: https:\/\/example.test\/l/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^send$/i })).toBeEnabled();
  });
  it("offers no edit or send once the draft is sent", async () => {
    respond({ ...draft, state: "sent" });
    render(<MailDraftView draftId="d1" />);
    await screen.findByRole("heading", { name: "Ioniq 5 battery enquiry" });
    expect(screen.queryByRole("button", { name: /send|edit draft/i })).toBeNull();
  });
  it("edits the subject and message and saves them", async () => {
    const updated = { ...draft, subject: "New subject", body_text: "Changed", updated_at: "2026-10-20T10:05:00Z", editable: { main: "Changed", signature: null } };
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === "PATCH" ? updated : draft)));
    vi.stubGlobal("fetch", fetchMock);
    render(<MailDraftView draftId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit draft" }));
    expect(screen.getByRole("button", { name: /^send$/i })).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: "Subject" }), { target: { value: "New subject" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Message" }), { target: { value: "Changed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByRole("heading", { name: "New subject" })).toBeInTheDocument();
    const patch = fetchMock.mock.calls.find(([, init]) => init?.method === "PATCH")!;
    expect(patch[0]).toBe("/api/mail/drafts/d1");
    expect(JSON.parse(String(patch[1]!.body))).toEqual({ subject: "New subject", body: "Changed", updated_at: "2026-10-20T10:00:00Z" });
  });
  it("only sends after a confirmation, naming the version it showed", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(JSON.stringify(init?.method === "POST" ? { sent: true } : draft)));
    vi.stubGlobal("fetch", fetchMock);
    render(<MailDraftView draftId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^send$/i }));
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog).toHaveTextContent("admin@example.test");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, send" }));
    expect(await screen.findByText("Sent.")).toBeInTheDocument();
    expect(screen.getByText(/^Sent by Ari on /)).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(post[0]).toBe("/api/mail/drafts/d1/send");
    expect(JSON.parse(String(post[1]!.body))).toEqual({ confirm: true, updated_at: "2026-10-20T10:00:00Z" });
    expect(screen.queryByRole("button", { name: /^send$/i })).toBeNull();
  });
  it("shows why a send was refused", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST" ? new Response(JSON.stringify({ error: "recipient_suppressed" }), { status: 409 }) : new Response(JSON.stringify(draft))));
    render(<MailDraftView draftId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: /^send$/i }));
    fireEvent.click(screen.getByRole("button", { name: "Yes, send" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("recipient_suppressed");
  });
  it("copies the draft as plain text", async () => {
    respond(draft);
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MailDraftView draftId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy draft as text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("To: admin@example.test\nSubject: Ioniq 5 battery enquiry\n\nHi team,\n\nHow many packs?"));
  });
  it("shows Bcc recipients so reviewers see every address", async () => {
    respond({ ...draft, bcc_emails: ["hidden@example.test"] });
    render(<MailDraftView draftId="d1" />);
    expect(await screen.findByText("hidden@example.test")).toBeInTheDocument();
  });
  it("loads remote images in our own draft without a privacy prompt", async () => {
    respond({ ...draft, body_html: '<p>Hi</p><img src="https://www.rebattery.io/logo.png" alt="ReBattery">' });
    const { container } = render(<MailDraftView draftId="d1" />);
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toContain('src="https://www.rebattery.io/logo.png"');
    expect(container.querySelector("iframe")!.getAttribute("srcdoc")).toContain("img-src data: https:");
    expect(screen.queryByText(/Images are hidden/)).toBeNull();
  });
  it("reports a missing draft", async () => {
    respond({ error: "Not found" }, 404);
    render(<MailDraftView draftId="nope" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("not found");
  });
});

describe("MailDraftsView", () => {
  it("lists drafts and opens one", async () => {
    respond({ items: [{ id: "d1", state: "draft", identity_key: "ari", from_email: null, to_emails: ["a@example.test"], subject: "Hello", created_at: "2026-10-20T10:00:00Z", body_preview: "Hi" }] });
    const open = vi.fn();
    render(<MailDraftsView query="" onOpenDraft={open} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open draft: Hello" }));
    expect(open).toHaveBeenCalledWith("d1", "Hello");
  });
  it("shows an empty state", async () => {
    respond({ items: [] });
    render(<MailDraftsView query="" />);
    expect(await screen.findByText(/No drafts waiting/)).toBeInTheDocument();
  });
});
