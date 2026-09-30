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
});
