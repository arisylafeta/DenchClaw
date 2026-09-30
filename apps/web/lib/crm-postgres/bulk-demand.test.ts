import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../gmail-drafts", () => ({ fetchGmailAttachment: vi.fn() }));
vi.mock("../history-pass", () => ({ startHistoryPass: vi.fn(() => true) }));

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("buyer demand", () => {
  let pg: typeof import("../postgres");
  let trades: typeof import("./bulk-trades");
  let demand: typeof import("./bulk-demand");
  let proposals: typeof import("./bulk-trade-proposals");
  let user: { id: string; email: string };
  let lotId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    trades = await import("./bulk-trades");
    demand = await import("./bulk-demand");
    proposals = await import("./bulk-trade-proposals");
    const [row] = await pg.queryPg<{ id: string; email: string }>(
      `insert into crm_users (email, display_name, password_hash)
       values ('demand-' || gen_random_uuid() || '@example.test', 'Alex', 'x') returning id, email`,
    );
    user = row;
    lotId = (await trades.createBulkTrade({ title: "Demand trade eBS69", trade_kind: "packs", trade_stage: "With buyers" }, user.id)).id;
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  it("adds, edits, confirms and closes demand", async () => {
    const row = await demand.addDemand({ buyer: "Green Voltage", wants: "Matched packs in repeat batches", confirmed_on: "2026-05-01" }, user.id);
    expect(row).toMatchObject({ status: "open", confirmed_on: "2026-05-01", fits: [] });

    expect((await demand.updateDemand(row.id, { quantity: "MWh a year" }))?.quantity).toBe("MWh a year");
    const confirmed = await demand.confirmDemand(row.id);
    expect(confirmed?.confirmed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(confirmed?.confirmed_on).not.toBe("2026-05-01");

    expect(await demand.closeDemand(row.id, "bought_elsewhere")).toMatchObject({ status: "closed", closed_reason: "bought_elsewhere" });
    expect(await demand.confirmDemand(row.id)).toMatchObject({ status: "open", closed_reason: null });
    expect(await demand.updateDemand("btd_missing", { note: "x" })).toBeNull();
  });

  it("suggests matched open demand, adds it as a buyer once, and keeps Not a fit hidden", async () => {
    const nolden = await demand.addDemand({ buyer: "H. Nolden Investment", contact: "Markus", email: "markus@nolden.example", wants: "Tested EV packs 50 kWh+" }, user.id);
    const other = await demand.addDemand({ buyer: "Somerset EV", wants: "MEB modules" }, user.id);
    await pg.queryPg(
      `insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason) values ($1, $3, 'strong', 'Homogeneous 69.3 kWh lot'),
       ($2, $3, 'partial', 'Packs, not modules')`,
      [nolden.id, other.id, lotId],
    );
    expect((await demand.suggestedBuyers(lotId)).map((s) => [s.buyer, s.strength])).toEqual([
      ["H. Nolden Investment", "strong"], ["Somerset EV", "partial"],
    ]);
    expect((await demand.getDemand(nolden.id))?.fits).toMatchObject([{ lot_id: lotId, strength: "strong", buyer_id: null }]);

    const buyer = await demand.addSuggestedBuyer(lotId, nolden.id, user.id);
    expect(buyer).toMatchObject({ name: "H. Nolden Investment", status: "To contact", wants: "Tested EV packs 50 kWh+", contact: "Markus · markus@nolden.example" });
    expect(await demand.hideSuggestion(lotId, other.id)).toBe(true);
    expect(await demand.suggestedBuyers(lotId)).toEqual([]);
    expect((await demand.getDemand(nolden.id))?.fits[0].buyer_id).toBe(buyer!.id);
  });

  it("turns a possible-demand card into a new row, or updates the buyer's open row", async () => {
    const insert = async (proposed: object, target: string | null = null) => {
      const [row] = await pg.queryPg<{ id: string }>(
        `insert into crm_bulk_trade_proposals (lot_id, kind, target, proposed, summary, quote, source_kind, source_id, source_label, source_url, source_at)
         values (null, 'possible_demand', $1, $2, 'Wants packs', 'We are looking for LFP packs', 'gmail', gen_random_uuid()::text,
           'Gmail · dawid@revoxa.example', 'https://mail.example/t/1', '2026-08-17') returning id::text as id`,
        [target, JSON.stringify(proposed)],
      );
      return row.id;
    };
    const first = await insert({ buyer: "Revoxa buyer", email: "dawid@revoxa.example", wants: "LFP packs, no pouch", quantity: "Large", location: "Romania" });
    expect(await proposals.decideProposal(first, "accept", user)).toEqual({ ok: true, lot_id: null });
    const [row] = (await demand.listDemand()).filter((d) => d.buyer === "Revoxa buyer");
    expect(row).toMatchObject({ wants: "LFP packs, no pouch", location: "Romania", confirmed_on: "2026-08-17",
      source_label: "Gmail · dawid@revoxa.example", source_quote: "We are looking for LFP packs" });

    const update = await insert({ buyer: "Revoxa buyer", wants: "LFP packs and blade cells", demand_id: row.id }, row.id);
    await proposals.decideProposal(update, "accept", user);
    expect(await demand.getDemand(row.id)).toMatchObject({ wants: "LFP packs and blade cells", location: "Romania" });
    expect((await demand.possibleDemand()).map((p) => p.id)).not.toContain(update);
  });
  it("keeps requests and standing buy-boxes apart, moves a buy-box through its bases, and makes a request standing", async () => {
    const request = await demand.addDemand({
      kind: "request", buyer: "Exigo Recycling", wants: "CATL prismatic cells, urgent", needed_by: "2026-10-21",
      volume: 10000, volume_unit: "cells", max_price: 30, price_currency: "EUR", price_unit: "kWh",
      spec: { chemistries: ["LFP"], formats: ["Cells"], cell_makers: ["CATL"] },
    }, user.id, { source_kind: "email" });
    expect(request).toMatchObject({ kind: "request", basis: null, needed_by: "2026-10-21", volume: 10000, volume_unit: "cells",
      max_price: 30, spec: { chemistries: ["LFP"], formats: ["Cells"], cell_makers: ["CATL"] }, source_kind: "email", trades: [] });

    const estimate = await demand.addDemand({ buyer: "Gridturn", wants: "Second-life EV modules for cabinets", basis: "estimated" }, user.id,
      { source_kind: "research", source_id: "gridturn-2026-09" });
    // Our own estimate is not a confirmation from the buyer.
    expect(estimate).toMatchObject({ kind: "standing", basis: "estimated", confirmed_on: null });
    expect(estimate.observed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // One row per source, however often it is imported.
    await expect(demand.addDemand({ buyer: "Gridturn", wants: "Again", basis: "estimated" }, user.id,
      { source_kind: "research", source_id: "gridturn-2026-09" })).rejects.toThrow();

    expect(await demand.setBasis(estimate.id, "agreed")).toMatchObject({ basis: "agreed" });
    expect((await demand.getDemand(estimate.id))?.confirmed_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await demand.setBasis(request.id, "agreed")).toBeNull(); // requests have no basis

    const standing = await demand.makeStanding(request.id);
    expect(standing).toMatchObject({ kind: "standing", basis: "stated", needed_by: null, volume: 10000 });
    expect(await demand.makeStanding(request.id)).toBeNull();

    // The database refuses a request with a basis and a standing row with a date.
    await expect(pg.queryPg("update crm_bulk_trade_demand set kind = 'request' where id = $1", [estimate.id])).rejects.toThrow();
    await expect(pg.queryPg("update crm_bulk_trade_demand set needed_by = '2026-12-01' where id = $1", [estimate.id])).rejects.toThrow();
    await expect(pg.queryPg("update crm_bulk_trade_demand set volume = 5 where id = $1", [estimate.id])).rejects.toThrow(); // no unit
  });

  it("ranks suggestions requests first, then agreed, stated and estimated, drops past requests, and links the buyer", async () => {
    const lot = (await trades.createBulkTrade({ title: "Ranking trade LFP packs", trade_kind: "packs", trade_stage: "With buyers" }, user.id)).id;
    const add = (buyer: string, extra: object) => demand.addDemand({ buyer, wants: "LFP packs", ...extra }, user.id);
    const estimated = await add("Estimated Co", { basis: "estimated" });
    const stated = await add("Stated Co", { basis: "stated" });
    const agreed = await add("Agreed Co", { basis: "agreed" });
    const live = await add("Live Request Co", { kind: "request", needed_by: "2099-01-01" });
    const past = await add("Past Request Co", { kind: "request", needed_by: "2020-01-01" });
    for (const row of [estimated, stated, agreed, live, past]) {
      await pg.queryPg("insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason) values ($1, $2, $3, 'fits')",
        [row.id, lot, row === stated ? "strong" : "partial"]);
    }
    expect((await demand.suggestedBuyers(lot)).map((s) => [s.buyer, s.kind, s.basis])).toEqual([
      ["Live Request Co", "request", null], ["Agreed Co", "standing", "agreed"], ["Stated Co", "standing", "stated"],
      ["Estimated Co", "standing", "estimated"],
    ]);

    // A tier-A buyer outranks everything else, whatever the kind of its row.
    await pg.queryPg(`insert into crm_companies (id, name, buyer_tier) values ('co_tier_a', 'Tier A Co', 'A') on conflict do nothing`);
    await pg.queryPg("update crm_bulk_trade_demand set company_id = 'co_tier_a' where id = $1", [estimated.id]);
    const ranked = await demand.suggestedBuyers(lot);
    expect(ranked.map((s) => [s.buyer, s.tier])[0]).toEqual(["Estimated Co", "A"]);
    expect((await demand.getDemand(estimated.id))?.tier).toBe("A");

    const buyer = await demand.addSuggestedBuyer(lot, agreed.id, user.id);
    const [{ demand_id }] = await pg.queryPg<{ demand_id: string }>("select demand_id from crm_bulk_trade_buyers where id = $1", [buyer!.id]);
    expect(demand_id).toBe(agreed.id);
    expect((await demand.getDemand(agreed.id))?.trades).toEqual([{ lot_id: lot, title: "Ranking trade LFP packs", status: "To contact" }]);
  });

  it("carries a possible-demand card's kind, date, volume and spec, and drops what fails the checks", async () => {
    const [card] = await pg.queryPg<{ id: string }>(
      `insert into crm_bulk_trade_proposals (lot_id, kind, target, proposed, summary, quote, source_kind, source_id, source_label, source_at)
       values (null, 'possible_demand', null, $1, 'Needs cells', 'We need 1,000 cells', 'granola', gen_random_uuid()::text, 'Call', '2026-09-29')
       returning id::text as id`,
      [JSON.stringify({ buyer: "Rahul's buyer", wants: "1,000 LFP cells in three weeks", kind: "request", needed_by: "2026-10-20",
        volume: 1000, volume_unit: "cells", spec: { chemistries: ["LFP", "Unobtainium"], formats: ["Cells"] } })],
    );
    await proposals.decideProposal(card.id, "accept", user);
    const [row] = (await demand.listDemand()).filter((d) => d.buyer === "Rahul's buyer");
    expect(row).toMatchObject({ kind: "request", basis: null, needed_by: "2026-10-20", volume: 1000, volume_unit: "cells",
      spec: { chemistries: ["LFP"], formats: ["Cells"] }, source_kind: "call", observed_on: "2026-09-29" });
  });
  it("marks a buyer waiting on our reply until either founder writes back", async () => {
    await pg.queryPg(`insert into crm_people (id, full_name, email) values ('p_jc', 'Jonathan Cogman', 'jc@ce.example') on conflict do nothing`);
    const row = await demand.addDemand({ buyer: "Connected Energy", person_id: "p_jc", wants: "600+ packs of one type" }, user.id);
    expect(row.waiting).toBeNull();
    await pg.queryPg(`insert into crm_email_messages (id, subject, sent_at, from_person_id, from_email)
      values ('m_jc_in', 'Continuity of supply', now() - interval '2 days', 'p_jc', 'jc@ce.example')`);
    expect((await demand.getDemand(row.id))?.waiting).toMatchObject({ who: "Jonathan Cogman", subject: "Continuity of supply" });
    await pg.queryPg(`insert into crm_email_messages (id, subject, sent_at, from_email) values ('m_jc_out', 'Re: Continuity', now(), 'ari@rebattery.io');
      insert into crm_email_message_recipients (message_id, person_id, recipient_type) values ('m_jc_out', 'p_jc', 'to')`);
    expect((await demand.getDemand(row.id))?.waiting).toBeNull();
  });
});
