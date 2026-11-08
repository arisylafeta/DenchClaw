import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

// Synthetic rows only, all prefixed p4_, cleaned up at the end.
describe.skipIf(!TEST_URL)("matches v2", () => {
  let pg: typeof import("../postgres");
  let supplyV2: typeof import("./supply-matches-v2");
  let demandV2: typeof import("./demand-matches-v2");
  let offers: typeof import("./bulk-offers");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    supplyV2 = await import("./supply-matches-v2");
    demandV2 = await import("./demand-matches-v2");
    offers = await import("./bulk-offers");
    await pg.queryPg(`
      delete from crm_bulk_offers where bulk_listing_id like 'p4_%';
      delete from crm_bulk_listing_activity where bulk_listing_id like 'p4_%';
      delete from crm_bulk_listing_fields where bulk_listing_id like 'p4_%';
      delete from crm_bulk_listings where id like 'p4_%';
      delete from crm_stock_opportunities where id like 'p4_%';
      delete from crm_people where id like 'p4_%';
      delete from crm_companies where id like 'p4_%';

      insert into crm_companies (id, name, buyer_stage, buyer_tier, buyer_profile_basis, buyer_profile) values
        ('p4_co_make', 'Synthetic Make Buyer Ltd', 'Qualified', 'B', 'stated',
         '{"chemistries": ["NMC"], "formats": ["Packs"], "makes": ["Toyota"]}'),
        ('p4_co_part', 'Synthetic Part Buyer Ltd', 'Customer', 'A', 'stated',
         '{"chemistries": ["NMC"], "formats": ["Packs"], "dossier": {"products": [{"part_number": "SU001B5189", "format": "packs", "chemistry": "NMC", "kwh": [50], "status": "asked", "seen": "2026-09-01"}], "price": [{"eur_per_kwh": 60, "basis": "paid", "seen": "2026-09-01"}]}}'),
        ('p4_co_lfp', 'Synthetic LFP Buyer Ltd', 'Contacted', 'C', 'stated',
         '{"chemistries": ["LFP"], "formats": ["Packs"]}'),
        ('p4_co_other', 'Synthetic Other Buyer Ltd', 'Identified', null, 'researched',
         '{"chemistries": ["NMC"], "formats": ["Packs"]}');

      insert into crm_bulk_listings (id, kind, party, summary, status, quantity, location, spec) values
        ('p4_sup_1', 'supply', 'Synthetic Dismantler Ltd', '40 Toyota Proace packs', 'open', '40 packs', 'GB',
         '{"listing_title": "40 x Toyota Proace 50 kWh NMC packs"}'),
        ('p4_dem_1', 'demand', 'Synthetic Demand Buyer', 'Wants 40 Toyota Proace packs', 'open', '40 packs', 'GB',
         '{"wants": "Forty Toyota Proace 50 kWh NMC packs", "kind": "request"}'),
        ('p4_dem_2', 'demand', 'Synthetic Stock Buyer', 'Wants MG ZS packs', 'open', '10 packs', 'GB',
         '{"wants": "10 MG ZS EV 44 kWh packs", "kind": "request", "evidence": ["tested_soh"]}');

      insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility) values
        ('p4_sup_1', 'model', 'Toyota Proace SU001B5189', 'confirmed', 'teaser'),
        ('p4_sup_1', 'capacity', '50 kWh per pack', 'confirmed', 'teaser'),
        ('p4_sup_1', 'chemistry', 'NMC', 'confirmed', 'teaser'),
        ('p4_sup_1', 'format', 'Packs', 'confirmed', 'teaser'),
        ('p4_sup_1', 'quantity', '40 packs', 'confirmed', 'teaser'),
        ('p4_sup_1', 'location', 'GB', 'confirmed', 'teaser'),
        ('p4_sup_1', 'seller_price', 'EUR 40 per kWh', 'confirmed', 'teaser');

      insert into crm_people (id, company_id, full_name, email) values
        ('p4_pe_1', 'p4_co_other', 'Synthetic Contact', 'contact@synthetic.test');

      insert into crm_stock_opportunities (id, person_id, company_id, status, title, quantity, location, details) values
        ('p4_sto_1', 'p4_pe_1', 'p4_co_other', 'opportunity', 'MG ZS EV 44 kWh pack', 6, 'GB',
         '{"make": "MG", "model": "ZS EV", "format": "Packs", "chemistry": "NMC", "capacity_kwh": 44}'),
        ('p4_sto_listed', 'p4_pe_1', 'p4_co_other', 'opportunity', 'MG ZS EV 44 kWh pack on the marketplace', 4, 'GB',
         '{"make": "MG", "model": "ZS EV", "format": "Packs", "chemistry": "NMC", "capacity_kwh": 44}'),
        ('p4_sto_bulk', 'p4_pe_1', 'p4_co_other', 'opportunity', 'MG ZS EV 44 kWh pack in a bulk lot', 2, 'GB',
         '{"make": "MG", "model": "ZS EV", "format": "Packs", "chemistry": "NMC", "capacity_kwh": 44}');

      update crm_stock_opportunities set marketplace_listing_id = 'listing_synthetic_1' where id = 'p4_sto_listed';
      update crm_stock_opportunities set bulk_listing_id = 'p4_sup_1' where id = 'p4_sto_bulk';

      insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data)
      values ('p4_sup_1', 'supply', 'Shortlisted: Synthetic Make Buyer Ltd', '{"match": {"key": "company:p4_co_make", "verdict": "shortlist"}}'),
             ('p4_sup_1', 'supply', 'Not a fit: Synthetic LFP Buyer Ltd', '{"match": {"key": "company:p4_co_lfp", "verdict": "not_a_fit", "reason": "LFP only"}}');
    `);
  });

  afterAll(async () => {
    if (!pg) {
      return;
    }
    await pg.queryPg(`
      delete from crm_bulk_offers where bulk_listing_id like 'p4_%';
      delete from crm_bulk_listing_activity where bulk_listing_id like 'p4_%';
      delete from crm_bulk_listing_fields where bulk_listing_id like 'p4_%';
      delete from crm_bulk_listings where id like 'p4_%';
      delete from crm_stock_opportunities where id like 'p4_%';
      delete from crm_people where id like 'p4_%';
      delete from crm_companies where id like 'p4_%';
    `);
    await pg.pgPool.end();
  });

  describe("supplyMatchesV2", () => {
    it("builds the product key from the listing's own fields", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      expect(result).not.toBeNull();
      expect(result!.lotKey.line).toMatch(/50 kWh/);
      expect(result!.lotKey.full.join(" | ")).toMatch(/part SU001B5189/);
      expect(result!.lotKey.open).toBe(false);
    });

    it("puts the live ask first, tagged and with the gap as its check line", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      const first = result!.rows[0];
      expect(first.key).toBe("demand:p4_dem_1");
      expect(first.tags).toContain("live ask");
      expect(first.reason).toMatch(/Wants /);
      expect(first.rank).toBe(1);
      expect(result!.rows.filter((row) => row.tags.includes("live ask"))).toHaveLength(1);
    });

    it("ranks a shortlisted buyer first among companies and hides the one marked not a fit", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      const ids = result!.rows.map((row) => row.companyId);
      expect(ids).toContain("p4_co_make");
      expect(ids).toContain("p4_co_part");
      expect(ids).not.toContain("p4_co_lfp");
      expect(result!.rows[1].key).toBe("company:p4_co_make");
      expect(result!.rows.map((row) => row.rank)).toEqual(result!.rows.map((_, index) => index + 1));
    });

    it("puts a dossier part-number match above a make-only match, with its firm price and checks", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      const part = result!.rows.find((row) => row.companyId === "p4_co_part")!;
      const make = result!.rows.find((row) => row.companyId === "p4_co_make")!;
      expect(part.reason).toMatch(/Same part number/);
      expect(part.price).toMatch(/against their 60\/kWh/);
      expect(make.checks.length).toBeGreaterThan(0);
    });

    it("tags a researched-only company as a lead and gives it our contact", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      const lead = result!.rows.find((row) => row.companyId === "p4_co_other")!;
      expect(lead.tags).toEqual(["lead"]);
      expect(lead.personId).toBe("p4_pe_1");
      expect(lead.contact).toBe("contact@synthetic.test");
    });

    it("shows the offer a row already became, without a second one", async () => {
      const before = await supplyV2.supplyMatchesV2("p4_sup_1");
      expect(before!.rows.every((row) => row.offer === null)).toBe(true);
      const offer = await offers.addOffer("p4_sup_1", {
        name: "Synthetic Part Buyer Ltd", companyId: "p4_co_part",
        data: { match: { reason: "Same part number", rank: 1, at: "2026-11-08T10:00:00.000Z" } },
      });
      const after = await supplyV2.supplyMatchesV2("p4_sup_1");
      const row = after!.rows.find((item) => item.companyId === "p4_co_part")!;
      expect(row.offer).toMatchObject({ id: offer.id, stage: "candidate" });
    });

    it("drops a row once it is marked not a fit, and keeps the reason", async () => {
      await pg.queryPg(
        `insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, data)
         values ('p4_sup_1', 'supply', 'Not a fit: Synthetic Other Buyer Ltd',
                 '{"match": {"key": "company:p4_co_other", "verdict": "not_a_fit", "reason": "Price"}}')`);
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      expect(result!.rows.map((row) => row.companyId)).not.toContain("p4_co_other");
    });

    it("returns null for a demand listing or an unknown id", async () => {
      expect(await supplyV2.supplyMatchesV2("p4_dem_1")).toBeNull();
      expect(await supplyV2.supplyMatchesV2("p4_missing")).toBeNull();
    });
  });

  describe("demandMatchesV2", () => {
    it("counts unlisted stock once and never a unit that is already on a listing", async () => {
      const result = await demandV2.demandMatchesV2("p4_dem_2");
      expect(result).not.toBeNull();
      const stockKeys = result!.rows.map((row) => row.key).filter((key) => key.startsWith("stock:"));
      expect(stockKeys).toEqual(["stock:p4_sto_1"]);
    });

    it("tags each row with its source, and carries the stock row and the seller", async () => {
      const result = await demandV2.demandMatchesV2("p4_dem_2");
      const row = result!.rows.find((item) => item.key === "stock:p4_sto_1")!;
      expect(row.tags).toEqual(["unlisted stock"]);
      expect(row.stockId).toBe("p4_sto_1");
      expect(row.companyId).toBe("p4_co_other");
      expect(row.contact).toBe("contact@synthetic.test");
      // No stated price on this stock row, so no price line at all.
      expect(row.price).toBeNull();
    });

    it("downgrades Exact when the request's evidence bar is not met", async () => {
      const result = await demandV2.demandMatchesV2("p4_dem_2");
      const row = result!.rows.find((item) => item.key === "stock:p4_sto_1")!;
      expect(row.checks.join(" ")).toMatch(/Ask for a tested SoH reading/i);
    });

    it("describes the request's own key in the header", async () => {
      const result = await demandV2.demandMatchesV2("p4_dem_2");
      expect(result!.lotKey.line).toMatch(/MG/);
      expect(result!.lotKey.full.join(" | ")).toMatch(/Evidence/);
    });

    it("returns null for an unknown request", async () => {
      expect(await demandV2.demandMatchesV2("p4_missing")).toBeNull();
    });
  });
});
