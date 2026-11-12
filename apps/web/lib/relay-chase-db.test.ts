import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { CHASE_LINES } from "./relay-chase-core";

// No send runner: relay.ts's queueSend would start relay_send.py after the undo window. Here it can start nothing.
const spawned = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async (actual) => ({
  ...(await actual<typeof import("node:child_process")>()),
  spawn: (cmd: string, args: string[]) => { spawned.push([cmd, ...args]); return { unref: () => undefined }; },
  execFile: () => { throw new Error("no external commands in tests"); },
}));

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL. The mail draft is a
// stand-in that writes a local draft row, so no mail tool runs and nothing can be sent.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("chase drafts (relay-chase.ts, migration 115)", () => {
  let pg: typeof import("./postgres");
  let chase: typeof import("./relay-chase");
  let relay: typeof import("./relay");
  let owner: { id: string; email: string };
  const run = `${Date.now()}`;
  const made: { to: string[]; subject: string; body: string; identity: string; thread: string | null }[] = [];
  /** The stand-in for createMailDraft: a local draft row, never sent. */
  const draft = async (d: { identity: string; to: string[]; ccThread: boolean; thread: string | null; subject: string; body: string }) => {
    made.push(d);
    const id = `chase-draft-${made.length}-${run}`;
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, purpose, identity_key, from_email, to_emails, subject, body_text)
      values ($1, $2, 'outbound', 'gmail', 'draft', 'personal', $3, 'alex@rebattery.io', $4, $5, $6)`, [id, d.thread, d.identity, d.to, d.subject, d.body]);
    return id;
  };
  const now = new Date("2026-11-04T10:00:00Z"); // Wednesday: day 2 after Monday 2 Nov

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("./postgres");
    chase = await import("./relay-chase");
    relay = await import("./relay");
    const [user] = await pg.queryPg<{ id: string; email: string }>(
      "insert into crm_users (email, display_name, password_hash) values ($1, 'Chase Test', 'x') returning id, email", [`relay-chase-${run}@example.test`]);
    owner = user;
  });
  afterAll(async () => { await pg.pgPool.end(); });

  /** Dana asked about packs, Alex answered with a question on Monday 2 Nov, and `chases` chases followed. */
  async function waiting(name: string, opts: { chases?: number; state?: "due" | "waiting" | "park"; listing?: string | null } = {}) {
    const thread = `chase-${name}-${run}`;
    const email = `dana.field@${name}-${run}.example`;
    await pg.queryPg("insert into mail_thread (id, subject, gmail_thread_id, mailbox_owner_id) values ($1, 'Leaf packs', $2, $3::uuid)", [thread, `g-${thread}`, owner.id]);
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, from_email, to_emails, subject, body_text, sent_at)
      values ($1, $2, 'inbound', 'gmail', 'received', $3, '{alex@rebattery.io}', 'Leaf packs', E'Hi Alex, we have Leaf packs in Leeds.\\nDana', '2026-10-30T09:00:00Z')`,
      [`in-${thread}`, thread, email]);
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, purpose, identity_key, from_email, to_emails, subject, body_text, accepted_at, sent_at)
      values ($1, $2, 'outbound', 'gmail', 'accepted', 'personal', 'alex', 'alex@rebattery.io', array[$3], 'Re: Leaf packs', 'Hi Dana, how many packs?', '2026-11-02T09:00:00Z', '2026-11-02T09:00:00Z')`,
      [`out-${thread}`, thread, email]);
    const stored = { state: opts.state ?? "due", chases: opts.chases ?? 0, waited: 2, next: (opts.chases ?? 0) + 1, due_on: "2026-11-03", since: "2026-11-02T09:00:00+00:00" };
    const [item] = await pg.queryPg<{ id: string }>(`insert into relay_item (owner_id, gmail_thread_id, mail_thread_id, tab, status, counterpart_email, counterpart_name, contact_type, headline, chase, bulk_listing_id, waiting_since)
      values ($1::uuid, $2, $3, 'follow', 'open', $4, 'Dana Field', 'supplier', 'Leaf packs', $5::jsonb, $6, '2026-11-02T09:00:00Z') returning id`,
      [owner.id, `g-${thread}`, thread, email, JSON.stringify(stored), opts.listing ?? null]);
    return { item: item.id, thread, email };
  }
  const draftsOf = (item: string) => pg.queryPg<{ id: string; state: string; origin: string; title: string; source_note: string; mail_message_id: string | null }>(
    "select id, state, origin, title, source_note, mail_message_id from relay_draft where item_id = $1 order by created_at", [item]);
  const itemStatus = async (item: string) => (await pg.queryPg<{ status: string }>("select status from relay_item where id = $1", [item]))[0].status;

  it("prepares a due chase as a draft in Review, from fixed parts, and sends nothing", async () => {
    const t = await waiting("due");
    const result = await chase.prepareChases(owner.id, { draft, now });
    expect(result.prepared).toContain(t.item);
    const [row] = await draftsOf(t.item);
    expect(row).toMatchObject({ state: "draft", origin: "predraft", title: "Chase 1 of 3", source_note: "[chase:1 since 2026-11-02T09:00:00+00:00]" });
    expect(await itemStatus(t.item)).toBe("review");
    const sent = made.at(-1)!;
    expect(sent).toMatchObject({ to: [t.email], subject: "Re: Leaf packs", identity: "alex", thread: t.thread });
    expect(sent.body).toBe(`Hi Dana,\n\n${CHASE_LINES[1]}\n\nBest,\nAlex`);
    // Nothing went out and nothing is waiting to go: the mail row is a plain draft with no send-later.
    const [mail] = await pg.queryPg<{ state: string; scheduled: boolean }>("select state, personalization ? 'scheduled_send' as scheduled from mail_message where id = $1", [row.mail_message_id]);
    expect(mail).toEqual({ state: "draft", scheduled: false });
  });

  it("keeps one open chase draft per thread, and never prepares the same chase twice", async () => {
    const t = await waiting("once");
    await chase.prepareChases(owner.id, { draft, now });
    await pg.queryPg("update relay_item set status = 'open' where id = $1", [t.item]); // as if it were back in Follow up
    await chase.prepareChases(owner.id, { draft, now });
    expect(await draftsOf(t.item)).toHaveLength(1);
    // The database refuses a second open one however it is written.
    await expect(pg.queryPg("insert into relay_draft (item_id, role, position, title, origin) values ($1, 'primary', 0, 'Chase', 'predraft')", [t.item])).rejects.toThrow(/relay_draft_one_open_chase/);
    // A person dropped it: the same chase does not come back.
    await pg.queryPg("update relay_draft set state = 'skipped' where item_id = $1", [t.item]);
    await chase.prepareChases(owner.id, { draft, now });
    expect((await draftsOf(t.item)).map((d) => d.state)).toEqual(["skipped"]);
  });

  it("does nothing for a chase that is not due, or a thread they answered since the scan", async () => {
    const early = await waiting("early", { state: "waiting" });
    const answered = await waiting("answered");
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, from_email, to_emails, subject, body_text, sent_at)
      values ($1, $2, 'inbound', 'gmail', 'received', $3, '{alex@rebattery.io}', 'Re: Leaf packs', '20 packs.', '2026-11-04T08:00:00Z')`, [`late-${answered.thread}`, answered.thread, answered.email]);
    const result = await chase.prepareChases(owner.id, { draft, now });
    expect(await draftsOf(early.item)).toEqual([]);
    expect(await draftsOf(answered.item)).toEqual([]);
    expect(result.refused).toContainEqual({ item_id: answered.item, reason: "they replied" });
  });

  it("a reply cancels the open chase draft and any send-later on it", async () => {
    const t = await waiting("reply");
    await chase.prepareChases(owner.id, { draft, now });
    const [row] = await draftsOf(t.item);
    await pg.queryPg(`update mail_message set personalization = jsonb_build_object('scheduled_send', jsonb_build_object('at', now() + interval '1 day')) where id = $1`, [row.mail_message_id]);
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, from_email, to_emails, subject, body_text, sent_at)
      values ($1, $2, 'inbound', 'gmail', 'received', $3, '{alex@rebattery.io}', 'Re: Leaf packs', 'Sorry, 20 packs.', now() + interval '1 minute')`, [`reply-${t.thread}`, t.thread, t.email]);
    expect(await chase.cancelAnsweredChases(owner.id)).toBeGreaterThanOrEqual(1);
    expect((await draftsOf(t.item))[0].state).toBe("skipped");
    const [mail] = await pg.queryPg<{ scheduled: boolean }>("select personalization ? 'scheduled_send' as scheduled from mail_message where id = $1", [row.mail_message_id]);
    expect(mail.scheduled).toBe(false);
  });

  it("counts a sent chase on a stored match's ask thread as one of that match's chases, once", async () => {
    const t = await waiting("match");
    const deal = `chase-req-${run}`;
    await pg.queryPg(`insert into crm_bulk_listings (id, kind, party, summary, status, spec) values ($1, 'demand', 'Buyer', 'Leaf packs', 'open', '{"intent": "request"}')`, [deal]);
    await pg.queryPg(`insert into crm_bulk_matches (id, deal_id, candidate_kind, candidate_id, candidate_key, name, stock_kind, stock_id, state, asked_at, data)
      values ($1, $2, 'stock', 'st1', 'stock:st1', 'Supplier', 'stock', 'st1', 'asked', '2026-11-02T09:00:00Z', $3::jsonb)`, [`${deal}-m`, deal, JSON.stringify({ open_draft_id: `out-${t.thread}` })]);
    await chase.prepareChases(owner.id, { draft, now });
    const [row] = await draftsOf(t.item);
    await pg.queryPg("update mail_message set state = 'accepted', accepted_at = now() where id = $1", [row.mail_message_id]);
    expect(await chase.recordSentChases([row.id])).toBe(1);
    expect(await chase.recordSentChases([row.id])).toBe(0);
    const [m] = await pg.queryPg<{ chases: number }>("select chases from crm_bulk_matches where id = $1", [`${deal}-m`]);
    expect(m.chases).toBe(1);
  });

  /** Their reply on the thread, sent at `at`. */
  const reply = (t: { thread: string; email: string }, key: string, at: string) => pg.queryPg(
    `insert into mail_message (id, thread_id, direction, transport, state, from_email, to_emails, subject, body_text, sent_at)
     values ($1, $2, 'inbound', 'gmail', 'received', $3, '{alex@rebattery.io}', 'Re: Leaf packs', 'Here are the numbers.', $4::timestamptz)`,
    [`${key}-${t.thread}`, t.thread, t.email, at]);

  it("skips a chase when their reply came after our message, even if it was sent before the chase was drafted and synced later", async () => {
    const t = await waiting("late-sync");
    await chase.prepareChases(owner.id, { draft, now });
    const [row] = await draftsOf(t.item);
    expect(row.state).toBe("draft");
    // Sent Tuesday 3 Nov, a day after our Monday message and before the chase draft existed; it reached the CRM only now.
    await reply(t, "late", "2026-11-03T08:00:00Z");
    expect(await chase.cancelAnsweredChases(owner.id)).toBeGreaterThanOrEqual(1);
    expect((await draftsOf(t.item))[0].state).toBe("skipped");
  });

  it("leaves a chase alone while the send runner has claimed it, as the unschedule path does", async () => {
    const t = await waiting("claimed");
    await chase.prepareChases(owner.id, { draft, now });
    const [row] = await draftsOf(t.item);
    await pg.queryPg(`update mail_message set personalization = jsonb_build_object('scheduled_send', jsonb_build_object('at', now(), 'claimed_at', now())) where id = $1`, [row.mail_message_id]);
    await reply(t, "claimed", new Date(Date.now() + 60_000).toISOString()); // after the draft too: only the claim keeps it
    await chase.cancelAnsweredChases(owner.id);
    expect((await draftsOf(t.item))[0].state).toBe("draft");
    const [mail] = await pg.queryPg<{ scheduled: boolean }>("select personalization ? 'scheduled_send' as scheduled from mail_message where id = $1", [row.mail_message_id]);
    expect(mail.scheduled).toBe(true);
  });

  it("marks a skipped chase that was in Gmail drafts, so the email's card says the copy is still there", async () => {
    const t = await waiting("gmail");
    await chase.prepareChases(owner.id, { draft, now });
    await pg.queryPg("update relay_draft set state = 'gmail', gmail_draft_id = 'r-gmail-1' where item_id = $1", [t.item]);
    await reply(t, "gmail", "2026-11-03T08:00:00Z");
    await chase.cancelAnsweredChases(owner.id);
    const [row] = await pg.queryPg<{ state: string; left: boolean }>("select state, gmail_copy_left as left from relay_draft where item_id = $1", [t.item]);
    expect(row).toEqual({ state: "skipped", left: true });
    expect((await relay.readRelayItem(t.item, owner.id))?.gmail_chase_copy).toBe(true);
  });

  it("checks for a reply again at the Send click, and sends nothing when they answered", async () => {
    const t = await waiting("click");
    await chase.prepareChases(owner.id, { draft, now });
    const [row] = await draftsOf(t.item);
    await pg.queryPg("update mail_message set identity_key = 'supply' where id = $1", [row.mail_message_id]); // a shared inbox the test owner may read
    await reply(t, "click", "2026-11-03T08:00:00Z");
    const [mail] = await pg.queryPg<{ updated_at: string }>("select updated_at::text from mail_message where id = $1", [row.mail_message_id]);
    spawned.length = 0;
    await expect(relay.queueSend(row.id, owner, new Date(mail.updated_at).toISOString())).rejects.toThrow(/They replied after this chase was drafted/);
    const [after] = await pg.queryPg<{ scheduled: boolean }>("select personalization ? 'scheduled_send' as scheduled from mail_message where id = $1", [row.mail_message_id]);
    expect(after.scheduled).toBe(false);
    expect((await draftsOf(t.item))[0].state).toBe("skipped");
    expect(spawned).toEqual([]);
  });
});
