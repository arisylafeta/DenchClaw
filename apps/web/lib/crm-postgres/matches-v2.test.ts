import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

// Synthetic rows only, all prefixed p4_, cleaned up at the end.
describe.skipIf(!TEST_URL)("matches v2", () => {
  let pg: typeof import("../postgres");
  let supplyV2: typeof import("./supply-matches-v2");
  let demandV2: typeof import("./demand-matches-v2");

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    supplyV2 = await import("./supply-matches-v2");
    demandV2 = await import("./demand-matches-v2");
    await pg.queryPg(`
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

      insert into crm_people (id, company_id, full_name) values ('p4_pe_1', 'p4_co_other', 'Synthetic Contact');

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
      expect(result!.key.lines[0]).toMatchObject({ kwh: 50, format: "Packs", chemistry: "NMC", partNumber: "SU001B5189", make: "Toyota" });
      expect(result!.key.units).toBe(40);
      expect(result!.key.sellerPrice).toMatchObject({ currency: "EUR", per: "kwh", eurPerKwh: 40 });
      expect(result!.keyLine).toMatch(/50 kWh/);
    });

    it("matches live demand on the key, not the title", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      const demand = result!.liveDemand.find((row) => row.demandId === "p4_dem_1");
      expect(demand).toBeDefined();
      expect(demand!.checks.some((check) => check.key === "product" && check.state === "pass")).toBe(true);
    });

    it("ranks a shortlisted buyer first and hides the one marked not a fit, with the reason", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      const ids = result!.recommended.map((row) => row.companyId);
      expect(ids).toContain("p4_co_make");
      expect(ids).toContain("p4_co_part");
      expect(ids).not.toContain("p4_co_lfp");
      expect(result!.recommended[0].companyId).toBe("p4_co_make");
      expect(result!.recommended[0].userVerdict).toBe("shortlist");
      const hidden = result!.ruledOut.find((row) => row.companyId === "p4_co_lfp");
      expect(hidden).toMatchObject({ code: "not_a_fit", kind: "verdict" });
    });

    it("puts a dossier part-number match above a make-only match and shows the gaps", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      const part = result!.recommended.find((row) => row.companyId === "p4_co_part");
      const make = result!.recommended.find((row) => row.companyId === "p4_co_make");
      expect(part!.productTier).toBe(4);
      expect(make!.productTier).toBe(2);
      expect(part!.hasDossier).toBe(true);
      expect(part!.priceBand).toMatch(/against their 60\/kWh/);
      expect(make!.checks.length).toBeGreaterThan(0);
    });

    it("leaves a researched-only company in leads", async () => {
      const result = await supplyV2.supplyMatchesV2("p4_sup_1");
      expect(result!.leads.map((row) => row.companyId)).toContain("p4_co_other");
      expect(result!.recommended.map((row) => row.companyId)).not.toContain("p4_co_other");
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
      const stockKeys = result!.sources.unlistedStock.map((row) => row.key);
      expect(stockKeys).toEqual(["stock:p4_sto_1"]);
      expect(stockKeys).not.toContain("stock:p4_sto_listed");
      expect(stockKeys).not.toContain("stock:p4_sto_bulk");
    });

    it("downgrades Exact when the request's evidence bar is not met", async () => {
      const result = await demandV2.demandMatchesV2("p4_dem_2");
      const row = result!.sources.unlistedStock[0];
      expect(row.verdict).toBe("check");
      expect(row.evidenceMissing.join(" ")).toMatch(/tested SoH/i);
      expect(row.gap).toMatch(/Ask for/);
      expect(result!.requirement.evidence).toEqual(["tested_soh"]);
    });

    it("leads with the first row of the same order and suggests sellers who had the make", async () => {
      const result = await demandV2.demandMatchesV2("p4_dem_2");
      const first = result!.sources.unlistedStock[0] ?? result!.sources.ourListings[0] ?? result!.sources.marketplace[0];
      expect(result!.bestSource?.key).toBe(first?.key);
      expect(result!.sources.goFind.map((row) => row.companyId)).toContain("p4_co_other");
      expect(result!.sources.goFind[0].why).toMatch(/MG/);
    });

    it("returns null for an unknown request", async () => {
      expect(await demandV2.demandMatchesV2("p4_missing")).toBeNull();
    });
  });
});
