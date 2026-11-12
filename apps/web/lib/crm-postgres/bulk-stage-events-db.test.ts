import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("stage events (migration 116)", () => {
  let pg: typeof import("../postgres");
  let offers: typeof import("./bulk-offers");
  let events: typeof import("./bulk-stage-events");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (s: string) => `sev_${s}_${run}`;
  const user = "7d0e5d38-5b6f-4a37-9d77-000000000111";
  const history = async (kind: "listing" | "offer", subject: string) =>
    (await events.listStageEvents(kind, subject)).map((e) => [e.from_stage, e.to_stage, e.actor]);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    offers = await import("./bulk-offers");
    events = await import("./bulk-stage-events");
    await pg.queryPg("insert into crm_users (id, email, password_hash) values ($1, $2, 'x') on conflict (id) do nothing", [user, `alex+${run}@rebattery.io`]);
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, summary, status, spec) values ($1, 'supply', 'Seller', 'Lot', 'open', '{}'), ($2, 'demand', 'Buyer', 'Ask', 'open', '{"intent": "request"}')`,
      [id("sup"), id("dem")]);
  });
  afterAll(async () => {
    await pg.queryPg("delete from crm_bulk_stage_events where subject_id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_bulk_listings where id like $1", [`%_${run}`]);
    await pg.queryPg("delete from crm_users where id = $1", [user]);
    await pg.pgPool.end();
  });

  it("logs a new listing's first stage", async () => {
    expect(await history("listing", id("sup"))).toEqual([[null, "New", "system"]]);
  });

  it("logs every offer stage change made through the app with the user's email, and the listing stages it moves", async () => {
    const offer = await offers.addOffer(id("sup"), { name: "Buyer", stage: "candidate", counterpartId: id("dem") });
    await offers.updateOffer(id("sup"), offer.id, { stage: "offered" }, user);
    await offers.updateOffer(id("sup"), offer.id, { stage: "offered", nextStep: "Chase" }, user); // no stage change, no event
    expect(await history("offer", offer.id)).toEqual([[null, "candidate", "system"], ["candidate", "offered", `alex+${run}@rebattery.io`]]);
    expect(await history("listing", id("dem"))).toEqual([[null, "New", "system"], ["New", "Sourcing", "system"], ["Sourcing", "Found", `alex+${run}@rebattery.io`]]);
  });

  it("catches agent and plain SQL writes too, naming the agent when it says who it is", async () => {
    const [{ id: offerId }] = await pg.queryPg<{ id: string }>("select id from crm_bulk_offers where bulk_listing_id = $1", [id("sup")]);
    await pg.queryPg("update crm_bulk_offers set stage = 'negotiating' where id = $1", [offerId]);
    await pg.withPgTransaction(async (tx) => {
      await tx.query("select set_config('bulk.actor', 'jules', true)");
      await tx.query("update crm_bulk_offers set stage = 'contract_out' where id = $1", [offerId]);
      await tx.query("update crm_bulk_listings set hold_until = current_date + 3 where id = $1", [id("sup")]);
    });
    expect((await history("offer", offerId)).slice(-2)).toEqual([["offered", "negotiating", "system"], ["negotiating", "contract_out", "jules"]]);
    expect((await history("listing", id("sup"))).at(-1)).toEqual(["Available", "Reserved", "jules"]);
  });

  it("closes both listings when the offer is complete and sold what they state, and logs the closes", async () => {
    const [{ id: offerId }] = await pg.queryPg<{ id: string }>("select id from crm_bulk_offers where bulk_listing_id = $1", [id("sup")]);
    await pg.queryPg("update crm_bulk_listings set quantity = '48 packs' where id in ($1, $2)", [id("sup"), id("dem")]);
    await offers.updateOffer(id("sup"), offerId, {
      stage: "complete", terms: { unit: "pack" }, paid: { paid_on: "2026-12-03", paid_amount: 18000, paid_currency: "EUR", quantity: 48, take_gbp: 1500 },
    }, user);
    const rows = await pg.queryPg<{ kind: string; status: string; closed_reason: string }>(
      "select kind, status, closed_reason from crm_bulk_listings where id in ($1, $2) order by kind", [id("dem"), id("sup")]);
    expect(rows).toEqual([{ kind: "demand", status: "closed", closed_reason: "bought_from_us" }, { kind: "supply", status: "closed", closed_reason: "sold" }]);
    expect((await history("listing", id("dem"))).at(-1)).toEqual(["Found", "Closed", `alex+${run}@rebattery.io`]);
    expect((await history("listing", id("sup"))).at(-1)).toEqual(["Reserved", "Sold", `alex+${run}@rebattery.io`]);
    const stored = await offers.getOffer(id("sup"), offerId, null);
    expect(stored).toMatchObject({ stage: "complete", paid_on: "2026-12-03", paid_amount: 18000, paid_currency: "EUR", quantity: 48, take_gbp: 1500 });
  });

  it("refuses a paid amount without its currency", async () => {
    const [{ id: offerId }] = await pg.queryPg<{ id: string }>("select id from crm_bulk_offers where bulk_listing_id = $1", [id("sup")]);
    await expect(pg.queryPg("update crm_bulk_offers set paid_currency = null where id = $1", [offerId])).rejects.toThrow(/paid_pair|add the currency/);
  });
});
