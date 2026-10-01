import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FilterGroup } from "../object-filters";
import type * as Postgres from "../postgres";
import type * as ObjectRead from "./object-read";
import type * as Views from "./views";

// Disposable Postgres only; every fixture lives in a unique schema and is removed afterwards.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("computed CRM discovery purpose", () => {
  const schema = `purpose_test_${Math.random().toString(36).slice(2, 12)}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let admin: Pool;
  let pg: typeof Postgres;
  let objects: typeof ObjectRead;
  let views: typeof Views;
  let seedSql: string;
  const buyers = ["category", "evidence", "excluded", "new_prospect", "newsletter", "old_prospect", "overlap", "platform", "repurposer", "roles", "stage"];
  const dismantlers = ["dismantler_category", "dismantler_role", "dismantler_tag", "overlap", "registry"];
  const buyerPeople = ["discovery_new", "discovery_old", "inherited", "newsletter_new", "newsletter_peer", "newsletter_supply", "opted_out", "overlap_person", "unlinked", "unlinked_repurposer"];

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_URL });
    const client = await admin.connect();
    try {
      await client.query(`create schema ${schema}`);
      await client.query(`set search_path to ${schema}, public`);
      for (const table of ["crm_objects", "crm_fields", "crm_companies", "crm_people", "crm_dismantlers"]) {
        await client.query(`create table ${table} (like public.${table} including defaults including indexes)`);
      }
      await client.query(`insert into crm_objects (id, name, entity_table, display_field) values
        ('obj_company', 'company', 'crm_companies', 'Name'),
        ('obj_people', 'people', 'crm_people', 'Full Name'),
        ('obj_companies', 'companies', 'crm_companies', 'Name'),
        ('obj_other', 'other', 'crm_companies', 'Name')`);
      await client.query(`insert into crm_fields (id, object_id, name, type, canonical_column, sort_order) values
        ('co_name', 'obj_company', 'Name', 'text', 'name', 1),
        ('co_flags', 'obj_company', 'Buyer Workstream Status', 'enum', 'buyer_workstream_status', 2),
        ('co_exclusion', 'obj_company', 'Buyer Exclusion Reason', 'text', 'buyer_exclusion_reason', 3),
        ('p_name', 'obj_people', 'Full Name', 'text', 'full_name', 1),
        ('p_optout', 'obj_people', 'Email Opted Out', 'boolean', 'email_opted_out', 2),
        ('cos_name', 'obj_companies', 'Name', 'text', 'name', 1),
        ('other_name', 'obj_other', 'Name', 'text', 'name', 1)`);
      seedSql = await readFile(new URL("./migrations/023_saved_purpose_views.sql", import.meta.url), "utf8");
      await client.query(seedSql);
      await client.query(`insert into crm_companies (id, name, tags, platform_role, roles, buyer_category, buyer_stage, buyer_evidence, buyer_workstream_status, buyer_exclusion_reason) values
        ('old_prospect', 'Old prospect', array['buyer-discovery-2020-01-02'], null, null, null, null, null, null, null),
        ('new_prospect', 'Recent prospect', array['buyer-prospect'], null, null, null, null, null, null, null),
        ('repurposer', 'Second life', array[' REPURPOSER '], null, null, null, null, null, null, null),
        ('platform', 'Platform member', null, ' BuYeR ', null, null, null, null, null, null),
        ('roles', 'Multiple roles', null, null, array['supplier', ' BUYER '], null, null, null, null, null),
        ('category', 'Category profile', null, null, null, 'Repurposer', null, null, null, null),
        ('stage', 'Stage profile', null, null, null, null, 'Identified', null, null, null),
        ('evidence', 'Evidence profile', null, null, null, null, null, 'Confirmed demand for packs', null, null),
        ('excluded', 'Excluded prospect', array['buyer'], null, null, null, null, null, 'Excluded', 'Do not contact'),
        ('newsletter', 'Newsletter company', null, null, null, null, null, null, null, null),
        ('overlap', 'Both purposes', array['Buyer'], null, null, null, null, null, null, null),
        ('registry', 'Known yard', null, null, null, null, null, null, null, null),
        ('dismantler_tag', 'Tagged yard', array[' Dismantler '], null, null, null, null, null, null, null),
        ('dismantler_role', 'Role yard', null, 'DISMANTLER', null, null, null, null, null, null),
        ('dismantler_category', 'Category yard', null, null, null, 'Dismantler', null, null, null, null),
        ('internal_only', 'Only internal contacts', null, null, null, null, null, null, null, null),
        ('internal_company', 'Internal company', array['internal-company', 'buyer', 'dismantler'], 'buyer', null, null, null, null, null, null),
        ('irrelevant', 'Unclassified supplier', array['not-a-buyer'], 'supplier', null, 'Not a buyer', null, null, null, null),
        ('dynamic', 'Membership changes', null, null, null, null, null, null, null, null)`);
      await client.query("update crm_companies set notes = 'We discuss buyers and dismantlers' where id = 'irrelevant'");
      await client.query(`insert into crm_dismantlers (id, company_id) values ('dm_registry', 'registry'), ('dm_overlap', 'overlap'), ('dm_internal', 'internal_company')`);
      await client.query(`insert into crm_people (id, full_name, tags, company_id, email_opted_out) values
        ('newsletter_supply', 'Existing subscriber', array['Supply Update'], 'newsletter', false),
        ('newsletter_new', 'New subscriber', array['New to Supply Updates'], 'newsletter', false),
        ('newsletter_peer', 'Linked peer', null, 'newsletter', false),
        ('unlinked', 'No company', array[' supply update '], null, false),
        ('opted_out', 'Opted out subscriber', array['Supply Update'], null, true),
        ('unlinked_repurposer', 'Independent second life', array['repurposer'], null, false),
        ('discovery_old', 'Old discovery', array['buyer-discovery-2018-02-03'], null, false),
        ('discovery_new', 'New discovery', array['buyer-prospect'], null, false),
        ('inherited', 'Inherited purpose', null, 'roles', false),
        ('overlap_person', 'Both purposes', null, 'overlap', false),
        ('yard_person', 'Inherited yard', null, 'registry', false),
        ('direct_yard', 'Independent yard', array['dismantler'], null, false),
        ('internal_linked', 'Internal employee', array['internal-contact', 'Supply Update', 'dismantler'], 'roles', false),
        ('internal_newsletter', 'Internal subscriber', array['internal-contact', 'New to Supply Updates'], 'internal_only', false),
        ('internal_unlinked', 'Internal without company', array['internal-contact', 'buyer'], null, false),
        ('internal_company_person', 'Linked internal company', array['Supply Update'], 'internal_company', false),
        ('irrelevant_person', 'Unclassified person', null, 'irrelevant', false),
        ('dynamic_person', 'Dynamic inheritance', null, 'dynamic', false)`);
      for (const table of ["crm_companies", "crm_people", "crm_dismantlers"]) {
        await client.query(`analyze ${table}`);
      }
    } finally {
      client.release();
    }
    const scopedUrl = new URL(TEST_URL!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = scopedUrl.toString();
    // The pool captures DATABASE_URL at module load; static imports cannot set the fixture search_path first.
    pg = await import("../postgres");
    objects = await import("./object-read");
    views = await import("./views");
  });

  afterAll(async () => {
    if (pg) await pg.pgPool.end();
    if (admin) {
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  async function read(objectName: string, purpose?: string, extra: Record<string, string> = {}) {
    const url = new URL("http://localhost/objects");
    for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
    if (purpose) {
      const state = await views.getPostgresObjectViews(objectName);
      const saved = state.views.find((view) => view.name === purpose);
      expect(saved).toBeDefined();
      url.searchParams.set("filters", JSON.stringify(saved!.filters));
    }
    return objects.getPostgresObjectData(objectName, url);
  }

  it("includes old and new prospects, all newsletter contacts and profile/role companies with no people", async () => {
    const companies = await read("company", "Buyers");
    expect(companies.entries.map((row) => row.entry_id).sort()).toEqual(buyers);
    expect(companies.totalCount).toBe(buyers.length);
    expect(companies.fields.find((field) => field.name === "Purpose")).toMatchObject({ enum_multiple: true, read_only: true });
    for (const entry of companies.entries) expect(entry.Purpose).toContain("Buyer");
    const people = await read("people", "Buyers");
    expect(people.entries.map((row) => row.entry_id).sort()).toEqual(buyerPeople);
    expect(people.totalCount).toBe(buyerPeople.length);
    expect(people.entries.find((row) => row.entry_id === "unlinked")?.Purpose).toEqual(["Buyer"]);
    expect(companies.entries.find((row) => row.entry_id === "excluded")).toMatchObject({ "Buyer Workstream Status": "Excluded", "Buyer Exclusion Reason": "Do not contact" });
    expect(people.entries.find((row) => row.entry_id === "opted_out")).toMatchObject({ "Email Opted Out": true, Purpose: ["Buyer"] });
  });

  it("includes registered, tagged, role and category dismantlers and allows overlapping purposes", async () => {
    const companies = await read("company", "Dismantlers");
    expect(companies.entries.map((row) => row.entry_id).sort()).toEqual(dismantlers);
    expect(companies.entries.find((row) => row.entry_id === "overlap")?.Purpose).toEqual(["Buyer", "Dismantler"]);
    const people = await read("people", "Dismantlers");
    expect(people.entries.map((row) => row.entry_id).sort()).toEqual(["direct_yard", "overlap_person", "yard_person"]);
    expect(people.entries.find((row) => row.entry_id === "overlap_person")?.Purpose).toEqual(["Buyer", "Dismantler"]);
  });

  it("excludes internal people and tagged internal companies without inferring purpose from notes", async () => {
    const people = await read("people");
    for (const id of ["internal_linked", "internal_newsletter", "internal_unlinked", "internal_company_person", "irrelevant_person"]) {
      expect(people.entries.find((row) => row.entry_id === id)?.Purpose).toEqual([]);
    }
    const companies = await read("company");
    for (const id of ["internal_only", "internal_company", "irrelevant"]) {
      expect(companies.entries.find((row) => row.entry_id === id)?.Purpose).toEqual([]);
    }
    const aliases = await read("companies");
    expect(aliases.entries.find((row) => row.entry_id === "roles")?.Purpose).toEqual(["Buyer"]);
    const other = await read("other");
    expect(other.fields.some((field) => field.name === "Purpose")).toBe(false);
  });

  it("keeps pagination totals, search and purpose sorting consistent with projected arrays", async () => {
    const all: string[] = [];
    for (let page = 1; page <= Math.ceil(buyers.length / 3); page++) {
      const result = await read("company", "Buyers", { page: String(page), pageSize: "3", sort: JSON.stringify([{ field: "Purpose", direction: "asc" }]) });
      expect(result.totalCount).toBe(buyers.length);
      all.push(...result.entries.map((row) => String(row.entry_id)));
    }
    expect(all.slice(0, -1).sort()).toEqual(buyers.filter((id) => id !== "overlap"));
    expect(all[all.length - 1]).toBe("overlap");
    expect(all.sort()).toEqual(buyers);
    const search = await read("company", undefined, { search: "Buyer" });
    expect(search.entries.map((row) => row.entry_id).sort()).toEqual(buyers);
    expect(search.totalCount).toBe(buyers.length);
    const filters: FilterGroup = { id: "empty", conjunction: "and", rules: [{ id: "purpose", field: "Purpose", operator: "is_empty" }] };
    const empty = await read("company", undefined, { filters: JSON.stringify(filters) });
    expect(empty.entries.map((row) => row.entry_id).sort()).toEqual(["dynamic", "internal_company", "internal_only", "irrelevant"]);
    expect(empty.totalCount).toBe(4);
  });

  it("supports single-purpose membership and exclusion when refining enum filters", async () => {
    const filters: FilterGroup = {
      id: "single", conjunction: "and",
      rules: [{ id: "purpose", field: "Purpose", operator: "is", value: "Buyer" }],
    };
    const members = await read("company", undefined, { filters: JSON.stringify(filters) });
    expect(members.entries.map((row) => row.entry_id).sort()).toEqual(buyers);
    filters.rules = [{ id: "purpose", field: "Purpose", operator: "is_not", value: "Buyer" }];
    const others = await read("company", undefined, { filters: JSON.stringify(filters) });
    expect(others.entries.map((row) => row.entry_id).sort()).toEqual([
      "dismantler_category", "dismantler_role", "dismantler_tag", "dynamic",
      "internal_company", "internal_only", "irrelevant", "registry",
    ]);
  });

  it("reflects changing company/contact membership without rewriting seeded or refined shared views", async () => {
    const original = await views.getPostgresObjectViews("company");
    expect((await read("company")).savedViews).toEqual(original.views);
    expect((await read("company")).activeView).toBe("Buyers");
    await pg.queryPg("update crm_companies set tags = array['buyer', 'dismantler'] where id = 'dynamic'");
    expect((await read("company", "Buyers")).entries.map((row) => row.entry_id).sort()).toEqual([...buyers, "dynamic"].sort());
    expect((await read("people", "Buyers")).entries.find((row) => row.entry_id === "dynamic_person")?.Purpose).toEqual(["Buyer", "Dismantler"]);
    expect(await views.getPostgresObjectViews("company")).toEqual(original);
    await pg.queryPg("update crm_companies set tags = null where id = 'dynamic'");
    expect((await read("people", "Buyers")).entries.map((row) => row.entry_id).sort()).toEqual(buyerPeople);
    await pg.queryPg("update crm_people set tags = null where id in ('newsletter_supply', 'newsletter_new')");
    expect((await read("company", "Buyers")).entries.map((row) => row.entry_id).sort()).toEqual(buyers.filter((id) => id !== "newsletter"));
    expect((await read("people", "Buyers")).entries.map((row) => row.entry_id).sort()).toEqual(buyerPeople.filter((id) => !id.startsWith("newsletter_")));
    const refined = original.views.map((view) => view.name === "Buyers" ? { ...view, columns: ["Name", "Purpose"] } : view);
    await views.savePostgresObjectViews("company", refined, "Dismantlers", { column_widths: { Purpose: 240 } });
    await pg.queryPg(seedSql);
    const final = await read("company");
    expect(final.savedViews).toEqual(refined);
    expect(final.activeView).toBe("Dismantlers");
    expect(final.viewSettings).toEqual({ column_widths: { Purpose: 240 } });
  });

  it("recognizes outreach and compound purpose tags without matching negated labels", async () => {
    await pg.queryPg(`insert into crm_people (id, full_name, tags) values
      ('vocab_outreach', 'Outreach prospect', array['buyer-outreach-target']),
      ('vocab_repurposer', 'Repurposer contact', array['repurposer-contact']),
      ('vocab_list', 'Historic buyer', array['buyer-list-2026-08-14']),
      ('vocab_potential', 'Potential buyer contact', array['potential-buyer-contact']),
      ('vocab_yard', 'Automotive yard', array['auto-dismantler']),
      ('vocab_negative', 'Not a buyer', array['not-a-buyer', 'not-a-dismantler'])`);
    await pg.queryPg(`insert into crm_companies (id, name, tags) values
      ('vocab_compound', 'EV dismantler reseller', array['EV Dismantler Reseller']),
      ('vocab_strategic', 'Strategic second life', array['strategic-repurposer']),
      ('vocab_newsletter', 'Newsletter account', array['New to Supply Updates'])`);
    const people = await read("people");
    const companies = await read("company");
    for (const id of ["vocab_outreach", "vocab_repurposer", "vocab_list", "vocab_potential"]) {
      expect(people.entries.find((entry) => entry.entry_id === id)?.Purpose).toEqual(["Buyer"]);
    }
    expect(people.entries.find((entry) => entry.entry_id === "vocab_yard")?.Purpose).toEqual(["Dismantler"]);
    expect(people.entries.find((entry) => entry.entry_id === "vocab_negative")?.Purpose).toEqual([]);
    expect(companies.entries.find((entry) => entry.entry_id === "vocab_compound")?.Purpose).toEqual(["Dismantler"]);
    expect(companies.entries.find((entry) => entry.entry_id === "vocab_strategic")?.Purpose).toEqual(["Buyer"]);
    expect(companies.entries.find((entry) => entry.entry_id === "vocab_newsletter")?.Purpose).toEqual(["Buyer"]);
  });
});
