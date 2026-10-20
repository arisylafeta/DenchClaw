// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { MailDraft } from "@/lib/mail-types";
import { MailDraftView, approvalLabel } from "./mail-draft-view";
import { MailDraftsView } from "./mail-drafts-view";

const draft: MailDraft = {
  id: "d1", state: "draft", identity_key: "ari", transport: "gmail", purpose: "personal", from_email: "ari@rebattery.io",
  to_emails: ["admin@example.test"], cc_emails: [], bcc_emails: [], subject: "Ioniq 5 battery enquiry",
  body_text: "Hi team,\n\nHow many packs?", body_html: null, thread_id: null, campaign_id: null, created_at: "2026-10-20T10:00:00Z",
  links: [{ cta_key: "listing", destination_url: "https://example.test/l" }], warnings: [], approval: null,
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

describe("MailDraftView", () => {
  it("shows recipients, subject, body, frozen links and the read-only approval note", async () => {
    respond(draft);
    render(<MailDraftView draftId="d1" />);
    expect(await screen.findByRole("heading", { name: "Ioniq 5 battery enquiry" })).toBeInTheDocument();
    expect(screen.getByText("admin@example.test")).toBeInTheDocument();
    expect(screen.getByText(/How many packs\?/)).toBeInTheDocument();
    expect(screen.getByText("Awaiting approval")).toBeInTheDocument();
    expect(screen.getByText(/listing: https:\/\/example.test\/l/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /send/i })).toBeNull();
  });
  it("copies the draft as plain text", async () => {
    respond(draft);
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<MailDraftView draftId="d1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Copy draft as text" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("To: admin@example.test\nSubject: Ioniq 5 battery enquiry\n\nHi team,\n\nHow many packs?"));
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
