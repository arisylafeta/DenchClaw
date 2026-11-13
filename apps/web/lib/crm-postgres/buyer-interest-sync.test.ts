import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { partKey } from "@/lib/commercial-stock";
import { broaderKeysFor, productKeyFor } from "@/lib/match/product-key-for";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

type Line = {
  company_id: string;
  person_id: string | null;
  kind: string;
  ownership: string;
  product_key: string;
  product_key_level: string | null;
  make: string | null;
  model: string | null;
  format: string | null;
  chemistry: string | null;
  quantity: string | number | null;
  quantity_unit: string | null;
  quantity_basis: string | null;
  price: string | number | null;
  price_currency: string | null;
  price_unit: string | null;
  price_basis: string | null;
  first_seen: string;
  last_seen: string;
  expires_on: string | null;
  source_refs: string[];
  decline_reason: string | null;
  demand_id: string | null;
  offer_id: string | null;
};

describe.skipIf(!TEST_URL)("buyer interest sync", () => {
  let pg: typeof import("../postgres");
  let demand: typeof import("./bulk-demand");
  let offers: typeof import("./bulk-offers");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (value: string) => `${value}_${run}`;

  const lines = async (where: string, params: unknown[] = []) =>
    pg.queryPg<Line>(
      `select company_id, person_id, kind, ownership, product_key, product_key_level, make, model, format, chemistry,
         quantity::float8 as quantity, quantity_unit, quantity_basis, price::float8 as price,
         price_currency, price_unit, price_basis, first_seen::text, last_seen::text, expires_on::text,
         source_refs, decline_reason, demand_id, offer_id
       from buyer_interest where ${where} order by product_key, kind`,
      params);

  // Standing demand rows must state a basis (migration 061); the writers always set one.
  const withBasis = (kind: "demand" | "supply", spec: Record<string, unknown>) =>
    kind === "demand" && spec.intent === "standing" && spec.basis === undefined ? { ...spec, basis: "stated" } : spec;

  const listing = (lid: string, kind: "demand" | "supply", companyId: string | null, spec: Record<string, unknown>,
    extra: { status?: string; reason?: string | null; quantity?: string | null; context?: Record<string, unknown>; observedOn?: string } = {}) =>
    pg.queryPg<{ id: string }>(
      `insert into crm_bulk_listings (id, kind, party, company_id, summary, status, closed_reason, observed_on, quantity, spec, context)
       values ($1, $2, $3, $4, $3, $5, $6, $7, $8, $9::jsonb, $10::jsonb) returning id`,
      [lid, kind, `Party ${lid}`, companyId, extra.status ?? "open", extra.reason ?? null, extra.observedOn ?? "2026-11-01",
        extra.quantity ?? null, JSON.stringify(withBasis(kind, spec)), JSON.stringify(extra.context ?? {})]);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    demand = await import("./bulk-demand");
    offers = await import("./bulk-offers");
    for (const company of ["buyer1", "buyer2", "buyer3", "buyer4"]) {
      await pg.queryPg(`insert into crm_companies (id, name) values ($1, $1)`, [id(company)]);
    }
  });

  afterAll(async () => {
    if (!pg) {return;}
    await pg.queryPg(`delete from buyer_interest where company_id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from buyer_interest_sync_errors where source_id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_bulk_listings where id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_companies where id like $1`, [`%_${run}`]);
    await pg.pgPool.end();
  });

  it("turns an open ask into one line per product with its facts, quantity, price and needed-by date", async () => {
    await listing(id("d1"), "demand", id("buyer1"), {
      intent: "request", formats: ["Packs"], chemistries: ["LFP"], kwh_min: 50, kwh_max: 60,
      volume: 12, volume_unit: "packs", max_price: 95, price_currency: "EUR", price_unit: "kWh",
      needed_by: "2026-12-01", confirmed_on: "2026-11-02",
    }, { observedOn: "2026-11-01" });

    const rows = await lines("demand_id = $1", [id("d1")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "ask", ownership: "synced", product_key: "broad:lfp-packs", product_key_level: "broad",
      format: "pack", chemistry: "LFP", quantity: 12, quantity_unit: "packs", quantity_basis: "stated",
      price: 95, price_currency: "EUR", price_unit: "kWh", price_basis: "target",
      first_seen: "2026-11-01", last_seen: "2026-11-02", expires_on: "2026-12-01",
    });
    expect(rows[0].source_refs).toEqual([`crm:${id("d1")}`]);
  });

  it("holds one line per stated format and merges a repeat instead of duplicating", async () => {
    await listing(id("d2"), "demand", id("buyer1"), {
      intent: "standing", formats: ["Packs", "Modules"], chemistries: ["NMC"], volume: 4, volume_unit: "packs",
    });
    const before = await lines("demand_id = $1", [id("d2")]);
    expect(before.map((row) => row.product_key)).toEqual(["broad:nmc-modules", "broad:nmc-packs"]);
    await pg.queryPg(`update crm_bulk_listings set spec = spec || '{"volume": 6}'::jsonb where id = $1`, [id("d2")]);
    await pg.queryPg(`select buyer_interest_sync_demand_row($1)`, [id("d2")]);
    const after = await lines("demand_id = $1", [id("d2")]);
    expect(after).toHaveLength(2);
    expect(after.every((row) => row.quantity === 6)).toBe(true);
  });

  it("replaces the ask with bought or declined when the demand closes", async () => {
    await listing(id("d3"), "demand", id("buyer2"), {
      intent: "request", formats: ["Packs"], chemistries: ["NMC"], volume: 2, volume_unit: "packs", needed_by: "2026-12-01",
    });
    await pg.queryPg(`update crm_bulk_listings set status = 'closed', closed_reason = 'bought_from_us' where id = $1`, [id("d3")]);
    expect(await lines("demand_id = $1", [id("d3")])).toMatchObject([{ kind: "bought", expires_on: null }]);

    const other = id("d4");
    await listing(other, "demand", id("buyer2"), { intent: "request", formats: ["Packs"], chemistries: ["NMC"] });
    await pg.queryPg(`update crm_bulk_listings set status = 'closed', closed_reason = 'bought_elsewhere' where id = $1`, [other]);
    expect(await lines("demand_id = $1", [other])).toMatchObject([{ kind: "declined", decline_reason: "bought_elsewhere" }]);

    // Reopening replaces the outcome with the ask again.
    await pg.queryPg(`update crm_bulk_listings set status = 'open', closed_reason = null where id = $1`, [other]);
    expect(await lines("demand_id = $1", [other])).toMatchObject([{ kind: "ask" }]);
  });

  it("keeps an expired ask and sets its expiry rather than turning it into a decision", async () => {
    await listing(id("d5"), "demand", id("buyer3"), {
      intent: "request", formats: ["Packs"], chemistries: ["LFP"], needed_by: "2026-11-30",
    });
    await pg.queryPg(`update crm_bulk_listings set status = 'closed', closed_reason = 'expired' where id = $1`, [id("d5")]);
    const rows = await lines("demand_id = $1", [id("d5")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ask", expires_on: "2026-11-30" });
  });

  it("drops the lines for a bookkeeping close (duplicate, moved to a profile, converted to supply)", async () => {
    await listing(id("d6"), "demand", id("buyer3"), { intent: "standing", formats: ["Cells"], chemistry: "LFP" });
    expect(await lines("demand_id = $1", [id("d6")])).toHaveLength(1);
    await pg.queryPg(`update crm_bulk_listings set status = 'closed', closed_reason = 'duplicate' where id = $1`, [id("d6")]);
    expect(await lines("demand_id = $1", [id("d6")])).toEqual([]);
  });

  it("writes the same key the TypeScript builder computes", async () => {
    const spec = { intent: "standing", makes: ["Polestar"], model: "2", formats: ["Packs"], chemistries: ["NMC"], kwh_min: 78, kwh_max: 78 };
    await listing(id("d7"), "demand", id("buyer4"), spec);
    const [row] = await lines("demand_id = $1", [id("d7")]);
    const facts = { make: "Polestar", model: "2", format: "Packs", chemistry: "NMC", kwhMin: 78, kwhMax: 78 };
    expect(row.product_key).toBe(productKeyFor(facts));
    expect(row.product_key).toBe("model:polestar-2-78kwh");
    expect(row.product_key_level).toBe("model");

    // A reviewed pack family is a TS-only upgrade of a SQL line: the builder's roll-up must still contain the SQL key,
    // so filling pack keys later only ever makes a line more specific.
    const familySpec = { intent: "request", makes: ["Hyundai"], model: "Ioniq 5", formats: ["Packs"], chemistries: ["NMC"], kwh_min: 73, kwh_max: 73 };
    await listing(id("d8"), "demand", id("buyer4"), familySpec);
    const [familyRow] = await lines("demand_id = $1", [id("d8")]);
    expect(familyRow.product_key).toBe("model:hyundai-ioniq5-73kwh");
    expect(broaderKeysFor({
      make: "Hyundai", model: "Ioniq 5", format: "Packs", chemistry: "NMC", kwhMin: 73, kwhMax: 73,
    })).toContain(familyRow.product_key);

    // Aliases and accents fold the same way on both sides, so a later pack fill never rewrites a different make.
    for (const [make, model, kwh, expected] of [["VW", "e-Golf", 36, "model:volkswagen-egolf-36kwh"],
      ["Škoda", "Citigo", 36, "model:skoda-citigo-36kwh"], ["Mercedes", "EQB", 66, "model:mercedes-benz-eqb-66kwh"]] as const) {
      const lid = id(`alias_${make}`);
      await listing(lid, "demand", id("buyer4"), { intent: "standing", makes: [make], model, formats: ["Packs"], chemistries: ["NMC"], kwh_min: kwh, kwh_max: kwh });
      const [line] = await lines("demand_id = $1", [lid]);
      expect(line.product_key).toBe(expected);
      expect(productKeyFor({ make, model, format: "Packs", chemistry: "NMC", kwhMin: kwh, kwhMax: kwh })).toBe(expected);
    }
  });

  it("syncs through the app's demand writers (addDemand, closeDemand)", async () => {
    const [user] = await pg.queryPg<{ id: string }>(
      `insert into crm_users (email, display_name, password_hash)
       values ('interest-' || gen_random_uuid() || '@example.test', 'Alex', 'x') returning id`);
    const ask = await demand.addDemand({
      buyer: "App Buyer", wants: "LFP packs", kind: "request", company_id: id("buyer1"),
      spec: { formats: ["Packs"], chemistries: ["LFP"], volume: 3, volume_unit: "packs" }, needed_by: "2026-12-15",
    }, user.id);
    expect(await lines("demand_id = $1", [ask.id])).toMatchObject([{ kind: "ask", product_key: "broad:lfp-packs", quantity: 3 }]);
    await demand.closeDemand(ask.id, "bought_elsewhere");
    expect(await lines("demand_id = $1", [ask.id])).toMatchObject([{ kind: "declined", decline_reason: "bought_elsewhere" }]);
  });

  it("records a buyer offer's paid and declined stages, replacing the earlier outcome", async () => {
    await listing(id("s1"), "supply", null, { volume_unit: "packs" }, { quantity: "40 packs", observedOn: "2026-10-20" });
    await pg.queryPg(
      `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility)
       values ($1, 'make', 'Kia', 'confirmed', 'teaser'), ($1, 'model', 'Niro', 'confirmed', 'teaser'),
              ($1, 'chemistry', 'NMC', 'confirmed', 'teaser'), ($1, 'format', 'packs', 'confirmed', 'teaser'),
              ($1, 'capacity_kwh', '64', 'confirmed', 'teaser')`,
      [id("s1")]);
    await pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, name, stage, terms)
       values ($1, $2, 'counterparty', $3, 'Offer Buyer', 'paid',
         '{"amount": 4500, "currency": "EUR", "unit": "pack"}'::jsonb)`,
      [id("o1"), id("s1"), id("buyer1")]);

    const bought = await lines("offer_id = $1", [id("o1")]);
    expect(bought).toHaveLength(1);
    expect(bought[0]).toMatchObject({
      kind: "bought", ownership: "synced", product_key: "model:kia-niro-64kwh", quantity: 40, quantity_unit: "packs",
      price: 4500, price_currency: "EUR", price_unit: "pack", price_basis: "paid", first_seen: "2026-10-20",
    });
    expect(bought[0].source_refs).toEqual([`crm:${id("o1")}`, `crm:${id("s1")}`]);

    await offers.updateOffer(id("s1"), id("o1"), { stage: "declined", declinedReason: "logistics" }, null);
    const declined = await lines("offer_id = $1", [id("o1")]);
    expect(declined).toHaveLength(1);
    expect(declined[0]).toMatchObject({ kind: "declined", decline_reason: "logistics", price_basis: "bid" });

    // Back to an open stage: no outcome line any more.
    await offers.updateOffer(id("s1"), id("o1"), { stage: "negotiating" }, null);
    expect(await lines("offer_id = $1", [id("o1")])).toEqual([]);
  });

  it("ignores our own side of a listing and offers on demand listings", async () => {
    await listing(id("d9"), "demand", id("buyer2"), { intent: "request", formats: ["Packs"], chemistries: ["LFP"] });
    await listing(id("s2"), "supply", null, {});
    await pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage)
       values ($1, $2, 'contact', $3, 'paid'), ($4, $5, 'counterparty', $3, 'paid')`,
      [id("o2"), id("s2"), id("buyer2"), id("o3"), id("d9")]);
    expect(await lines("offer_id = any($1::text[]) or demand_id = $2", [[id("o2"), id("o3")], id("d9")]))
      .toMatchObject([{ kind: "ask" }]);
  });

  it("removes a line for product facts the row no longer states", async () => {
    await listing(id("d11"), "demand", id("buyer1"), { intent: "request", formats: ["Packs"], chemistries: ["LFP"] });
    expect((await lines("demand_id = $1", [id("d11")])).map((row) => row.product_key)).toEqual(["broad:lfp-packs"]);

    // LFP -> NMC: the LFP line is stale and must not survive its source fact.
    await pg.queryPg(`update crm_bulk_listings set spec = jsonb_set(spec, '{chemistries}', '["NMC"]'::jsonb) where id = $1`,
      [id("d11")]);
    expect((await lines("demand_id = $1", [id("d11")])).map((row) => row.product_key)).toEqual(["broad:nmc-packs"]);
  });

  it("fans every stated make and chemistry out into its own line", async () => {
    await listing(id("d12"), "demand", id("buyer1"), {
      intent: "request", makes: ["Toyota or Lexus", "Stellantis"], chemistries: ["NMC", "LFP"], formats: ["Packs"],
    });
    const rows = await lines("demand_id = $1", [id("d12")]);
    expect(rows.map((row) => row.product_key)).toEqual([
      "broad:stellantis-lfp-packs", "broad:stellantis-nmc-packs",
      "broad:toyota-or-lexus-lfp-packs", "broad:toyota-or-lexus-nmc-packs",
    ]);
    expect(rows.map((row) => row.chemistry)).toEqual(["LFP", "NMC", "LFP", "NMC"]);

    // Dropping a make drops its lines, keeping the other make's.
    await pg.queryPg(`update crm_bulk_listings set spec = jsonb_set(spec, '{makes}', '["Stellantis"]'::jsonb) where id = $1`,
      [id("d12")]);
    expect((await lines("demand_id = $1", [id("d12")])).map((row) => row.product_key))
      .toEqual(["broad:stellantis-lfp-packs", "broad:stellantis-nmc-packs"]);
  });

  it("caps a very broad ask at 12 lines and records the truncation", async () => {
    await listing(id("d13"), "demand", id("buyer4"), {
      intent: "request", makes: ["Toyota", "Stellantis", "Hyundai", "Kia"],
      chemistries: ["NMC", "LFP", "NCA", "LTO"], formats: ["Packs"],
    });
    expect(await lines("demand_id = $1", [id("d13")])).toHaveLength(12);
    const [error] = await pg.queryPg<{ operation: string; message: string }>(
      `select operation, message from buyer_interest_sync_errors where source_id = $1 and operation = 'truncated'`,
      [id("d13")]);
    expect(error.message).toContain("12 of 16");
  });

  it("moves a synced line to the company the source now names", async () => {
    await listing(id("d14"), "demand", id("buyer1"), { intent: "request", formats: ["Packs"], chemistries: ["LFP"] });
    await pg.queryPg(`update crm_bulk_listings set company_id = $2 where id = $1`, [id("d14"), id("buyer2")]);
    const rows = await lines("demand_id = $1", [id("d14")]);
    expect(rows).toHaveLength(1);
    expect(rows[0].company_id).toBe(id("buyer2"));
  });

  it("moves an offer line when the counterparty company changes", async () => {
    await listing(id("s3"), "supply", null, { makes: ["Kia"], formats: ["Packs"] }, { quantity: "4 packs" });
    await pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, name, stage)
       values ($1, $2, 'counterparty', $3, 'Offer Buyer', 'paid')`,
      [id("o4"), id("s3"), id("buyer1")]);
    expect((await lines("offer_id = $1", [id("o4")]))[0].company_id).toBe(id("buyer1"));
    await pg.queryPg(`update crm_bulk_offers set company_id = $2 where id = $1`, [id("o4"), id("buyer3")]);
    expect((await lines("offer_id = $1", [id("o4")]))[0].company_id).toBe(id("buyer3"));
  });

  it("records a purchase whose listing states no product instead of writing an empty bucket", async () => {
    await listing(id("s5"), "supply", null, {}, { quantity: "4 packs" });
    await pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, name, stage)
       values ($1, $2, 'counterparty', $3, 'Offer Buyer', 'paid')`,
      [id("o7"), id("s5"), id("buyer1")]);
    expect(await lines("offer_id = $1", [id("o7")])).toEqual([]);
    const notes = await pg.queryPg<{ operation: string; message: string }>(
      `select operation, message from buyer_interest_sync_errors where source_id = $1`, [id("o7")]);
    expect(notes).toHaveLength(1);
    expect(notes[0].operation).toBe("no_product_facts");
    expect(notes[0].message).toContain(id("s5"));
  });

  it("treats signed and invoiced counterparty offers as bought, and contract_out as nothing", async () => {
    await listing(id("s4"), "supply", null, { makes: ["Kia"], model: "Niro", chemistries: ["NMC"], formats: ["Packs"] });
    await pg.queryPg(
      `insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, name, stage)
       values ($1, $2, 'counterparty', $3, 'Buyer', 'contract_out'), ($4, $2, 'counterparty', $5, 'Buyer', 'signed')`,
      [id("o5"), id("s4"), id("buyer4"), id("o6"), id("buyer3")]);
    expect(await lines("offer_id = $1", [id("o5")])).toEqual([]);
    expect(await lines("offer_id = $1", [id("o6")])).toMatchObject([{ kind: "bought" }]);

    await offers.updateOffer(id("s4"), id("o6"), { stage: "invoiced" }, null);
    expect(await lines("offer_id = $1", [id("o6")])).toMatchObject([{ kind: "bought" }]);
  });

  it("removes the lines when a demand row stops being a demand", async () => {
    await listing(id("d15"), "demand", id("buyer2"), { intent: "request", formats: ["Packs"], chemistries: ["LFP"] });
    expect(await lines("demand_id = $1", [id("d15")])).toHaveLength(1);
    await pg.queryPg(`update crm_bulk_listings set kind = 'supply' where id = $1`, [id("d15")]);
    expect(await lines("demand_id = $1", [id("d15")])).toEqual([]);
  });

  it("keeps the ask, not the old decision, when a row is reopened and then expires", async () => {
    await listing(id("d16"), "demand", id("buyer2"), {
      intent: "request", formats: ["Packs"], chemistries: ["NMC"], needed_by: "2026-12-01",
    });
    await pg.queryPg(`update crm_bulk_listings set status = 'closed', closed_reason = 'bought_from_us' where id = $1`,
      [id("d16")]);
    expect(await lines("demand_id = $1", [id("d16")])).toMatchObject([{ kind: "bought" }]);

    await pg.queryPg(`update crm_bulk_listings set status = 'open', closed_reason = null where id = $1`, [id("d16")]);
    expect(await lines("demand_id = $1", [id("d16")])).toMatchObject([{ kind: "ask" }]);

    await pg.queryPg(`update crm_bulk_listings set status = 'closed', closed_reason = 'expired' where id = $1`,
      [id("d16")]);
    const rows = await lines("demand_id = $1", [id("d16")]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "ask", expires_on: "2026-12-01" });
  });

  it("never breaks the parent write when the sync fails, and logs the failure", async () => {
    // A table rename makes the sync fail exactly as a broken migration or bad data would.
    await pg.queryPg(`alter table buyer_interest rename to buyer_interest_paused_${run}`);
    try {
      const written = await listing(id("d10"), "demand", id("buyer1"), { intent: "request", formats: ["Packs"], chemistries: ["LFP"] });
      expect(written).toHaveLength(1);
      const [row] = await pg.queryPg<{ id: string }>(`select id from crm_bulk_listings where id = $1`, [id("d10")]);
      expect(row.id).toBe(id("d10"));
      const [error] = await pg.queryPg<{ source_table: string; message: string }>(
        `select source_table, message from buyer_interest_sync_errors where source_id = $1`, [id("d10")]);
      expect(error.source_table).toBe("crm_bulk_listings");
      expect(error.message).toMatch(/buyer_interest/);
    } finally {
      await pg.queryPg(`alter table buyer_interest_paused_${run} rename to buyer_interest`);
    }
  });

  describe("a listing's facts change under its offers", () => {
    const setField = (lid: string, key: string, value: string) =>
      pg.queryPg(
        `insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility)
         values ($1, $2, $3, 'confirmed', 'teaser')
         on conflict (bulk_listing_id, field_key) do update set value = excluded.value`, [lid, key, value]);

    it("moves the bought and declined lines when a mapped model or capacity field changes", async () => {
      await listing(id("lf1"), "supply", null, {});
      await pg.queryPg(`insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility)
        values ($1, 'make', 'Kia', 'confirmed', 'teaser'), ($1, 'model', 'Niro', 'confirmed', 'teaser')`, [id("lf1")]);
      await pg.queryPg(
        `insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage)
         values ($1, $3, 'counterparty', $4, 'paid'), ($2, $3, 'counterparty', $5, 'declined')`,
        [id("lfo1"), id("lfo2"), id("lf1"), id("buyer1"), id("buyer2")]);
      const keys = async () => (await lines("offer_id = any($1)", [[id("lfo1"), id("lfo2")]])).map((row) => `${row.kind}:${row.product_key}`).toSorted();
      expect(await keys()).toEqual(["bought:broad:kia-any-batteries", "declined:broad:kia-any-batteries"]);

      await setField(id("lf1"), "capacity_kwh", "64");  // insert
      expect(await keys()).toEqual(["bought:model:kia-niro-64kwh", "declined:model:kia-niro-64kwh"]);

      await setField(id("lf1"), "model", "EV6");  // update
      await setField(id("lf1"), "capacity_kwh", "77.4");
      expect(await keys()).toEqual(["bought:model:kia-ev6-77.4kwh", "declined:model:kia-ev6-77.4kwh"]);

      await pg.queryPg(`delete from crm_bulk_listing_fields where bulk_listing_id = $1 and field_key in ('model', 'capacity_kwh')`, [id("lf1")]);  // delete
      expect(await keys()).toEqual(["bought:broad:kia-any-batteries", "declined:broad:kia-any-batteries"]);
    });

    it("follows an edit of the supply listing's own spec and ignores an unrelated field", async () => {
      await listing(id("lf2"), "supply", null, { makes: ["Audi"], chemistries: ["NMC"], formats: ["Packs"] });
      await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage) values ($1, $2, 'counterparty', $3, 'paid')`,
        [id("lfo3"), id("lf2"), id("buyer1")]);
      expect((await lines("offer_id = $1", [id("lfo3")])).map((row) => row.product_key)).toEqual(["broad:audi-nmc-packs"]);
      await pg.queryPg(`update crm_bulk_listings set spec = jsonb_set(spec, '{chemistries}', '["LFP"]') where id = $1`, [id("lf2")]);
      expect((await lines("offer_id = $1", [id("lfo3")])).map((row) => row.product_key)).toEqual(["broad:audi-lfp-packs"]);
      const before = (await lines("offer_id = $1", [id("lfo3")]))[0];
      await setField(id("lf2"), "location", "Hamburg");
      expect(await lines("offer_id = $1", [id("lfo3")])).toEqual([before]);
    });

    it("resyncs a demand listing's own lines when one of its fields changes", async () => {
      await listing(id("lf3"), "demand", id("buyer3"), { intent: "request", makes: ["Audi"], formats: ["Packs"], volume: 5, volume_unit: "packs" });
      await pg.queryPg(`update buyer_interest set quantity = 99 where demand_id = $1`, [id("lf3")]);  // drift a field write must repair
      await setField(id("lf3"), "model", "Q4");
      expect((await lines("demand_id = $1", [id("lf3")]))[0].quantity).toBe(5);
    });
  });

  describe("a supply listing with no mapped product fields", () => {
    it("derives the bought line from its title, energy_kwh and trade_kind (the live Audi shape)", async () => {
      await pg.queryPg(
        `insert into crm_bulk_listings (id, kind, party, summary, status, observed_on, quantity, spec, context)
         values ($1, 'supply', 'Unknown seller', '2024 Audi MEB 82 kWh pack (12 x 8s modules), sold to Silent Classics.', 'open',
           '2026-06-16', '1 pack',
           '{"basis": "stated", "energy_kwh": 82, "trade_kind": "packs", "module_series": "8s", "quantity_unit": "packs", "observed_quantity": 1}'::jsonb,
           '{"listing_title": "2024 Audi MEB 82 kWh pack"}'::jsonb)`, [id("audi")]);
      await pg.queryPg(
        `insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage, terms)
         values ($1, $2, 'counterparty', $3, 'paid', '{"kwh": 82, "amount": 2950, "currency": "GBP", "delivered": true}'::jsonb)`,
        [id("audio"), id("audi"), id("buyer4")]);
      const rows = await lines("offer_id = $1", [id("audio")]);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "bought", make: "Audi", format: "pack", product_key: "broad:audi-any-packs", price: 2950, price_currency: "GBP",
      });
      const [facts] = await pg.queryPg<{ kwh_min: number; kwh_max: number }>(
        `select kwh_min::float8, kwh_max::float8 from buyer_interest where offer_id = $1`, [id("audio")]);
      expect(facts).toEqual({ kwh_min: 82, kwh_max: 82 });
      expect(await pg.queryPg(`select 1 from buyer_interest_sync_errors where source_id = $1`, [id("audio")])).toEqual([]);
    });

    it("never reads a lot's total energy as one pack's capacity", async () => {
      await pg.queryPg(
        `insert into crm_bulk_listings (id, kind, party, summary, status, observed_on, quantity, spec, context)
         values ($1, 'supply', 'Seller', 'Stellantis LFP batch: 24 packs', 'open', '2026-04-08', '24 packs + 42 modules',
           '{"energy_kwh": 2085.4, "trade_kind": "packs", "observed_quantity": 24}'::jsonb,
           '{"listing_title": "Stellantis Serbia LFP: 24 packs and 42 modules, as is"}'::jsonb)`, [id("lot")]);
      await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage) values ($1, $2, 'counterparty', $3, 'paid')`,
        [id("loto"), id("lot"), id("buyer4")]);
      const [row] = await lines("offer_id = $1", [id("loto")]);
      expect(row).toMatchObject({ product_key: "broad:stellantis-any-packs", make: "Stellantis", format: "pack" });
      const [kwh] = await pg.queryPg<{ kwh_min: number | null }>(`select kwh_min::float8 from buyer_interest where offer_id = $1`, [id("loto")]);
      expect(kwh.kwh_min).toBeNull();
    });

    it("lets a mapped field or a stated make win over the title", async () => {
      await pg.queryPg(
        `insert into crm_bulk_listings (id, kind, party, summary, status, observed_on, spec, context)
         values ($1, 'supply', 'Seller', 'Audi pack for Kia', 'open', '2026-06-16',
           '{"energy_kwh": 64, "trade_kind": "packs", "observed_quantity": 1, "makes": ["Kia"], "model": "Niro"}'::jsonb, '{"listing_title": "Audi pack"}'::jsonb)`, [id("title2")]);
      await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage) values ($1, $2, 'counterparty', $3, 'paid')`,
        [id("title2o"), id("title2"), id("buyer4")]);
      expect((await lines("offer_id = $1", [id("title2o")])).map((row) => row.product_key)).toEqual(["model:kia-niro-64kwh"]);
    });

    it("still records a listing whose title names no make and states nothing else", async () => {
      await pg.queryPg(
        `insert into crm_bulk_listings (id, kind, party, summary, status, observed_on, spec, context)
         values ($1, 'supply', 'Seller', 'Mixed lot, see photos', 'open', '2026-06-16', '{}'::jsonb, '{"listing_title": "Mixed lot"}'::jsonb)`, [id("title3")]);
      await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage) values ($1, $2, 'counterparty', $3, 'paid')`,
        [id("title3o"), id("title3"), id("buyer4")]);
      expect(await lines("offer_id = $1", [id("title3o")])).toEqual([]);
      expect(await pg.queryPg(`select operation from buyer_interest_sync_errors where source_id = $1`, [id("title3o")]))
        .toEqual([{ operation: "no_product_facts" }]);
    });

    it("takes the make that appears first in the title, and knows Mini", async () => {
      const make = async (title: string) =>
        (await pg.queryPg<{ make: string }>(`select buyer_interest_title_make($1) as make`, [title]))[0].make;
      expect(await make("Audi / VW lot")).toBe("Audi");
      expect(await make("VW / Audi lot")).toBe("Volkswagen");
      expect(await make("Mini Cooper SE pack")).toBe("Mini");
      expect(await make("BMW Mini lot")).toBe("BMW");
      expect(await make("Mixed lot")).toBeNull();
    });
  });

  describe("an OEM part code", () => {
    it("accepts spaced codes of up to five code-shaped tokens in either case and keeps prose out, like the TS builder", async () => {
      const cases: [string, string | null][] = [
        ["5QE 915 105 B", "5QE915105B"], ["5qe 915 105 b", "5QE915105B"], ["SU001-B5189", "SU001B5189"],
        ["37501-AO050", "37501A0050"], ["Tesla Model 3 pack", null], ["battery pack 2024", null], ["72 Ah cell", null],
        ["Onyx Strata H4-15", null], ["1 2 3 4 5 6", null], ["ID 4 77", null],
      ];
      for (const [text, expected] of cases) {
        const [row] = await pg.queryPg<{ part: string | null }>(`select buyer_interest_part($1) as part`, [text]);
        expect(row.part, text).toBe(expected);
        expect(partKey(text) || null, `TS ${text}`).toBe(expected);
      }
    });
  });

  describe("a supply listing that becomes a demand listing", () => {
    it("loses its offer-derived lines", async () => {
      await listing(id("flip"), "supply", null, { makes: ["Audi"], chemistries: ["NMC"], formats: ["Packs"] });
      await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage) values ($1, $2, 'counterparty', $3, 'paid')`,
        [id("flipo"), id("flip"), id("buyer4")]);
      expect(await lines("offer_id = $1", [id("flipo")])).toHaveLength(1);
      await pg.queryPg(`update crm_bulk_listings set kind = 'demand', spec = spec || '{"intent": "request"}'::jsonb where id = $1`, [id("flip")]);
      expect(await lines("offer_id = $1", [id("flipo")])).toEqual([]);
    });
  });

  describe("two writers on one source", () => {
    type Client = import("pg").PoolClient;
    const sleep = (ms: number) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const keysOf = async (demandId: string) => (await lines("demand_id = $1", [demandId])).map((row) => row.product_key);

    const settled = (promise: Promise<unknown>) => {
      const state = { done: false };
      void promise.then(() => { state.done = true; }, () => { state.done = true; });
      return state;
    };

    it("a backfill that starts after a live edit waits for it and writes the edit's facts", async () => {
      await listing(id("race1"), "demand", id("buyer1"), { intent: "request", formats: ["Packs"], chemistries: ["LFP"] });
      expect(await keysOf(id("race1"))).toEqual(["broad:lfp-packs"]);

      const writer: Client = await pg.pgPool.connect();
      const backfill: Client = await pg.pgPool.connect();
      try {
        await writer.query("begin");
        await writer.query(`update crm_bulk_listings set spec = jsonb_set(spec, '{chemistries}', '["NMC"]') where id = $1`, [id("race1")]);
        await backfill.query("begin");
        const sync = backfill.query(`select buyer_interest_sync_demand_row($1)`, [id("race1")]);
        const state = settled(sync);
        await sleep(300);
        expect(state.done).toBe(false);  // queued behind the writer's lock, not reading old facts
        await writer.query("commit");
        await sync;
        await backfill.query("commit");
      } finally {
        writer.release();
        backfill.release();
      }
      expect(await keysOf(id("race1"))).toEqual(["broad:nmc-packs"]);
    });

    it("a live edit that arrives while the backfill holds the source ends with the newest facts", async () => {
      await listing(id("race2"), "demand", id("buyer1"), { intent: "request", formats: ["Packs"], chemistries: ["LFP"] });

      const writer: Client = await pg.pgPool.connect();
      const backfill: Client = await pg.pgPool.connect();
      try {
        await backfill.query("begin");
        await backfill.query(`select buyer_interest_sync_demand_row($1)`, [id("race2")]);  // reads LFP and holds the lock
        const edit = writer.query(`update crm_bulk_listings set spec = jsonb_set(spec, '{chemistries}', '["NMC"]') where id = $1`, [id("race2")]);
        const state = settled(edit);
        await sleep(300);
        expect(state.done).toBe(false);  // the trigger queues behind the backfill's lock
        await backfill.query("commit");
        await edit;
      } finally {
        writer.release();
        backfill.release();
      }
      expect(await keysOf(id("race2"))).toEqual(["broad:nmc-packs"]);
    });

    it("two offers on one buyer synced from separate transactions do not deadlock", async () => {
      await listing(id("race3"), "supply", null, { makes: ["Audi"], chemistries: ["NMC"], formats: ["Packs"] });
      await pg.queryPg(`insert into crm_bulk_offers (id, bulk_listing_id, role, company_id, stage) values ($1, $2, 'counterparty', $3, 'paid'), ($4, $2, 'counterparty', $5, 'paid')`,
        [id("race3a"), id("race3"), id("buyer1"), id("race3b"), id("buyer2")]);
      const a: Client = await pg.pgPool.connect();
      const b: Client = await pg.pgPool.connect();
      try {
        await a.query("begin");
        await b.query("begin");
        await a.query(`select buyer_interest_sync_offer_row($1)`, [id("race3a")]);
        await b.query(`select buyer_interest_sync_offer_row($1)`, [id("race3b")]);
        await a.query(`select buyer_interest_sync_offer_row($1)`, [id("race3a")]);
        await Promise.all([a.query("commit"), b.query("commit")]);
      } finally {
        a.release();
        b.release();
      }
      const rows = await lines("offer_id = any($1)", [[id("race3a"), id("race3b")]]);
      expect(rows.map((row) => row.kind)).toEqual(["bought", "bought"]);
    });
  });
});
