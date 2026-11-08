import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  currentUser: vi.fn(), getListing: vi.fn(), offerOutreach: vi.fn(), readMailDraft: vi.fn(),
  sendDraft: vi.fn(), linkOfferThread: vi.fn(), markOfferSent: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ currentUser: m.currentUser, ALLOWED_EMAILS: new Set(["alex@rebattery.io"]) }));
vi.mock("@/lib/crm-postgres/bulk-listings", () => ({ getListing: m.getListing }));
vi.mock("@/lib/crm-postgres/bulk-offer-mail", () => ({
  offerOutreach: m.offerOutreach, linkOfferThread: m.linkOfferThread, markOfferSent: m.markOfferSent,
}));
vi.mock("@/lib/crm-postgres/mail", () => ({ readMailDraft: m.readMailDraft }));
vi.mock("@/lib/mail-draft-actions", () => ({
  sameVersion: (a: string | Date, b: string | Date) => new Date(a).getTime() === new Date(b).getTime(),
  sendDraft: m.sendDraft,
  DraftActionError: class extends Error { constructor(readonly status: number, message: string) { super(message); } },
}));

import { POST } from "./route";
import { DraftActionError } from "@/lib/mail-draft-actions";

process.env.CRM_DB_BACKEND = "postgres";

const draft = {
  id: "draft_1", state: "draft", updated_at: "2026-11-08T10:00:00.000Z", thread_id: null as string | null,
  to_emails: ["sam@buyer.test"], cc_emails: [], bcc_emails: [],
};
const call = (body: unknown) => POST(
  new Request("http://x", { method: "POST", body: JSON.stringify(body) }),
  { params: Promise.resolve({ id: "sup_1", offerId: "bof_1" }) });

const sent = { confirm: true, updated_at: "2026-11-08T10:00:00.000Z", draft_id: "draft_1" };

beforeEach(() => {
  vi.clearAllMocks();
  m.currentUser.mockResolvedValue({ id: "u1", email: "alex@rebattery.io", displayName: "Alex Polglase" });
  m.getListing.mockResolvedValue({ id: "sup_1", kind: "supply" });
  m.offerOutreach.mockResolvedValue({ offerId: "bof_1", listingId: "sup_1", kind: "supply", stage: "candidate", email: "sam@buyer.test", openDraftId: "draft_1", data: {} });
  m.readMailDraft.mockResolvedValue(draft);
  m.sendDraft.mockResolvedValue({ sent: true });
  m.linkOfferThread.mockResolvedValue(undefined);
  m.markOfferSent.mockResolvedValue({ moved: true, stage: "offered" });
});

describe("POST offer send", () => {
  it("needs an explicit confirmation and the version that was looked at", async () => {
    expect((await call({ updated_at: draft.updated_at })).status).toBe(400);
    expect((await call({ confirm: "yes", updated_at: draft.updated_at })).status).toBe(400);
    expect((await call({ confirm: true })).status).toBe(400);
    expect(m.sendDraft).not.toHaveBeenCalled();
  });

  it("refuses a draft that changed after the person looked", async () => {
    const res = await call({ ...sent, updated_at: "2026-11-08T09:00:00.000Z" });
    expect(res.status).toBe(409);
    expect(m.sendDraft).not.toHaveBeenCalled();
    expect(m.markOfferSent).not.toHaveBeenCalled();
  });

  it("refuses a draft addressed to someone other than the offer's contact", async () => {
    m.readMailDraft.mockResolvedValue({ ...draft, to_emails: ["someone@else.test"] });
    expect((await call(sent)).status).toBe(409);
    expect(m.sendDraft).not.toHaveBeenCalled();
  });

  it("sends, links the thread as confirmed and moves the offer to offered", async () => {
    m.readMailDraft.mockResolvedValueOnce(draft).mockResolvedValueOnce({ ...draft, state: "accepted", thread_id: "thread_1" });
    const res = await call(sent);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: true, threadLinked: true, moved: true, stage: "offered" });
    expect(m.sendDraft).toHaveBeenCalledWith(expect.objectContaining({ id: "draft_1" }), "Alex Polglase");
    expect(m.linkOfferThread).toHaveBeenCalledWith("sup_1", "bof_1", "thread_1", "alex@rebattery.io");
    expect(m.markOfferSent).toHaveBeenCalledWith("bof_1", "u1");
  });

  it("changes nothing and warns when the send fails", async () => {
    m.sendDraft.mockRejectedValue(new DraftActionError(409, "This draft was already sent or is being sent."));
    const res = await call(sent);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ sent: false });
    expect(m.linkOfferThread).not.toHaveBeenCalled();
    expect(m.markOfferSent).not.toHaveBeenCalled();
  });

  it("changes nothing and says the outcome is unknown on a 502", async () => {
    m.sendDraft.mockRejectedValue(new DraftActionError(502, "The mail command failed."));
    const res = await call(sent);
    expect(res.status).toBe(502);
    const body = await res.json() as { sent: boolean; warning: string };
    expect(body.sent).toBe(false);
    expect(body.warning).toMatch(/outcome is unknown/);
    expect(m.linkOfferThread).not.toHaveBeenCalled();
    expect(m.markOfferSent).not.toHaveBeenCalled();
  });

  it("never moves a stage backwards: an offer already negotiating keeps its stage", async () => {
    m.markOfferSent.mockResolvedValue({ moved: false, stage: "negotiating" });
    const res = await call(sent);
    expect(await res.json()).toMatchObject({ sent: true, moved: false, stage: "negotiating" });
  });

  it("still marks the send when the thread id is not known yet", async () => {
    m.readMailDraft.mockResolvedValue({ ...draft, state: "accepted", thread_id: null });
    const res = await call(sent);
    expect(await res.json()).toMatchObject({ sent: true, threadLinked: false });
    expect(m.linkOfferThread).not.toHaveBeenCalled();
    expect(m.markOfferSent).toHaveBeenCalled();
  });

  it("only lets Ari or Alex send from here", async () => {
    m.currentUser.mockResolvedValue({ id: "u2", email: "other@rebattery.io", displayName: "Other" });
    expect((await call(sent)).status).toBe(403);
    expect(m.sendDraft).not.toHaveBeenCalled();
  });
});
