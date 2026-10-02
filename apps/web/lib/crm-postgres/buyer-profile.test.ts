import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("buyer profile", () => {
  let pg: typeof import("../postgres");
  let profile: typeof import("./company-profile");
  let demand: typeof import("./bulk-demand");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    profile = await import("./company-profile");
    demand = await import("./bulk-demand");
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  it("logs each buyer change with a date, stamps stage changes, and suggests a stage from the data", async () => {
    await pg.queryPg(`insert into crm_companies (id, name) values ('co_bp', 'Profile Buyer');
      insert into crm_people (id, full_name, email, company_id) values ('p_bp', 'Pat Buyer', 'pat@bp.example', 'co_bp')`);
    await pg.queryPg(`update crm_companies set buyer_stage = 'Contacted', buyer_tier = 'A', buyer_capabilities = array['Recycle'],
      buyer_can_receive_waste = true where id = 'co_bp'`);
    await pg.queryPg("update crm_companies set notes = 'not a buyer field' where id = 'co_bp'");
    await demand.addDemand({ buyer: "Profile Buyer", company_id: "co_bp", wants: "LFP packs" }, null);

    let buyer = await profile.getBuyer("co_bp");
    expect(buyer.profile).toMatchObject({ stage: "Contacted", tier: "A", capabilities: ["Recycle"], can_receive_waste: true });
    expect(buyer.profile.stage_changed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(buyer.changes.map((c) => [c.field, c.old_value, c.new_value]).toSorted()).toEqual([
      ["buyer_can_receive_waste", null, true], ["buyer_capabilities", null, ["Recycle"]], ["buyer_stage", null, "Contacted"],
      ["buyer_tier", null, "A"], ["relationship_stage", null, "Contacted"], // Stage follows Buyer Stage
    ]);
    expect(buyer.demand.map((d) => d.wants)).toEqual(["LFP packs"]);
    expect(buyer.engagement).toMatchObject({ suggested_stage: "Identified", open_buy_boxes: 1, emails_in_90d: 0 });

    // They wrote in, and nobody has answered: Responded, and waiting on us.
    await pg.queryPg(`insert into crm_email_messages (id, subject, sent_at, from_person_id, from_email)
      values ('m_bp_in', 'Need packs', now() - interval '1 day', 'p_bp', 'pat@bp.example')`);
    buyer = await profile.getBuyer("co_bp");
    expect(buyer.engagement).toMatchObject({ suggested_stage: "Responded", emails_in_90d: 1 });
    expect(buyer.engagement?.waiting_since).not.toBeNull();

    await pg.queryPg("update crm_companies set buyer_stage = 'Bidding' where id = 'co_bp'");
    buyer = await profile.getBuyer("co_bp");
    expect(buyer.changes.slice(0, 2).map((c) => [c.field, c.old_value, c.new_value]).toSorted()).toEqual([
      ["buyer_stage", "Contacted", "Bidding"], ["relationship_stage", "Contacted", "Active"],
    ]);
  });
});
