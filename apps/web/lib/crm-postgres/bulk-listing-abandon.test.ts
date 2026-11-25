import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("abandon and reopen from the Deals board", () => {
  let pg: typeof import("../postgres");
  let abandon: typeof import("./bulk-listing-abandon");
  let sheet: typeof import("./bulk-sheet");
  const actor = { userId: null, email: "qa@rebattery.io" };

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    abandon = await import("./bulk-listing-abandon");
    sheet = await import("./bulk-sheet");
    await pg.queryPg(`
      delete from crm_bulk_offers where id like 'bof_abn_%';
      delete from crm_bulk_listing_activity where bulk_listing_id like 'btl_abn_%';
      delete from crm_bulk_listings where id like 'btl_abn_%';
      insert into crm_bulk_listings (id, kind, party, summary, status, closed_reason, spec) values
        ('btl_abn_demand', 'demand', 'Lost Buyer', '200 Leaf packs', 'qualifying', null, '{"intent": "request"}'),
        ('btl_abn_supply', 'supply', 'Paired Seller', 'Leaf packs lot', 'open', null, '{}'),
        ('btl_abn_old', 'supply', 'Old Seller', 'Old lot', 'closed', 'gone', '{}'),
        ('btl_abn_dup', 'supply', 'Dup Seller', 'Dup lot', 'closed', 'duplicate', '{}'),
        ('btl_abn_never', 'demand', 'Quiet Buyer', 'Never offered', 'closed', 'no_longer_needed', '{"intent": "request"}'),
        ('btl_abn_pa', 'demand', 'Pair Buyer', 'Pair ask', 'open', null, '{"intent": "request"}'),
        ('btl_abn_pb', 'supply', 'Pair Seller', 'Pair lot', 'open', null, '{}');
      insert into crm_bulk_offers (id, bulk_listing_id, counterpart_id, role, stage) values
        ('bof_abn_pair', 'btl_abn_supply', 'btl_abn_demand', 'counterparty', 'negotiating'),
        ('bof_abn_paid', 'btl_abn_demand', null, 'counterparty', 'paid'),
        ('bof_abn_old', 'btl_abn_old', null, 'counterparty', 'offered'),
        ('bof_abn_dup', 'btl_abn_dup', null, 'counterparty', 'offered'),
        ('bof_abn_unstaged', 'btl_abn_demand', null, 'counterparty', null),
        ('bof_abn_both', 'btl_abn_pb', 'btl_abn_pa', 'counterparty', 'offered');
      insert into crm_bulk_offers (id, bulk_listing_id, role, stage) values ('bof_abn_contact', 'btl_abn_demand', 'contact', null);
    `);
  });

  afterAll(async () => {
    await pg.queryPg(`
      delete from crm_bulk_offers where id like 'bof_abn_%';
      delete from crm_bulk_listing_activity where bulk_listing_id like 'btl_abn_%';
      delete from crm_bulk_listings where id like 'btl_abn_%';`);
    await pg.pgPool.end();
  });

  const listing = async (id: string) => (await pg.queryPg<{ status: string; closed_reason: string | null; context: Record<string, unknown> }>(
    "select status, closed_reason, context from crm_bulk_listings where id = $1", [id]))[0];
  const offer = async (id: string) => (await pg.queryPg<{ stage: string; data: Record<string, unknown> }>("select stage, data from crm_bulk_offers where id = $1", [id]))[0];

  it("refuses a reason that is not offered for the side, and a listing that does not exist", async () => {
    expect(await abandon.abandonListing("btl_abn_demand", "gone", null, actor)).toBe("bad_reason");
    expect(await abandon.abandonListing("btl_abn_demand", "duplicate", null, actor)).toBe("bad_reason");
    expect(await abandon.abandonListing("btl_abn_missing", "other", null, actor)).toBe("missing");
    expect((await listing("btl_abn_demand")).status).toBe("qualifying");
  });

  it("closes the listing, marks its live offers lost, writes one note and lists it in Abandoned", async () => {
    expect(await abandon.abandonListing("btl_abn_demand", "bought_elsewhere", "Went elsewhere", actor)).toBe("ok");
    const closed = await listing("btl_abn_demand");
    expect(closed).toMatchObject({ status: "closed", closed_reason: "bought_elsewhere" });
    expect(closed.context.abandoned).toMatchObject({ by: "qa@rebattery.io", from_status: "qualifying" });
    expect(await offer("bof_abn_pair")).toMatchObject({ stage: "lost", data: { abandoned: { listing_id: "btl_abn_demand", stage: "negotiating" } } });
    expect((await offer("bof_abn_paid")).stage).toBe("paid");
    expect(await offer("bof_abn_unstaged")).toMatchObject({ stage: "lost", data: { abandoned: { stage: null } } });
    expect((await offer("bof_abn_contact")).stage).toBeNull();
    const story = await pg.queryPg<{ kind: string; title: string; body: string | null }>(
      "select kind, title, body from crm_bulk_listing_activity where bulk_listing_id = 'btl_abn_demand' order by id");
    expect(story.filter((row) => row.kind === "status" && row.title.startsWith("Closed"))).toHaveLength(0);
    expect(story.filter((row) => row.kind === "note")).toEqual([{ kind: "note", title: "Abandoned: Bought elsewhere", body: "Went elsewhere" }]);
    expect(await abandon.abandonListing("btl_abn_demand", "other", null, actor)).toBe("closed");

    const listed = (await sheet.listAbandoned()).filter((row) => row.id.startsWith("btl_abn_"));
    expect(listed.map((row) => row.id)).toEqual(["btl_abn_demand", "btl_abn_old"]);
    expect(listed[0]).toMatchObject({ kind: "demand", abandoned: { reason: "bought_elsewhere" } });
    expect(listed[0].abandoned?.at).toMatch(/^\d{4}-\d{2}-\d{2}/);
    // The paired supply's only live offer is lost now, so it leaves the deal stages.
    const live = (await sheet.listSheet()).find((row) => row.id === "btl_abn_supply");
    expect(live?.progress).not.toBe("Negotiating");
  });

  it("reopens to the status it had and puts the offers back", async () => {
    expect(await abandon.reopenListing("btl_abn_demand", actor)).toBe("ok");
    const open = await listing("btl_abn_demand");
    expect(open).toMatchObject({ status: "qualifying", closed_reason: null });
    expect(open.context.abandoned).toBeUndefined();
    const restored = await offer("bof_abn_pair");
    expect(restored.stage).toBe("negotiating");
    expect(restored.data.abandoned).toBeUndefined();
    expect((await offer("bof_abn_unstaged")).stage).toBeNull();
    expect(await abandon.reopenListing("btl_abn_demand", actor)).toBe("open");
    expect((await sheet.listAbandoned()).some((row) => row.id === "btl_abn_demand")).toBe(false);
  });

  it("reopens a listing closed elsewhere as open", async () => {
    expect(await abandon.reopenListing("btl_abn_old", actor)).toBe("ok");
    expect(await listing("btl_abn_old")).toMatchObject({ status: "open", closed_reason: null });
    expect((await offer("bof_abn_old")).stage).toBe("offered");
  });

  it("never reopens a listing closed as sold, duplicate or moved", async () => {
    expect(await abandon.reopenListing("btl_abn_dup", actor)).toBe("not_abandoned");
    expect(await listing("btl_abn_dup")).toMatchObject({ status: "closed", closed_reason: "duplicate" });
  });

  it("revives a deal between two abandoned listings only once both are open again", async () => {
    expect(await abandon.abandonListing("btl_abn_pa", "not_a_fit", null, actor)).toBe("ok");
    expect(await abandon.abandonListing("btl_abn_pb", "gone", null, actor)).toBe("ok");
    expect((await offer("bof_abn_both")).stage).toBe("lost");
    expect(await abandon.reopenListing("btl_abn_pa", actor)).toBe("ok");
    expect((await offer("bof_abn_both")).stage).toBe("lost");
    expect(await abandon.reopenListing("btl_abn_pb", actor)).toBe("ok");
    expect(await offer("bof_abn_both")).toMatchObject({ stage: "offered" });
    expect((await offer("bof_abn_both")).data.abandoned).toBeUndefined();
  });

  it("orders a listing with an unreadable abandon time by its other dates instead of failing", async () => {
    await pg.queryPg(`update crm_bulk_listings set context = context || '{"abandoned": {"at": "yesterday-ish"}}' where id = 'btl_abn_dup'`);
    const listed = (await sheet.listAbandoned()).filter((row) => row.id === "btl_abn_dup");
    expect(listed).toHaveLength(1);
    expect(listed[0].abandoned?.at).toMatch(/^\d{4}-/);
  });
});
