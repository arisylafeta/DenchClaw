import { beforeEach, describe, expect, it, vi } from "vitest";

// Nothing here may run a real process: no mail CLI, no gog, no send runner.
vi.mock("node:child_process", () => ({
  execFile: vi.fn(() => { throw new Error("no processes in tests"); }),
  spawn: vi.fn(() => { throw new Error("no processes in tests"); }),
}));

const db = vi.hoisted(() => ({ fills: [] as unknown[], pinned: null as unknown[] | null, claimed: false }));
const mail = vi.hoisted(() => ({
  current: { id: "m1", state: "draft", identity_key: "alex", to_emails: ["ben@example.com"], body_text: "", updated_at: "2026-11-20T10:00:00.000Z" } as Record<string, unknown>,
  edits: [] as string[],
}));

vi.mock("./postgres", () => ({
  queryPg: vi.fn(async (sql: string, params: unknown[]) => {
    if (sql.includes("from relay_draft d join relay_item i")) return [{ id: "d1", item_id: "i1", mail_message_id: "m1", owner_ok: true }];
    if (sql.includes("to_jsonb(d)->'fills'")) return [{ fills: db.fills }];
    if (sql.startsWith("select id from mail_message") && sql.includes("claimed_at")) return db.claimed ? [{ id: "m1" }] : [];
    if (sql.startsWith("update mail_message set personalization = jsonb_set")) { db.pinned = params; return [{ at: (params[1] as string) }]; }
    throw new Error(`unexpected query: ${sql.slice(0, 80)}`);
  }),
  withPgTransaction: vi.fn(),
}));
vi.mock("./crm-postgres/mail", () => ({ readMailDraft: vi.fn(async () => ({ ...mail.current })), draftAttachments: vi.fn(() => []) }));
vi.mock("./mail-draft-actions", () => ({
  sameVersion: (a: string, b: string) => new Date(a).getTime() === new Date(b).getTime(),
  editableCopy: async (m: { body_text: string }) => ({ main: m.body_text, signature: null }),
  editDraft: vi.fn(async (_m: unknown, changes: { body: string }) => {
    mail.edits.push(changes.body);
    mail.current = { ...mail.current, body_text: changes.body, updated_at: "2026-11-20T10:05:00.000Z" };
  }),
  DraftActionError: class extends Error {},
  changeDraftIdentity: vi.fn(), identitySignatures: vi.fn(), textToHtml: (t: string) => t, splitCopy: vi.fn(),
}));

const { scheduleSend, saveToGmailDrafts, readSeenFills } = await import("./relay");

const MARKER = "[BLANK: price for Volkswagen ID.3 62 kWh, 2020 (ref stock:sto_1)]";
const BODY = `Hi Ben,\n\nThe ID.3 pack is ${MARKER}, collected.\n\nAlex`;
const fill = (value: number | null) => ({ key: "stock:sto_1", label: "Volkswagen ID.3 62 kWh, 2020", value, basis: "collected", working: [], warnings: [], needsDeliveryQuote: false, by: "relay" });
const owner = { id: "u1", email: "alex@rebattery.io" };
const later = () => new Date(Date.now() + 60 * 60_000);

describe("sending fills the prices in before the pin", () => {
  beforeEach(() => {
    mail.current = { ...mail.current, body_text: BODY, updated_at: "2026-11-20T10:00:00.000Z" };
    mail.edits = [];
    db.fills = [fill(5040)];
    db.pinned = null;
    db.claimed = false;
  });

  it("checks Alex's version, writes the price, then pins the version with the price in it", async () => {
    const held = await scheduleSend("d1", owner, "2026-11-20T10:00:00.000Z", later());
    expect(mail.edits).toEqual([BODY.replace(MARKER, "£5,040")]);
    expect(held.updated_at).toBe("2026-11-20T10:05:00.000Z");
    // The pin's version is the filled one, so relay_send.py's same-version check passes for it and only it.
    expect(db.pinned?.[3]).toBe("2026-11-20T10:05:00.000Z");
  });

  it("refuses a version Alex did not see, before writing anything", async () => {
    await expect(scheduleSend("d1", owner, "2026-11-20T09:00:00.000Z", later())).rejects.toThrow(/changed since you opened it/);
    expect(mail.edits).toEqual([]);
    expect(db.pinned).toBeNull();
  });

  it("refuses an open price gap, before writing anything", async () => {
    db.fills = [fill(null)];
    await expect(scheduleSend("d1", owner, "2026-11-20T10:00:00.000Z", later())).rejects.toThrow(/gap to fill in/);
    expect(mail.edits).toEqual([]);
    expect(db.pinned).toBeNull();
  });

  it("refuses when the page showed other prices", async () => {
    await expect(scheduleSend("d1", owner, "2026-11-20T10:00:00.000Z", later(), [{ key: "stock:sto_1", value: 4900 }])).rejects.toThrow(/prices changed/);
    expect(mail.edits).toEqual([]);
  });

  it("leaves a draft with no price gap as it is", async () => {
    mail.current = { ...mail.current, body_text: "Hi Ben, £4,500 collected." };
    const held = await scheduleSend("d1", owner, "2026-11-20T10:00:00.000Z", later());
    expect(mail.edits).toEqual([]);
    expect(held.updated_at).toBe("2026-11-20T10:00:00.000Z");
  });

  it("never edits a draft the runner is sending", async () => {
    db.claimed = true;
    await expect(scheduleSend("d1", owner, "2026-11-20T10:00:00.000Z", later())).rejects.toThrow(/sending now/);
    expect(mail.edits).toEqual([]);
  });

  it("keeps a draft with an open gap out of Gmail", async () => {
    db.fills = [];
    await expect(saveToGmailDrafts("d1", "u1")).rejects.toThrow(/gap to fill in before this can go to Gmail drafts/);
    expect(mail.edits).toEqual([]);
  });

  it("reads the fills a page sends back", () => {
    expect(readSeenFills(undefined)).toEqual({});
    expect(readSeenFills([{ key: "stock:sto_1", value: 5040 }, { key: "market:a", value: null }])).toEqual({ seen: [{ key: "stock:sto_1", value: 5040 }, { key: "market:a", value: null }] });
    expect(readSeenFills([{ key: 1, value: 2 }])).toHaveProperty("error");
    expect(readSeenFills("x")).toHaveProperty("error");
  });
});
