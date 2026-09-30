import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { todayInLondon } from "../bulk-trades";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("dismantlers data", () => {
  let pg: typeof import("../postgres");
  let db: typeof import("./dismantlers");
  let userId: string;
  let otherUserId: string;
  const s = Math.random().toString(36).slice(2, 8);
  const today = todayInLondon();

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    db = await import("./dismantlers");
    const user = async (label: string) => (await pg.queryPg<{ id: string }>(
      `insert into crm_users (email, display_name, password_hash)
       values ('dismantlers-${label}-' || gen_random_uuid() || '@example.test', $1, 'x') returning id::text`, [label],
    ))[0].id;
    userId = await user("Owner");
    otherUserId = await user("Colleague");
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  const events = (id: string) =>
    pg.queryPg<{ kind: string; changes: Record<string, unknown> }>(
      "select kind, changes from crm_dismantler_events where dismantler_id = $1 order by id", [id]);
  const tags = async (companyId: string) =>
    (await pg.queryPg<{ tags: string[] | null }>("select tags from crm_companies where id = $1", [companyId]))[0].tags;

  it("adds a dismantler by name as a new CRM company, tagged and logged", async () => {
    const d = await db.createDismantler({ name: `Synthetic Breakers ${s}`, patch: { country: "UK" } }, userId);
    expect(d).toMatchObject({ name: `Synthetic Breakers ${s}`, stage: "Found", stage_since: today, country: "UK" });
    expect(await tags(d.company_id)).toEqual(["dismantler"]);
    expect((await events(d.id)).map((event) => event.kind)).toEqual(["created"]);
  });

  it("links the existing company, and refuses a second dismantler for it or an ambiguous name", async () => {
    await pg.queryPg("insert into crm_companies (id, name, tags) values ($1, $2, '{supplier}')", [`co-${s}`, `Existing ATF ${s}`]);
    const d = await db.createDismantler({ name: ` existing atf ${s} `, patch: {} }, userId);
    expect(d.company_id).toBe(`co-${s}`);
    expect(await tags(`co-${s}`)).toEqual(["supplier", "dismantler"]);
    await expect(db.createDismantler({ company_id: `co-${s}`, patch: {} }, userId)).rejects.toThrow(/already a dismantler/);

    await pg.queryPg("insert into crm_companies (id, name) values ($1, $3), ($2, $3)", [`a-${s}`, `b-${s}`, `Twin Salvage ${s}`]);
    await expect(db.createDismantler({ name: `Twin Salvage ${s}`, patch: {} }, userId)).rejects.toThrow(/Several CRM companies/);
  });

  it("logs stage moves, parks with where it came from, and brings it back", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ($1, $2)", [`st-${s}`, `Stage Motors ${s}`]);
    const d = await db.createDismantler({ company_id: `st-${s}`, patch: {} }, userId);
    await pg.queryPg("update crm_dismantlers set stage_since = '2026-01-01' where id = $1", [d.id]);

    const talking = await db.updateDismantler(d.id, { stage: "Talking" }, userId);
    expect(talking).toMatchObject({ stage: "Talking", stage_since: today });
    const parked = await db.updateDismantler(d.id, { stage: "Parked", park_reason: "Not now", revisit_on: "2027-01-04" }, userId);
    expect(parked).toMatchObject({ stage: "Parked", parked_from: "Talking", park_reason: "Not now", revisit_on: "2027-01-04" });
    const back = await db.updateDismantler(d.id, { stage: "Talking" }, userId);
    expect(back).toMatchObject({ stage: "Talking", parked_from: null, park_reason: null, revisit_on: null });

    const log = await events(d.id);
    expect(log.map((event) => event.kind)).toEqual(["created", "updated", "updated", "updated"]);
    expect(log[1].changes).toEqual({ stage: ["Found", "Talking"] });
    expect(await db.updateDismantler(d.id, { stage: "Talking" }, userId)).toMatchObject({ stage: "Talking" });
    expect((await events(d.id)).length).toBe(4);
  });

  it("only lets a next step be for someone at the company", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ($1, $2), ($3, $4)", [`p-${s}`, `People Co ${s}`, `x-${s}`, `Elsewhere ${s}`]);
    await pg.queryPg("insert into crm_people (id, full_name, email, company_id) values ($1, 'Pat Example', 'pat@example.test', $2), ($3, 'Out Sider', 'out@example.test', $4)",
      [`pat-${s}`, `p-${s}`, `out-${s}`, `x-${s}`]);
    const d = await db.createDismantler({ company_id: `p-${s}`, patch: {} }, userId);
    await expect(db.updateDismantler(d.id, { next_step_person_id: `out-${s}` }, userId)).rejects.toThrow(/not at this company/);
    await expect(db.createDismantler({ name: `Wrong Person ${s}`, patch: { next_step_person_id: `out-${s}` } }, userId)).rejects.toThrow(/not at this company/);
    expect((await pg.queryPg("select 1 from crm_companies where name = $1", [`Wrong Person ${s}`])).length).toBe(0);
    const saved = await db.updateDismantler(d.id, { next_step: "Intro call", next_step_person_id: `pat-${s}` }, userId);
    expect(saved).toMatchObject({ next_step: "Intro call", next_step_person_name: "Pat Example" });
  });

  it("starts outreach on a batch: Talking, with a follow-up", async () => {
    const a = await db.createDismantler({ name: `Batch A ${s}`, patch: {} }, userId);
    const b = await db.createDismantler({ name: `Batch B ${s}`, patch: { stage: "Signed up" } }, userId);
    const saved = await db.startOutreach([a.id, b.id], { next_step: "Follow up if no reply", next_step_due: "2026-10-06" }, userId);
    expect(saved.map((d) => [d.stage, d.next_step_due])).toEqual([
      ["Talking", "2026-10-06"],
      ["Signed up", "2026-10-06"],
    ]);
    expect((await events(a.id)).at(-1)).toMatchObject({ kind: "outreach", changes: { stage: ["Found", "Talking"] } });
    await expect(db.startOutreach([a.id, "dm_missing"], { next_step: "x", next_step_due: "2026-10-06" }, userId)).rejects.toThrow(/no longer exists/);
  });

  it("previews an import, then adds only the new ones", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ($1, $2)", [`imp-${s}`, `Known Yard ${s}`]);
    const rows = [
      { name: `Fresh Yard ${s}`, country: "UK", ebay_username: "fresh", ebay_listings: 12 },
      { name: `Known Yard ${s}`, country: "UK", ebay_username: null, ebay_listings: null },
    ];
    expect(await db.importDismantlers(rows, false, userId)).toEqual([
      { name: `Fresh Yard ${s}`, action: "new company" },
      { name: `Known Yard ${s}`, action: "existing company" },
    ]);
    expect((await pg.queryPg("select 1 from crm_companies where name = $1", [`Fresh Yard ${s}`])).length).toBe(0);

    await db.importDismantlers(rows, true, userId);
    const again = await db.importDismantlers(rows, false, userId);
    expect(again.map((item) => item.action)).toEqual(["already a dismantler", "already a dismantler"]);
    const { dismantlers } = await db.listDismantlers();
    expect(dismantlers.find((d) => d.name === `Fresh Yard ${s}`)).toMatchObject({ ebay_listings: 12, source: "Imported list", stage: "Found" });
  });

  it("shares last contact from the CRM sync, and keeps email activity and drafts to their owner", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ($1, $2)", [`m-${s}`, `Mail Yard ${s}`]);
    await pg.queryPg(
      `insert into crm_people (id, full_name, email, company_id, last_interaction_at) values
         ($1, 'Mo Mail', 'mo@example.test', $3, '2026-09-20T10:00:00Z'),
         ($2, 'Di Mail', 'di@example.test', $3, '2026-09-28T23:30:00Z')`,
      [`mo-${s}`, `di-${s}`, `m-${s}`],
    );
    const d = await db.createDismantler({ company_id: `m-${s}`, patch: { stage: "Talking" } }, userId);
    // Latest across the company's people, as a UK date (23:30 UTC on 28 Sep is 29 Sep in London).
    expect((await db.getDismantler(d.id))!.last_contact).toBe("2026-09-29");
    expect((await db.listDismantlers()).dismantlers.find((row) => row.id === d.id)!.last_contact).toBe("2026-09-29");

    await pg.queryPg(
      `insert into crm_email_messages (id, subject, sent_at, from_person_id, from_email, mailbox_owner_id) values
         ($1, 'Their reply', '2026-09-20T10:00:00Z', $3, 'mo@example.test', $4::uuid),
         ($2, 'Colleague thread', '2026-09-28T10:00:00Z', $3, 'mo@example.test', $5::uuid)`,
      [`e1-${s}`, `e2-${s}`, `mo-${s}`, userId, otherUserId],
    );
    const detail = (await db.getDismantlerDetail(d.id, userId))!;
    expect(detail.people.map((person) => person.name).sort()).toEqual(["Di Mail", "Mo Mail"]);
    expect(detail.activity.filter((item) => item.kind === "email")).toEqual([
      expect.objectContaining({ subject: "Their reply", outgoing: false }),
    ]);
    expect(detail.activity.some((item) => item.kind === "event" && item.event === "created")).toBe(true);

    await db.logEmailDraft(d.id, { to: ["mo@example.test"], subject: "Private draft", draft_id: "r1" }, userId);
    const drafts = async (viewer: string) => (await db.getDismantlerDetail(d.id, viewer))!.activity
      .filter((item) => item.kind === "event" && item.event === "email_draft");
    expect(await drafts(userId)).toHaveLength(1);
    expect(await drafts(otherUserId)).toHaveLength(0);
  });

  it("keeps history append-only, but removes it with the dismantler", async () => {
    const d = await db.createDismantler({ name: `History ${s}`, patch: {} }, userId);
    await expect(pg.queryPg("update crm_dismantler_events set kind = 'x' where dismantler_id = $1", [d.id])).rejects.toThrow(/append-only/);
    await expect(pg.queryPg("delete from crm_dismantler_events where dismantler_id = $1", [d.id])).rejects.toThrow(/append-only/);
    const [leaver] = await pg.queryPg<{ id: string }>(
      "insert into crm_users (email, display_name, password_hash) values ('leaver-' || gen_random_uuid() || '@example.test', 'Leaver', 'x') returning id::text");
    await db.updateDismantler(d.id, { country: "UK" }, leaver.id);
    await pg.queryPg("delete from crm_users where id = $1", [leaver.id]);
    expect((await pg.queryPg<{ actor_user_id: string | null }>(
      "select actor_user_id from crm_dismantler_events where dismantler_id = $1 and kind = 'updated'", [d.id]))[0].actor_user_id).toBeNull();

    await pg.queryPg("delete from crm_dismantlers where id = $1", [d.id]);
    expect((await events(d.id)).length).toBe(0);
  });

  it("gives the ReBattery match the company's emails and domain", async () => {
    await pg.queryPg("insert into crm_companies (id, name, website) values ($1, $2, 'https://www.matchyard.example/')", [`mt-${s}`, `Match Yard ${s}`]);
    await pg.queryPg("insert into crm_people (id, full_name, email, company_id) values ($1, 'Ann', 'Ann@MatchYard.example', $2), ($3, 'Nobody', null, $2)",
      [`ann-${s}`, `mt-${s}`, `nob-${s}`]);
    const d = await db.createDismantler({ company_id: `mt-${s}`, patch: {} }, userId);
    expect(await db.getDismantler(d.id)).toMatchObject({ match_emails: ["ann@matchyard.example"], match_domain: "https://www.matchyard.example/" });
    expect((await db.listMatchInputs()).find((input) => input.id === d.id)).toEqual({
      id: d.id, platform_account_id: null, match_emails: ["ann@matchyard.example"], match_domain: "https://www.matchyard.example/",
    });
  });
});
