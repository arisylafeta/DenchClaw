import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;
const TODAY = "2026-11-12";

describe.skipIf(!TEST_URL)("buyer interest wants api", () => {
  let pg: typeof import("../postgres");
  let interests: typeof import("./buyer-interest");
  const run = Math.random().toString(36).slice(2, 8);
  const id = (value: string) => `${value}_${run}`;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    interests = await import("./buyer-interest");
    for (const company of ["co1", "co2"]) {
      await pg.queryPg(`insert into crm_companies (id, name) values ($1, $1)`, [id(company)]);
    }
    await pg.queryPg(`insert into crm_people (id, full_name, company_id) values ($1, 'Buyer One', $2)`, [id("p1"), id("co1")]);
    await pg.queryPg(`insert into crm_people (id, full_name, company_id) values ($1, 'Other Co', $2)`, [id("p2"), id("co2")]);
  });

  afterAll(async () => {
    if (!pg) {return;}
    await pg.queryPg(`delete from buyer_interest where company_id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_bulk_listings where id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_people where id like $1`, [`%_${run}`]);
    await pg.queryPg(`delete from crm_companies where id like $1`, [`%_${run}`]);
    await pg.pgPool.end();
  });

  it("adds a standing want with its key, dates and expiry", async () => {
    const line = await interests.createBuyerInterest(id("co1"), {
      kind: "standing", chemistry: "LFP", format: "pack", quantity: 12, quantity_unit: "packs",
      price: 95, price_currency: "EUR", price_unit: "kWh",
    }, TODAY);
    expect(line).toMatchObject({
      kind: "standing", ownership: "mastered", product_key: "broad:lfp-packs", product_key_level: "broad",
      chemistry: "LFP", format: "pack", quantity: 12, quantity_unit: "packs", quantity_basis: "stated",
      price: 95, price_currency: "EUR", price_unit: "kWh", price_basis: "target",
      first_seen: TODAY, last_seen: TODAY, expires_on: "2027-02-10", expired: false,
    });
    expect(line.label).toBe("packs, LFP");
  });

  it("merges a repeated want instead of duplicating it", async () => {
    const first = await interests.createBuyerInterest(id("co1"), { kind: "standing", chemistry: "LFP", format: "pack" }, TODAY);
    const again = await interests.createBuyerInterest(id("co1"), {
      kind: "standing", chemistry: "LFP", format: "pack", kwh_min: 50, kwh_max: 50, quantity: 3, quantity_unit: "packs",
    }, "2026-11-20");
    expect(again.id).toBe(first.id);
    expect(again).toMatchObject({ kwh_min: 50, kwh_max: 50, quantity: 3, last_seen: "2026-11-20", first_seen: TODAY });
    const all = (await interests.listBuyerInterests(id("co1"), TODAY)).filter((line) => line.product_key === "broad:lfp-packs");
    expect(all).toHaveLength(1);
  });

  it("keys a want by part number, model and inferred kind, with the kind's own expiry", async () => {
    const byPart = await interests.createBuyerInterest(id("co2"), { kind: "interest", part_numbers: ["SU001-B5189"] }, TODAY);
    expect(byPart.product_key).toBe("part:SU001B5189");
    expect(byPart.expires_on).toBe("2027-05-11");
    const byModel = await interests.createBuyerInterest(id("co2"), {
      kind: "inferred", make: "Polestar", model: "2", kwh: 78, format: "packs", chemistry: "NMC",
    }, TODAY);
    expect(byModel.product_key).toBe("model:polestar-2-78kwh");
  });

  it("refuses a want that names no product, a person from another company and a mismatched quantity", async () => {
    await expect(interests.createBuyerInterest(id("co1"), { kind: "standing" }, TODAY))
      .rejects.toThrow(/State the product/);
    await expect(interests.createBuyerInterest(id("co1"), { kind: "standing", chemistry: "LFP", person_id: id("p2") }, TODAY))
      .rejects.toThrow(/not at this company/);
    await expect(interests.createBuyerInterest(id("co1"), { kind: "standing", chemistry: "LFP", quantity: 4 }, TODAY))
      .rejects.toThrow(/quantity and its unit/);
    await expect(interests.createBuyerInterest(id("co1"), { kind: "ask", chemistry: "LFP" }, TODAY))
      .rejects.toThrow(/synced from its source/);
  });

  it("edits a want, moving its key only when the facts change", async () => {
    const created = await interests.createBuyerInterest(id("co1"), { kind: "interest", chemistry: "NMC", format: "pack" }, TODAY);
    const quantityOnly = await interests.updateBuyerInterest(id("co1"), created.id, { quantity: 8, quantity_unit: "packs" }, TODAY);
    expect(quantityOnly).toMatchObject({ product_key: created.product_key, quantity: 8 });

    const refact = await interests.updateBuyerInterest(id("co1"), created.id, { make: "Kia", model: "Niro", kwh: 64.8 }, TODAY);
    expect(refact?.product_key).toBe("pack:kia-niro-64kwh");
    expect(refact?.product_key_level).toBe("pack");

    // A field left out keeps its value: editing the quantity must not clear the vehicle.
    const kept = await interests.updateBuyerInterest(id("co1"), created.id, { quantity: 9 }, TODAY);
    expect(kept).toMatchObject({ make: "Kia", model: "Niro", quantity: 9, product_key: "pack:kia-niro-64kwh" });
  });

  it("expires a want, keeping it in the list as history", async () => {
    const created = await interests.createBuyerInterest(id("co1"), { kind: "interest", chemistry: "LCA", format: "cells" }, TODAY);
    const expired = await interests.expireBuyerInterest(id("co1"), created.id, "2026-12-01");
    expect(expired).toMatchObject({ expires_on: "2026-12-01", expired: true });
    const listed = (await interests.listBuyerInterests(id("co1"), "2026-12-02")).find((line) => line.id === created.id);
    expect(listed?.expired).toBe(true);
    // Live lines sort before expired ones.
    const order = await interests.listBuyerInterests(id("co1"), "2026-12-02");
    expect(order.every((line, index) => index === 0 || !order[index - 1].expired || line.expired)).toBe(true);
  });

  it("returns synced lines read-only, with a link to their source", async () => {
    await pg.queryPg(
      `insert into crm_bulk_listings (id, kind, party, company_id, summary, status, observed_on, spec)
       values ($1, 'demand', 'Sync Buyer', $2, 'LFP packs', 'open', $3, '{"intent":"request","formats":["Packs"],"chemistries":["LFP"]}'::jsonb)`,
      [id("d1"), id("co1"), TODAY]);
    const listed = await interests.listBuyerInterests(id("co1"), TODAY);
    const ask = listed.find((line) => line.demand_id === id("d1"));
    expect(ask).toMatchObject({ kind: "ask", ownership: "synced", kind_label: "Ask", source: { label: "Demand" } });
    expect(ask?.source?.href).toBe(`/?path=bulk_trade&demand=${id("d1")}`);

    await expect(interests.updateBuyerInterest(id("co1"), ask!.id, { quantity: 2 }, TODAY))
      .rejects.toThrow(/synced from its source/);
    await expect(interests.expireBuyerInterest(id("co1"), ask!.id, TODAY))
      .rejects.toThrow(/synced from its source/);
  });

  it("does not reach another company's lines", async () => {
    const co2 = await interests.createBuyerInterest(id("co2"), { kind: "standing", chemistry: "LCO", format: "pack" }, TODAY);
    expect(await interests.updateBuyerInterest(id("co1"), co2.id, { quantity: 1 }, TODAY)).toBeNull();
    expect(await interests.expireBuyerInterest(id("co1"), co2.id, TODAY)).toBeNull();
    expect((await interests.listBuyerInterests(id("co1"), TODAY)).some((line) => line.id === co2.id)).toBe(false);
  });
});
