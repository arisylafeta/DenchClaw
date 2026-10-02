import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../gmail-drafts", () => ({ fetchGmailAttachment: vi.fn() }));
vi.mock("../history-pass", () => ({ startHistoryPass: vi.fn(() => true) }));

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("classification rules (migration 029)", () => {
  let pg: typeof import("../postgres");
  const company = async (id: string) =>
    (await pg.queryPg<{ purpose: string[] | null; segment: string | null; stage: string | null; buyer_stage: string | null }>(
      "select purpose, segment, relationship_stage as stage, buyer_stage from crm_companies where id = $1", [id]))[0];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  it("starts a company with a Purpose at New, and moves Stage forward with Buyer Stage but never out of Excluded", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ('cr_plain', 'No Purpose Ltd')");
    expect((await company("cr_plain")).stage).toBeNull();

    await pg.queryPg("insert into crm_companies (id, name, purpose) values ('cr_buyer', 'Rule Buyer', '{Buyer}')");
    expect((await company("cr_buyer")).stage).toBe("New");

    await pg.queryPg("update crm_companies set buyer_stage = 'Qualified' where id = 'cr_buyer'");
    expect((await company("cr_buyer")).stage).toBe("Engaged");
    await pg.queryPg("update crm_companies set buyer_stage = 'Contacted' where id = 'cr_buyer'");
    expect((await company("cr_buyer")).stage).toBe("Engaged"); // forward only
    await pg.queryPg("update crm_companies set relationship_stage = 'Excluded' where id = 'cr_buyer'");
    await pg.queryPg("update crm_companies set buyer_stage = 'Customer' where id = 'cr_buyer'");
    expect((await company("cr_buyer")).stage).toBe("Excluded");
  });

  it("makes a new dismantler a Dismantler and a trade supplier an Active Supplier", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ('cr_dm', 'Rule Dismantler')");
    await pg.queryPg("insert into crm_dismantlers (id, company_id, stage) values ('dm_cr', 'cr_dm', 'Found')");
    expect(await company("cr_dm")).toMatchObject({ purpose: ["Dismantler"], segment: "Salvage / dismantler", stage: "New" });

    await pg.queryPg("insert into crm_companies (id, name, purpose) values ('cr_seller', 'Rule Seller', '{Buyer}')");
    const [user] = await pg.queryPg<{ id: string }>(
      `insert into crm_users (email, display_name, password_hash)
       values ('rules-' || gen_random_uuid() || '@example.test', 'Alex', 'x') returning id`);
    const trades = await import("./bulk-trades");
    const lot = (await trades.createBulkTrade({ title: "Rule lot", trade_kind: "packs", trade_stage: "With buyers" }, user.id)).id;
    await pg.queryPg(`insert into crm_bulk_trade_parties (id, lot_id, role, display_name, company_id)
      values ('party_cr', $1, 'supplier', 'Rule Seller', 'cr_seller')`, [lot]);
    expect(await company("cr_seller")).toMatchObject({ purpose: ["Buyer", "Supplier"], stage: "Active" });
  });

  it("moves a buyer's Buyer Stage to Contacted when an intro is sent", async () => {
    await pg.queryPg(`insert into crm_companies (id, name, purpose) values ('cr_intro', 'Intro Buyer', '{Buyer}');
      insert into crm_people (id, full_name, email, company_id) values ('p_cr_intro', 'Ivy', 'ivy@intro.example', 'cr_intro');
      insert into campaigns (id, campaign_name, type) values ('c_cr_intro', 'Intro', 'intro')`);
    await pg.queryPg(`insert into crm_campaign_sends (id, campaign_id, person_id, company_id, listing_id, auction_url, recipient_email, state)
      values ('s_cr_intro', 'c_cr_intro', 'p_cr_intro', 'cr_intro', 'intro', 'https://example.test', 'ivy@intro.example', 'accepted')`);
    expect(await company("cr_intro")).toMatchObject({ stage: "Contacted", buyer_stage: "Contacted" });
  });
});
