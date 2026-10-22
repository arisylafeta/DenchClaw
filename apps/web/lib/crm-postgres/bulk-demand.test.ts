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

  it.skipIf(!process.env.HISTORY_RESTORE_TEST)("lists the complete restored audit cohort without active work", async () => {
    const rows = await demand.listDemand();
    const restored = rows.filter((row) => row.note?.includes("Restored to History 18 Oct from the 16 Oct audit (was:"));
    expect(restored).toHaveLength(573);
    expect(restored.filter((row) => row.closed_reason === "research_profile")).toHaveLength(417);
    expect(restored.every((row) => row.status === "closed" && !row.priority && !row.missing.length &&
      !row.inventory_matches.length && !row.fits.length && row.score === null && row.expected_fee === null && !row.waiting)).toBe(true);
    expect(rows.filter((row) => row.status === "open")).toHaveLength(12);
    expect(rows.filter((row) => row.status === "qualifying")).toHaveLength(8);
  });

  it("round trips context and preserves it on legacy edits without changing demand facts", async () => {
    const context = { container_design_finalized: null, pilot_quantity_conflict: true,
      pilot_quantities_observed: [{ packs: 12, date: "2026-08-01", source: "Synthetic email" },
        { packs: 18, date: "2026-08-02", source: "Synthetic call" }],
      sources: [{ kind: "url", label: "Synthetic source", url: "https://example.test/context" }] };
    const row = await demand.addDemand({ buyer: "Synthetic Context Buyer", wants: "Storage packs",
      context, volume: 12, volume_unit: "packs", confirmed_on: "2026-08-01", status: "qualifying" }, user.id);
    expect(row.context).toEqual(context);
    expect((await demand.listDemand()).find((item) => item.id === row.id)?.context).toEqual(context);
    expect(await demand.updateDemand(row.id, { note: "Narrative only" })).toMatchObject({ context,
      volume: 12, confirmed_on: "2026-08-01", status: "qualifying" });
    expect(await demand.updateDemand(row.id, { context: { ...context, next_action: "Confirm count" } })).toMatchObject({
      context: { ...context, next_action: "Confirm count" }, volume: 12, confirmed_on: "2026-08-01", status: "qualifying" });
    expect((await demand.updateDemand(row.id, { context: {} }))?.context).toEqual({});
    const legacy = await demand.addDemand({ buyer: "Legacy Synthetic Buyer", wants: "Packs" }, user.id);
    expect(legacy.context).toEqual({});
    for (const invalid of ["[]", "null", "42"]) {
      await expect(pg.queryPg("update crm_bulk_demand set context = $2::jsonb where id = $1", [row.id, invalid])).rejects.toThrow();
    }
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

  it("lists closed History inertly and categorizes without reopening or confirming it", async () => {
    const row = await demand.addDemand({ buyer: "History buyer", wants: "Historical packs",
      fee_eur: 10000, price_basis: "buyer", reputation: "paid" }, user.id);
    await pg.queryPg("insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason) values ($1,$2,'strong','historical match')", [row.id, lotId]);
    await demand.closeDemand(row.id, "research_profile");
    const before = await demand.getDemand(row.id);
    expect((await demand.listDemand()).find((item) => item.id === row.id)).toMatchObject({
      status: "closed", closed_reason: "research_profile", missing: [], inventory_matches: [],
      fits: [], score: null, expected_fee: null, has_stock: false, waiting: null,
    });
    expect((await demand.suggestedBuyers(lotId)).some((item) => item.demand_id === row.id)).toBe(false);
    expect(await demand.categorizeDemand(row.id, "offer_reply")).toMatchObject({
      status: "closed", closed_reason: "offer_reply", confirmed_on: before?.confirmed_on,
    });
    // DATABASE_URL is assigned in beforeAll; static imports would initialize the production pool.
    const activity = await import("./bulk-demand-activity");
    expect((await activity.listDemandActivity(row.id)).some((item) => item.title === "Category · offer_reply")).toBe(true);
    const active = await demand.addDemand({ buyer: "Not history", wants: "Live packs" }, user.id);
    expect(await demand.categorizeDemand(active.id, "duplicate")).toBeNull();
    expect((await demand.getDemand(active.id))?.status).toBe("open");
  });

  it("ranks priority inside its score and status bands and computes missing qualification and matches", async () => {
    const pinned = await demand.addDemand({ buyer: "Priority Buyer", wants: "Toyota packs", priority: true,
      fee_eur: 1, qualify_question: "When do you need these?" }, user.id);
    const scored = await demand.addDemand({ buyer: "Scored Buyer", wants: "Toyota packs", fee_eur: 2,
      price_basis: "buyer", reputation: "paid" }, user.id);
    const qualifying = await demand.addDemand({ buyer: "Qualifying Priority", wants: "Toyota packs",
      status: "qualifying", priority: true }, user.id);
    const hot = await demand.addDemand({ buyer: "Hot Buyer", wants: "Toyota packs", fee_eur: 10000,
      price_basis: "buyer", reputation: "paid" }, user.id);
    expect(pinned.missing).toEqual(["no price", "no quantity", "question not sent", "no supply match"]);
    const ordered = (await demand.listDemand()).map((row) => row.id);
    expect(ordered.indexOf(hot.id)).toBeLessThan(ordered.indexOf(pinned.id));
    expect(ordered.indexOf(pinned.id)).toBeLessThan(ordered.indexOf(scored.id));
    expect(ordered.indexOf(scored.id)).toBeLessThan(ordered.indexOf(qualifying.id));
    const qualificationLot = await trades.createBulkTrade({ title: "Qualification-only Toyota lot" }, user.id);
    await pg.queryPg(`insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason)
      values ($1, $2, 'strong', 'Exact Toyota pack family')`, [pinned.id, qualificationLot.id]);
    const complete = await demand.updateDemand(pinned.id, { kind: "request", basis: null, quantity: "10 packs", max_price: 1000,
      price_currency: "EUR", price_unit: "pack", needed_by: "2027-01-01", qualify_asked_on: "2026-10-16" });
    expect(complete?.missing).toEqual([]);
    expect(complete?.inventory_matches).toMatchObject([{ id: qualificationLot.id, kind: "supply", strength: "strong" }]);
    await pg.queryPg("update crm_bulk_trade_demand_matches set hidden = true where demand_id = $1", [pinned.id]);
    expect((await demand.getDemand(pinned.id))?.missing).toEqual(["no supply match"]);
  });

  it("only requests need a date, and supply gaps follow the same auction eligibility as inventory", async () => {
    const row = await demand.addDemand({ buyer: "Auction Eligibility Buyer", wants: "Battery packs" }, user.id);
    expect(row.missing).not.toContain("no timeline");
    expect((await demand.updateDemand(row.id, { kind: "request", basis: null }))?.missing).toContain("no timeline");
    const auction = await trades.createBulkTrade({ title: "Eligibility-only auction" }, user.id);
    await pg.queryPg(`update crm_bulk_trade_lots set auction_id = gen_random_uuid(), auction_status = 'withdrawn',
      auction_closes_at = '2099-01-01' where id = $1`, [auction.id]);
    await pg.queryPg(`insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason)
      values ($1, $2, 'strong', 'Exact family')`, [row.id, auction.id]);
    const withdrawn = await demand.getDemand(row.id);
    expect(withdrawn?.inventory_matches).toEqual([]);
    expect(withdrawn?.missing).toContain("no supply match");
    await pg.queryPg("update crm_bulk_trade_lots set auction_status = 'published' where id = $1", [auction.id]);
    const live = await demand.getDemand(row.id);
    expect(live?.inventory_matches).toMatchObject([{ id: auction.id, kind: "auction" }]);
    expect(live?.missing).not.toContain("no supply match");
    await pg.queryPg("update crm_bulk_trade_lots set auction_closes_at = '2000-01-01' where id = $1", [auction.id]);
    const expired = await demand.getDemand(row.id);
    expect(expired?.inventory_matches).toEqual([]);
    expect(expired?.missing).toContain("no supply match");
  });

  it("records activity, scopes deletion, counts it and stamps qualifying entries across writers", async () => {
    // Load after DATABASE_URL is set: the Postgres pool is configured at module initialization.
    const activity = await import("./bulk-demand-activity");
    const row = await demand.addDemand({ buyer: "Activity Buyer", wants: "Leaf packs", status: "qualifying" }, user.id);
    expect(row.qualify_entered_on).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(row.qualify_asked_on).toBeNull();
    expect(row.activity_count).toBe(1);
    const entry = await activity.addDemandActivity({ demandId: row.id, kind: "research", title: "  Found supplier  ",
      body: "Checked stock", refKind: "url", refId: "https://supplier.test", data: { units: 12 }, actorUserId: user.id });
    expect(entry).toMatchObject({ title: "Found supplier", kind: "research", actor_user_id: user.id, data: { units: 12 } });
    expect((await activity.listDemandActivity(row.id))[0].id).toBe(entry.id);
    expect(await demand.getDemand(row.id)).toMatchObject({ activity_count: 2, last_activity_at: entry.occurred_at });
    expect(await activity.deleteDemandActivity("btd_other", entry.id)).toBe(false);
    expect(await activity.deleteDemandActivity(row.id, entry.id)).toBe(true);
    await expect(activity.addDemandActivity({ demandId: row.id, kind: "note", title: " " })).rejects.toThrow();
    await demand.updateDemand(row.id, { qualify_asked_on: "2026-10-01" });
    await demand.confirmDemand(row.id);
    await demand.confirmDemand(row.id);
    await demand.closeDemand(row.id, "bought_elsewhere");
    await demand.updateDemand(row.id, { status: "qualifying" });
    expect(await demand.getDemand(row.id)).toMatchObject({ status: "qualifying", qualify_asked_on: null });
    expect((await activity.listDemandActivity(row.id)).map((a) => a.title)).toContain("Still wanted");
    await pg.queryPg("delete from crm_bulk_demand where id = $1", [row.id]);
    expect(await activity.listDemandActivity(row.id)).toEqual([]);
  });

  it("invalidates matching when qualifying and when reopening through edits or confirmation", async () => {
    const row = await demand.addDemand({ buyer: "Reconfirm Buyer", wants: "Leaf packs", status: "open" }, user.id);
    const seed = () => pg.queryPg("update crm_bulk_demand set match_hash = 'matched', supply_match_hash = 'matched' where id = $1", [row.id]);
    const hashes = async () => (await pg.queryPg("select match_hash, supply_match_hash from crm_bulk_demand where id = $1", [row.id]))[0];
    await seed();
    await demand.updateDemand(row.id, { status: "qualifying" });
    expect(await hashes()).toEqual({ match_hash: null, supply_match_hash: null });
    await seed();
    await demand.updateDemand(row.id, { status: "open" });
    expect(await hashes()).toEqual({ match_hash: null, supply_match_hash: null });
    await demand.updateDemand(row.id, { status: "qualifying" });
    await seed();
    expect(await demand.confirmDemand(row.id)).toMatchObject({ status: "open" });
    expect(await hashes()).toEqual({ match_hash: null, supply_match_hash: null });
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
    expect(row).toMatchObject({ status: "qualifying", product_family: null, wants: "LFP packs, no pouch", location: "Romania", confirmed_on: "2026-08-17",
      source_label: "Gmail · dawid@revoxa.example", source_quote: "We are looking for LFP packs" });

    const update = await insert({ buyer: "Revoxa buyer", wants: "LFP packs and blade cells", demand_id: row.id }, row.id);
    await proposals.decideProposal(update, "accept", user);
    expect(await demand.getDemand(row.id)).toMatchObject({ status: "qualifying", wants: "LFP packs and blade cells", location: "Romania" });
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
    await expect(pg.queryPg("update crm_bulk_demand set kind = 'request' where id = $1", [estimate.id])).rejects.toThrow();
    await expect(pg.queryPg("update crm_bulk_demand set needed_by = '2026-12-01' where id = $1", [estimate.id])).rejects.toThrow();
    await expect(pg.queryPg("update crm_bulk_demand set volume = 5 where id = $1", [estimate.id])).rejects.toThrow(); // no unit
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
    await pg.queryPg("update crm_bulk_demand set company_id = 'co_tier_a' where id = $1", [estimated.id]);
    const ranked = await demand.suggestedBuyers(lot);
    expect(ranked.map((s) => [s.buyer, s.tier])[0]).toEqual(["Estimated Co", "A"]);
    expect((await demand.getDemand(estimated.id))?.tier).toBe("A");

    const buyer = await demand.addSuggestedBuyer(lot, agreed.id, user.id);
    const [{ demand_id }] = await pg.queryPg<{ demand_id: string }>("select demand_id from crm_bulk_trade_buyers where id = $1", [buyer!.id]);
    expect(demand_id).toBe(agreed.id);
    // The suggested buyer is also a Trades Preview offer naming the demand, which is what a demand's trades read.
    expect((await demand.getDemand(agreed.id))?.trades).toEqual([{ lot_id: lot, title: "Ranking trade LFP packs", status: "To contact" }]);
  });

  it("offers the trade to buyers we deal with first and lists new estimated-only buyers to introduce", async () => {
    const lot = (await trades.createBulkTrade({ title: "Groups trade LFP cells", trade_kind: "cells", trade_stage: "With buyers" }, user.id)).id;
    await pg.queryPg(`insert into crm_companies (id, name, purpose, relationship_stage, buyer_tier) values
      ('co_grp_new', 'New Guess Co', '{Buyer}', 'New', null), ('co_grp_engaged', 'Engaged Guess Co', '{Buyer}', 'Engaged', null),
      ('co_grp_tier', 'Tiered New Co', '{Buyer}', 'New', 'B'), ('co_grp_stated', 'New Stated Co', '{Buyer}', 'New', null)`);
    const add = (buyer: string, company_id: string, basis: "estimated" | "stated") =>
      demand.addDemand({ buyer, company_id, wants: "LFP cells", basis }, user.id);
    for (const row of [await add("New Guess Co", "co_grp_new", "estimated"), await add("Engaged Guess Co", "co_grp_engaged", "estimated"),
      await add("Tiered New Co", "co_grp_tier", "estimated"), await add("New Stated Co", "co_grp_stated", "stated")]) {
      await pg.queryPg("insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason) values ($1, $2, 'strong', 'fits')",
        [row.id, lot]);
    }
    expect((await demand.suggestedBuyers(lot)).map((s) => [s.buyer, s.group, s.stage])).toEqual([
      ["Tiered New Co", "offer", "New"], ["New Stated Co", "offer", "New"], ["Engaged Guess Co", "offer", "Engaged"],
      ["New Guess Co", "introduce", "New"],
    ]);
  });

  it("shows each buyer once, with their best row first and the rest under more, and hides the whole buyer", async () => {
    const lot = (await trades.createBulkTrade({ title: "Grouping trade NMC packs", trade_kind: "packs", trade_stage: "With buyers" }, user.id)).id;
    await pg.queryPg(`insert into crm_companies (id, name, buyer_tier) values ('co_group', 'Group Energy', 'B') on conflict do nothing`);
    const add = (wants: string, extra: object = {}) => demand.addDemand({ buyer: "Group Energy", company_id: "co_group", wants, ...extra }, user.id);
    const partial = await add("NMC modules");
    const strong = await add("NMC packs for storage");
    const request = await add("40 NMC packs by December", { kind: "request", needed_by: "2099-12-01" });
    const solo = await demand.addDemand({ buyer: "Solo Buyer", wants: "Any EV packs" }, user.id);
    const match = (row: { id: string }, strength: string) => pg.queryPg(
      "insert into crm_bulk_trade_demand_matches (demand_id, lot_id, strength, reason) values ($1, $2, $3, 'fits')", [row.id, lot, strength]);
    await match(partial, "partial");
    await match(strong, "strong");
    await match(request, "strong");
    await match(solo, "partial");

    const lines = await demand.suggestedBuyers(lot);
    expect(lines.map((line) => [line.buyer, line.demand_id])).toEqual([["Group Energy", request.id], ["Solo Buyer", solo.id]]);
    expect(lines[0].more.map((other) => [other.demand_id, other.strength])).toEqual([[strong.id, "strong"], [partial.id, "partial"]]);

    expect(await demand.hideSuggestion(lot, request.id)).toBe(true);
    expect((await demand.suggestedBuyers(lot)).map((line) => line.buyer)).toEqual(["Solo Buyer"]);
  });

  it("carries a possible-demand card's kind, date, volume and spec, and drops what fails the checks", async () => {
    const [card] = await pg.queryPg<{ id: string }>(
      `insert into crm_bulk_trade_proposals (lot_id, kind, target, proposed, summary, quote, source_kind, source_id, source_label, source_at)
       values (null, 'possible_demand', null, $1, 'Needs cells', 'We need 1,000 cells', 'granola', gen_random_uuid()::text, 'Call', '2026-09-29')
       returning id::text as id`,
      [JSON.stringify({ buyer: "Rahul's buyer", wants: "1,000 LFP cells in three weeks", kind: "request", needed_by: "2026-10-20",
        volume: 1000, volume_unit: "cells", spec: { chemistries: ["LFP", "Unobtainium"], formats: ["Cells"] } })],
    );
    expect(await proposals.decideProposal(card.id, "accept", user)).toMatchObject({ ok: true });
    const [row] = (await demand.listDemand()).filter((d) => d.buyer === "Rahul's buyer");
    expect(row).toMatchObject({ status: "qualifying", product_family: null, kind: "request", basis: null, needed_by: "2026-10-20", volume: 1000, volume_unit: "cells",
      spec: { chemistries: ["LFP"], formats: ["Cells"] }, source_kind: "call", observed_on: "2026-09-29" });
  });
  it("marks a buyer waiting on our reply until either founder writes back", async () => {
    await pg.queryPg(`insert into crm_people (id, full_name, email) values ('p_jc', 'Jonathan Cogman', 'jc@ce.example') on conflict do nothing`);
    const row = await demand.addDemand({ buyer: "Connected Energy", person_id: "p_jc", wants: "600+ packs of one type" }, user.id);
    expect(row.waiting).toBeNull();
    await pg.queryPg(`insert into mail_message (direction,transport,purpose,crm_visible,state,id, subject, sent_at, from_person_id, from_email) values ('inbound','gmail',null,true,'received','m_jc_in', 'Continuity of supply', now() - interval '2 days', 'p_jc', 'jc@ce.example')`);
    expect((await demand.getDemand(row.id))?.waiting).toMatchObject({ who: "Jonathan Cogman", subject: "Continuity of supply" });
    await pg.queryPg(`insert into mail_message (direction,transport,purpose,crm_visible,state,id, subject, sent_at, from_email) values ('inbound','gmail',null,true,'received','m_jc_out', 'Re: Continuity', now(), 'ari@rebattery.io');
      insert into mail_message_recipient (message_id, person_id, recipient_type) values ('m_jc_out', 'p_jc', 'to')`);
    expect((await demand.getDemand(row.id))?.waiting).toBeNull();
  });
});
