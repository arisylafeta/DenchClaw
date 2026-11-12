import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dealWaiting, stuckInNew } from "../bulk-today";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL. Synthetic rows only.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("Today, team notes, one history, WhatsApp updates (slice 3)", () => {
  let pg: typeof import("../postgres");
  let sheet: typeof import("./bulk-sheet");
  let notes: typeof import("./bulk-notes");
  let history: typeof import("./bulk-history");
  let wa: typeof import("../relay-whatsapp-update");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `t3_${s}_${run}`;
  let alex: string;
  let sean: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    sheet = await import("./bulk-sheet");
    notes = await import("./bulk-notes");
    history = await import("./bulk-history");
    wa = await import("../relay-whatsapp-update");
    [{ id: alex }] = await pg.queryPg<{ id: string }>("insert into crm_users (email, display_name, password_hash) values ($1, 'Alex Polglase', 'x') returning id", [`alex.${run}@example.test`]);
    [{ id: sean }] = await pg.queryPg<{ id: string }>("insert into crm_users (email, display_name, password_hash) values ($1, 'Sean', 'x') returning id", [`sean.${run}@example.test`]);
    await pg.queryPg(`insert into crm_bulk_listings (id, kind, party, summary, status, spec, created_at) values
      ($1, 'supply', 'Old seller', 'Leaf packs', 'open', '{}', now() - interval '12 days'),
      ($2, 'supply', 'New seller', 'Kona packs', 'open', '{}', now() - interval '2 days'),
      ($3, 'demand', 'Buyer', 'Ioniq packs', 'open', '{"intent": "request"}', now())`, [id("old"), id("fresh"), id("talk")]);
    // The stage history began after the old listing was made: its time in New counts from when it was made.
    await pg.queryPg("update crm_bulk_stage_events set note = 'As of migration 111', occurred_at = now() - interval '1 day' where subject_id = $1", [id("old")]);
  });
  afterAll(async () => {
    await pg.queryPg("delete from relay_item where bulk_listing_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_listings where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from mail_message where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from mail_thread where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_users where id in ($1, $2)", [alex, sean]);
    await pg.pgPool.end();
  });

  const row = async (listing: string) => (await sheet.listSheet()).find((r) => r.id === listing)!;

  it("finds a deal in New for more than 7 days, counted from when it was made, and not a newer one", async () => {
    const [old, fresh] = [await row(id("old")), await row(id("fresh"))];
    expect(old.progress).toBe("New");
    const stuck = stuckInNew([old, fresh]);
    expect(stuck.map((s) => s.row.id)).toEqual([id("old")]);
    expect(stuck[0].days).toBe(12);
  });

  it("says whose move it is from the real messages on linked email threads and chats, not from updated_at", async () => {
    const thread = id("thread");
    await pg.queryPg("insert into mail_thread (id, subject) values ($1, 'Ioniq packs')", [thread]);
    await pg.queryPg(`insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, confidence, state, labelled_by, confirmed_by) values ('mail', $1, $2, 'high', 'confirmed', 'test', 'test')`, [thread, id("talk")]);
    // In the test user's own mailbox, so they may read it (the inbox's mailbox rule).
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, purpose, mailbox_owner_id, from_email, to_emails, subject, body_text, sent_at, accepted_at) values
      ($1, $3, 'inbound', 'gmail', 'received', null, $4::uuid, 'buyer@talk.example', '{alex@rebattery.io}', 'Ioniq packs', 'We need 20.', '2026-11-02T09:00:00Z', null),
      ($2, $3, 'outbound', 'gmail', 'accepted', 'personal', $4::uuid, 'alex@rebattery.io', '{buyer@talk.example}', 'Re: Ioniq packs', 'Which state of health?', '2026-11-03T09:00:00Z', '2026-11-03T09:00:00Z')`,
      [id("in1"), id("out1"), thread, alex]);
    await pg.queryPg("update crm_bulk_listings set updated_at = now() where id = $1", [id("talk")]);
    const talk = await row(id("talk"));
    expect(talk).toMatchObject({ last_in_at: expect.stringContaining("2026-11-02"), last_out_at: expect.stringContaining("2026-11-03"), waiting_from: expect.stringContaining("2026-11-03") });
    expect(dealWaiting(talk, new Date("2026-11-06T12:00:00Z"))).toMatchObject({ on: "them", days: 3 });
    // A WhatsApp message from them, linked to the deal, after our email: now it is on us.
    await pg.queryPg("insert into whatsapp_account (id, account_jid) values ($1, $2)", [id("acc"), `${id("acc")}@synthetic.test`]);
    await pg.queryPg(`insert into whatsapp_thread (id, account_id, canonical_chat_id, kind, first_captured_at, last_captured_at) values ($1, $2, $1, 'direct', now(), now())`, [id("chat"), id("acc")]);
    await pg.queryPg(`insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, confidence, state, labelled_by, confirmed_by) values ('whatsapp', $1, $2, 'high', 'confirmed', 'test', 'test')`, [id("chat"), id("talk")]);
    await pg.queryPg(`insert into whatsapp_message (id, account_id, thread_id, provider_message_id, direction, occurred_at, captured_at, body) values ($1, $2, $3, 'p1', 'inbound', '2026-11-04T10:00:00Z', now(), 'SoH 90% on all of them')`,
      [id("wa1"), id("acc"), id("chat")]);
    expect(dealWaiting(await row(id("talk")), new Date("2026-11-06T12:00:00Z"))).toMatchObject({ on: "us", days: 2 });
  });

  it("shows the deal's email and WhatsApp as one readable thread, oldest first, with links kept as words", async () => {
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, purpose, identity_key, from_email, to_emails, subject, body_text, body_html, sent_at, accepted_at)
      values ($1, $2, 'outbound', 'gmail', 'accepted', 'personal', 'buy', 'buy@rebattery.io', '{buyer@talk.example}', 'Offer', '', $3, '2026-11-05T09:00:00Z', '2026-11-05T09:00:00Z')`,
      [id("offer"), id("thread"), `<p>Hi,</p><p>The offer is <a href="https://crm.rebattery.io/o/1">here</a>.</p>`]);
    const messages = await history.dealHistory(id("talk"), alex);
    expect(messages.map((m) => [m.channel, m.from, m.text])).toEqual([
      ["mail", "buyer@talk.example", "We need 20."],
      ["mail", "Alex", "Which state of health?"],
      ["whatsapp", "Them", "SoH 90% on all of them"],
      ["mail", "ReBattery (buy@)", "Hi,\nThe offer is here (https://crm.rebattery.io/o/1)."],
    ]);
    // A deal with nothing linked has no history, and reads nothing else.
    expect(await history.dealHistory(id("fresh"), alex)).toEqual([]);
  });

  it("queues a WhatsApp update for a linked chat's new inbound message through the deal's Relay email, once", async () => {
    await pg.queryPg("update whatsapp_message set occurred_at = now() - interval '1 hour' where id = $1", [id("wa1")]);
    expect((await wa.whatsAppUpdatesDue(alex)).filter((u) => u.listing_id === id("talk"))).toEqual([]); // no Relay email on the deal yet
    const [item] = await pg.queryPg<{ id: string }>(`insert into relay_item (owner_id, gmail_thread_id, mail_thread_id, tab, status, bulk_listing_id, headline)
      values ($1::uuid, $2, $3, 'action', 'open', $4, 'Ioniq packs') returning id`, [alex, `g-${id("thread")}`, id("thread"), id("talk")]);
    const started: string[] = [];
    const queued = await wa.queueWhatsAppUpdates(alex, async (u) => { started.push(`${u.item_id}:${u.text}`); }, {});
    expect(queued).toEqual([id("talk")]);
    expect(started).toEqual([`${item.id}:SoH 90% on all of them`]);
    // A deal job since the message: nothing more to queue. And the switch turns it off.
    await pg.queryPg("insert into relay_job (item_id, owner_id, note, steps) values ($1, $2::uuid, '[deal:update] Update deal from this reply', '[]'::jsonb)", [item.id, alex]);
    expect((await wa.whatsAppUpdatesDue(alex)).filter((u) => u.listing_id === id("talk"))).toEqual([]);
    expect(await wa.queueWhatsAppUpdates(alex, async () => undefined, { RELAY_AUTO_DEAL_UPDATE: "off" })).toEqual([]);
  });

  it("team notes: @mentions show on that person's Today until they tick it, and only they can tick it", async () => {
    const note = await notes.addTeamNote(id("talk"), "@sean can you call them about SoH? cc @Ari", { userId: alex, email: `alex.${run}@example.test` });
    expect(note).toMatchObject({ mentions: ["Sean", "Ari"], ticked: {}, listing_id: id("talk") });
    const forSean = await notes.openMentionsFor("Sean");
    expect(forSean.map((m) => m.id)).toContain(note.id);
    expect(await notes.ownerOfUser(sean)).toBe("Sean");
    expect(await notes.ownerOfUser(alex)).toBe("Alex");
    expect(await notes.tickMention(note.id, "Alex")).toBe(false); // not mentioned
    expect(await notes.tickMention(note.id, "Sean")).toBe(true);
    expect((await notes.openMentionsFor("Sean")).map((m) => m.id)).not.toContain(note.id);
    expect((await notes.openMentionsFor("Ari")).map((m) => m.id)).toContain(note.id);
    // Stored as a note on the deal's story, with the names in its data.
    const [activity] = await pg.queryPg<{ kind: string; data: Record<string, unknown> }>("select kind, data from crm_bulk_listing_activity where id = $1::bigint", [note.id]);
    expect(activity).toMatchObject({ kind: "note", data: { mentions: ["Sean", "Ari"], team_note: true } });
    expect((await notes.listTeamNotes(id("talk")))[0].id).toBe(note.id);
  });

  it("removes a deal stuck in New with a reason: closed, with the reason in its Story, never deleted", async () => {
    expect(await notes.removeStuckListing(id("old"), "no_longer_needed", "Seller sold elsewhere", { userId: alex, email: `alex.${run}@example.test` })).toBe(true);
    const [listing] = await pg.queryPg<{ status: string; closed_reason: string }>("select status, closed_reason from crm_bulk_listings where id = $1", [id("old")]);
    expect(listing).toEqual({ status: "closed", closed_reason: "no_longer_needed" });
    const [story] = await pg.queryPg<{ body: string }>("select body from crm_bulk_listing_activity where bulk_listing_id = $1 and title = 'Removed from New'", [id("old")]);
    expect(story.body).toContain("Seller sold elsewhere");
    expect(await notes.removeStuckListing(id("old"), "other", "again", { userId: alex, email: "x" })).toBe(false);
  });

  it("tags a deal ticked Qualified without a price or a date", async () => {
    await pg.queryPg("update crm_bulk_listings set qualified_at = now(), qualified_by = 'alex@rebattery.io', clear_by = current_date + 30 where id = $1", [id("fresh")]);
    expect(await row(id("fresh"))).toMatchObject({ no_price: true, no_date: false });
    expect(await row(id("talk"))).toMatchObject({ no_price: false, no_date: false });
  });
});
