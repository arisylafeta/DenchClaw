import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { routeLead } from "./relay-front-door";
import type { LeadData } from "./relay-lead-core";

// No job runner, no mail tool: startDealJob's spawn and its prompt folder are stubbed, so no Matcha job can start.
const spawned = vi.hoisted(() => [] as string[][]);
vi.mock("node:child_process", async (actual) => ({
  ...(await actual<typeof import("node:child_process")>()),
  spawn: (cmd: string, args: string[]) => { spawned.push([cmd, ...args]); return { unref: () => undefined }; },
  execFile: () => { throw new Error("no external commands in tests"); },
}));
vi.mock("node:fs", async (actual) => ({ ...(await actual<typeof import("node:fs")>()), mkdirSync: () => undefined, writeFileSync: () => undefined }));

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

function lead(facts: Record<string, string>, over: Partial<LeadData> = {}): LeadData {
  const list = Object.entries(facts).map(([key, value]) => ({ key, value }));
  return {
    side: "seller", unit: "packs", role: "owner", firstName: "Dana", summary: "Dana has used Leaf packs in Leeds.", facts: list, asked: [], other: [],
    have: [...list.map((f) => f.key), "owner"], sent: null, deal: false,
    email: { subject: "Leaf packs", text: "Hi, we have packs.", at: "2026-11-10T09:00:00Z", files: [] },
    route: routeLead({ facts: list, recycling: null }), recycling: null, ...over,
  };
}

describe.skipIf(!TEST_URL)("relay front door (database)", () => {
  let pg: typeof import("./postgres");
  let deal: typeof import("./relay-deal");
  let relay: typeof import("./relay");
  let leadServer: typeof import("./relay-lead");
  let owner: { id: string; email: string };
  const run = `${Date.now()}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("./postgres");
    deal = await import("./relay-deal");
    relay = await import("./relay");
    leadServer = await import("./relay-lead");
    const [user] = await pg.queryPg<{ id: string; email: string }>(
      "insert into crm_users (email, display_name, password_hash) values ($1, 'Relay Test', 'x') returning id, email", [`relay-front-door-${run}@example.test`]);
    owner = user;
  });

  afterAll(async () => { await pg.pgPool.end(); });

  /** One thread with their inbound email, a Relay item, our reply as a draft held for sending, and a queued lead card. */
  async function sentCard(name: string, data: LeadData, opts: { accepted: boolean; email?: string }) {
    const email = opts.email ?? `${name}-${run}@acme-${name}.example`;
    const thread = `thread-${name}-${run}`;
    await pg.queryPg("insert into mail_thread (id, subject, gmail_thread_id, mailbox_owner_id) values ($1, 'Leaf packs', $2, $3::uuid)", [thread, `g-${thread}`, owner.id]);
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, from_email, to_emails, subject, body_text, sent_at)
      values ($1, $2, 'inbound', 'gmail', 'received', $3, '{supply@rebattery.io}', 'Leaf packs', 'Hi, we have packs.', now() - interval '1 hour')`, [`in-${thread}`, thread, email]);
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, purpose, from_email, to_emails, subject, body_text, personalization, accepted_at)
      values ($1, $2, 'outbound', 'gmail', $3, 'personal', 'supply@rebattery.io', array[$4], 'Re: Leaf packs', 'Hi Dana', $5::jsonb, $6)`,
      [`out-${thread}`, thread, opts.accepted ? "accepted" : "draft", email, JSON.stringify(opts.accepted ? {} : { scheduled_send: { at: new Date(Date.now() + 30_000).toISOString(), undo: true } }), opts.accepted ? new Date().toISOString() : null]);
    const [item] = await pg.queryPg<{ id: string }>(`insert into relay_item (owner_id, gmail_thread_id, mail_thread_id, tab, status, counterpart_email, counterpart_name, contact_type, headline)
      values ($1::uuid, $2, $3, 'action', 'review', $4, 'Dana Field', 'supplier', 'Leaf packs') returning id`, [owner.id, `g-${thread}`, thread, email]);
    const [draft] = await pg.queryPg<{ id: string }>("insert into relay_draft (item_id, role, position, title, mail_message_id, origin) values ($1, 'primary', 0, 'Reply to Dana', $2, 'card') returning id",
      [item.id, `out-${thread}`]);
    const [card] = await pg.queryPg<{ id: string }>(`insert into relay_card (item_id, owner_id, message_id, status, data, state, draft_id)
      values ($1, $2::uuid, $3, 'queued', $4::jsonb, '{}'::jsonb, $5) returning id`,
      [item.id, owner.id, `in-${thread}`, JSON.stringify({ lead: data, who: { name: "Dana Field", company: "Acme", email, at: "2026-11-10T09:00:00Z" }, identity: "supply" }), draft.id]);
    return { item: item.id, card: card.id, draft: draft.id, thread, email };
  }
  const listingsFor = (email: string) => pg.queryPg<Record<string, unknown>>("select * from crm_bulk_listings where email = $1", [email]);

  it("opens the deal when a bulk lead's reply has gone, once, from the card's facts", async () => {
    const bulk = lead({ what: "Nissan Leaf 40kWh", how_many: "20 packs", where: "Leeds", when: "by 30 Nov" });
    const s = await sentCard("bulk", bulk, { accepted: true });
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, from_email, to_emails, cc_emails, subject, sent_at)
      values ($1, $2, 'inbound', 'gmail', 'received', $3, '{supply@rebattery.io}', $4, 'Re: Leaf packs', now() - interval '2 hours')`,
      [`cc-${s.thread}`, s.thread, s.email, [`ops@${s.email.split("@")[1]}`]]);
    const first = await deal.settleSentCards(owner.id);
    expect(first.opened).toHaveLength(1);
    expect((await deal.settleSentCards(owner.id)).opened).toEqual([]);
    const [listing] = await listingsFor(s.email);
    expect(await listingsFor(s.email)).toHaveLength(1);
    expect(listing).toMatchObject({ kind: "supply", status: "open", quantity: "20 packs", location: "Leeds", waiting_on: "them", route: "bulk", source_kind: "email" });
    expect(listing.context).toMatchObject({ owner: "Alex", listing_title: "20x Nissan Leaf 40kWh Packs", size: "bulk" });
    expect(String(listing.next_action)).toMatch(/^Chase Dana for the first ask: price, health/);
    expect(listing.next_due).toBeTruthy();
    const [item] = await pg.queryPg<{ bulk_listing_id: string }>("select bulk_listing_id from relay_item where id = $1", [s.item]);
    expect(item.bulk_listing_id).toBe(listing.id);
    const [card] = await pg.queryPg<{ status: string; data: { sent: { deal_id: string; route: { route: string } } } }>("select status, data from relay_card where id = $1", [s.card]);
    expect(card.status).toBe("sent");
    expect(card.data.sent).toMatchObject({ deal_id: listing.id, route: { route: "bulk" } });
    const fields = await pg.queryPg<{ field_key: string; value: string | null; asked_count: number }>(
      "select field_key, value, asked_count from crm_bulk_listing_fields where bulk_listing_id = $1 order by field_key", [listing.id]);
    expect(fields.find((f) => f.field_key === "model")).toMatchObject({ value: "Nissan Leaf 40kWh", asked_count: 0 });
    expect(fields.find((f) => f.field_key === "seller_price")).toMatchObject({ value: null, asked_count: 1 });
    const contacts = await pg.queryPg<{ contact: string }>("select contact from crm_bulk_offers where bulk_listing_id = $1 and role = 'contact' order by contact", [listing.id]);
    expect(contacts.map((c) => c.contact).sort()).toEqual([s.email, `ops@${s.email.split("@")[1]}`].sort());
    const [story] = await pg.queryPg<{ title: string }>("select title from crm_bulk_listing_activity where bulk_listing_id = $1 and kind = 'mail'", [listing.id]);
    expect(story.title).toBe("First reply sent; deal opened from the lead card");
    const [link] = await pg.queryPg<{ state: string }>("select state from crm_bulk_thread_links where bulk_listing_id = $1 and thread_id = $2", [listing.id, s.thread]);
    expect(link.state).toBe("proposed");
  });

  it("Undo inside the hold leaves no deal behind", async () => {
    const s = await sentCard("undo", lead({ what: "Nissan Leaf 40kWh", how_many: "20 packs" }), { accepted: false });
    await leadServer.undoLeadSend(s.card, owner.id);
    await deal.settleSentCards(owner.id);
    // Even if the email somehow went later, a card that was undone is not queued any more.
    await pg.queryPg("update mail_message set state = 'accepted', accepted_at = now() where id = $1", [`out-${s.thread}`]);
    await deal.settleSentCards(owner.id);
    expect(await listingsFor(s.email)).toEqual([]);
    const [card] = await pg.queryPg<{ status: string }>("select status from relay_card where id = $1", [s.card]);
    expect(card.status).toBe("ready");
  });

  it("opens nothing while the reply is still held", async () => {
    const s = await sentCard("held", lead({ what: "Nissan Leaf 40kWh", how_many: "20 packs" }), { accepted: false });
    await deal.settleSentCards(owner.id);
    expect(await listingsFor(s.email)).toEqual([]);
  });

  it("opens no deal for a lead under the bulk line, and keeps its route on the card", async () => {
    const s = await sentCard("small", lead({ what: "Leaf 40kWh", how_many: "1 pack", price: "£3,000 per pack" }), { accepted: true });
    await deal.settleSentCards(owner.id);
    expect(await listingsFor(s.email)).toEqual([]);
    const [card] = await pg.queryPg<{ status: string; data: { sent: { route: { route: string }; deal_id: string | null } } }>("select status, data from relay_card where id = $1", [s.card]);
    expect(card).toMatchObject({ status: "sent", data: { sent: { route: { route: "marketplace" }, deal_id: null } } });
  });

  it("queues Update deal from this reply by itself, once, and not when switched off", async () => {
    const s = await sentCard("auto", lead({ what: "Nissan Leaf 40kWh", how_many: "20 packs" }), { accepted: true });
    await deal.settleSentCards(owner.id);
    await pg.queryPg(`insert into mail_message (id, thread_id, direction, transport, state, from_email, to_emails, subject, body_text, sent_at)
      values ($1, $2, 'inbound', 'gmail', 'received', $3, '{supply@rebattery.io}', 'Re: Leaf packs', 'Price is 2,000 per pack', now())`, [`reply-${s.thread}`, s.thread, s.email]);
    await pg.queryPg("update relay_item set status = 'open' where id = $1", [s.item]);
    expect(await deal.queueReplyUpdates(owner.id, async () => undefined, { RELAY_AUTO_DEAL_UPDATE: "off" })).toEqual([]);
    const start = (id: string) => relay.startDealJob(id, owner.id, "update", { auto: true });
    spawned.length = 0;
    const [one, two] = await Promise.all([deal.queueReplyUpdates(owner.id, start, {}), deal.queueReplyUpdates(owner.id, start, {})]);
    expect([...one, ...two].filter((id) => id === s.item)).toHaveLength(1);
    expect(await deal.queueReplyUpdates(owner.id, start, {})).not.toContain(s.item);
    const jobs = await pg.queryPg<{ note: string }>("select note from relay_job where item_id = $1", [s.item]);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].note).toMatch(/^\[deal:update\] Update deal from this reply \(automatic/);
    expect(spawned).toHaveLength(1);
  });

  it("closes a deal a failed-fit job just made, and leaves older or linked deals alone", async () => {
    const before = new Date(Date.now() - 60_000).toISOString();
    const make = async (id: string) => pg.queryPg("insert into crm_bulk_listings (id, kind, party, summary, status, email) values ($1, 'supply', 'Other Co', 'Packs', 'open', 'other@else.example')", [id]);
    const fresh = `bt_fit_${run}`, linked = `bt_fit_linked_${run}`, old = `bt_fit_old_${run}`;
    await make(old);
    await pg.queryPg("update crm_bulk_listings set created_at = now() - interval '1 day' where id = $1", [old]);
    await make(fresh);
    await make(linked);
    const s = await sentCard("fit", lead({ what: "Leaf", how_many: "2 packs" }), { accepted: false });
    await pg.queryPg("update relay_item set bulk_listing_id = $2 where id = $1", [s.item, linked]);
    expect(await deal.closeUnfitListing(fresh, before, "job-1")).toBe(true);
    expect(await deal.closeUnfitListing(old, before, "job-1")).toBe(false);
    expect(await deal.closeUnfitListing(linked, before, "job-1")).toBe(false);
    const rows = await pg.queryPg<{ id: string; status: string }>("select id, status from crm_bulk_listings where id = any($1) order by id", [[fresh, linked, old]]);
    expect(Object.fromEntries(rows.map((r) => [r.id, r.status]))).toEqual({ [fresh]: "closed", [linked]: "open", [old]: "open" });
  });

  it("qualifies only with every item answered or cannot-provide, checked, and ticked; price and date may be missing", async () => {
    const id = `bt_q_${run}`;
    await pg.queryPg(`insert into crm_bulk_listings (id, kind, party, summary, status, email, quantity, location) values ($1, 'supply', 'Q Co', 'Packs', 'open', 'q@q.example', '20 packs', 'Leeds')`, [id]);
    await pg.queryPg("insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values ($1, 'model', 'Leaf 40kWh', 'unverified', 'teaser')", [id]);
    const qualified = async () => (await pg.queryPg<{ q: boolean; stage: string }>("select bulk_listing_qualified($1) as q, bulk_listing_stage($1) as stage", [id]))[0];
    expect(await deal.setQualifiedTick(id, true, "alex@rebattery.io")).toEqual({ ok: false, missing: ["what", "how_many", "where", "health"] });
    for (const key of ["what", "how_many", "where"]) await deal.setCheckState(id, "supply", key, { checked: true }, "alex@rebattery.io");
    expect(await deal.setQualifiedTick(id, true, "alex@rebattery.io")).toEqual({ ok: false, missing: ["health"] });
    await deal.setCheckState(id, "supply", "health", { cannot: true, checked: true }, "alex@rebattery.io");
    expect((await qualified()).q).toBe(false);
    expect(await deal.setQualifiedTick(id, true, "alex@rebattery.io")).toEqual({ ok: true });
    expect(await qualified()).toEqual({ q: true, stage: "Qualified" });
    // The TS rule agrees, and shows the missing price and date.
    const fields = await pg.queryPg("select field_key, value, status, asked_count, cannot_provide, checked_by, checked_at::text as checked_at from crm_bulk_listing_fields where bulk_listing_id = $1", [id]);
    const [row] = await pg.queryPg("select id, kind, summary as title, quantity, location, clear_by::text as clear_by, context, spec, null as volume, null as volume_unit, null as max_price, null as price_currency, null as price_unit, null as needed_by, null as product_family, route, qualified_at::text as qualified_at, qualified_by from crm_bulk_listings where id = $1", [id]);
    const { buildChecklist } = await import("./relay-checklist");
    const list = buildChecklist(row as never, fields as never, []);
    expect(list.qualify).toMatchObject({ qualified: true, noPrice: true, noDate: true });
    // Taking a check back takes Qualified away.
    await deal.setCheckState(id, "supply", "where", { checked: false }, "alex@rebattery.io");
    expect((await qualified()).q).toBe(false);
    const events = await pg.queryPg<{ to_stage: string }>("select to_stage from crm_bulk_stage_events where subject_kind = 'listing' and subject_id = $1 order by id", [id]);
    expect(events.map((e) => e.to_stage)).toEqual(["New", "Qualified", "New"]);
  });

  it("counts a sent Draft the ask as the second ask, once", async () => {
    const s = await sentCard("ask", lead({ what: "Nissan Leaf 40kWh", how_many: "20 packs" }), { accepted: true });
    await deal.settleSentCards(owner.id);
    const [{ bulk_listing_id: listing }] = await pg.queryPg<{ bulk_listing_id: string }>("select bulk_listing_id from relay_item where id = $1", [s.item]);
    const [d] = await pg.queryPg<{ id: string }>("insert into relay_draft (item_id, role, position, title, state, ask_keys, sent_at) values ($1, 'primary', 0, 'Draft the ask', 'sent', '{price,where}', now()) returning id", [s.item]);
    await deal.recordSentAsks([d.id]);
    await deal.recordSentAsks([d.id]);
    const rows = await pg.queryPg<{ field_key: string; asked_count: number }>("select field_key, asked_count from crm_bulk_listing_fields where bulk_listing_id = $1 and field_key in ('seller_price', 'location')", [listing]);
    expect(Object.fromEntries(rows.map((r) => [r.field_key, r.asked_count]))).toEqual({ seller_price: 2, location: 2 });
  });
});
