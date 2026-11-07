import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database:
//   CRM_TEST_DB_NAME=crm-test-db-phase3 CRM_TEST_DB_PORT=55434 scripts/rebattery/crm-test-db.sh up
//   BULK_TRADES_TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55434/denchclaw npx vitest run lib/crm-postgres/buyer-dossier
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

const DOSSIER = `---
company_id: "%ID%"
company: "Dossier Test Ltd"
min_soh: 60
origins: [DE, PL]
products:
  - make: Volkswagen
    format: packs
    chemistry: NMC
    kwh: [82]
    status: bought
    seen: "2026-06-15"
    src: "gmail_msg_test1"
rules_out:
  chemistries: [LTO]
last_verified: "2026-07-02"
---
Second-life MEB packs only.
`;

describe.skipIf(!TEST_URL)("buyer dossier write path", () => {
  let pg: typeof import("../postgres");
  let dossiers: typeof import("./buyer-dossier");
  const suffix = Math.random().toString(36).slice(2, 8);

  const dossierFor = (id: string) => DOSSIER.replace("%ID%", id);

  async function company(tag: string, buyerProfile: Record<string, unknown> | null = null): Promise<string> {
    const id = `co_dossier_${tag}_${suffix}`;
    await pg.queryPg("insert into crm_companies (id, name, buyer_profile) values ($1, $2, coalesce($3::jsonb, '{}'::jsonb))", [
      id,
      `Dossier ${tag}`,
      buyerProfile ? JSON.stringify(buyerProfile) : null,
    ]);
    return id;
  }

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    dossiers = await import("./buyer-dossier");
  });

  // The rows stay: the database is disposable, and deleting a company cascades into the frozen
  // Bulk Trades tables, whose trigger rejects writes.
  afterAll(async () => {
    await pg.pgPool.end();
  });

  it("writes the dossier, derives buyer_profile, bumps the version and is logged", async () => {
    const id = await company("save");
    const result = await dossiers.saveDossier(id, dossierFor(id), 0);
    expect(result.kind).toBe("saved");
    if (result.kind !== "saved") return;
    expect(result.version).toBe(1);
    expect(result.profileChanged).toBe(true);
    expect(result.passedThrough).toEqual([]);

    const [row] = await pg.queryPg<{ buyer_dossier: string; buyer_profile: Record<string, unknown>; version: number }>(
      `select buyer_dossier, buyer_profile, buyer_dossier_version::int as version from crm_companies where id = $1`,
      [id],
    );
    expect(row.version).toBe(1);
    expect(row.buyer_dossier).toBe(dossierFor(id));
    expect(row.buyer_profile).toMatchObject({
      chemistries: ["NMC"],
      formats: ["Packs"],
      makes: ["VW Group"],
      origins: ["DE", "PL"],
      min_soh: 60,
      kwh_min: 82,
      kwh_max: 82,
    });

    const logged = await pg.queryPg<{ field: string }>(
      "select field from crm_buyer_profile_changes where company_id = $1",
      [id],
    );
    const fields = logged.map((entry) => entry.field);
    expect(fields).toContain("buyer_dossier");
    expect(fields).toContain("buyer_profile");
    expect(fields).toContain("buyer_dossier_version");
  });

  it("keeps pass-through keys and writes buyer_profile only when the derived profile changes", async () => {
    const id = await company("merge", { evidence_url: "https://example.test/evidence", wants: "old wants" });
    const first = await dossiers.saveDossier(id, dossierFor(id), 0);
    expect(first.kind).toBe("saved");
    if (first.kind !== "saved") return;
    expect(first.passedThrough).toEqual(["evidence_url"]);
    expect(first.profile.wants).toContain("Volkswagen");
    expect(first.profile.evidence_url).toBe("https://example.test/evidence");

    // The same text again is a no-op: the version does not move and nothing is written.
    const [beforeSecond] = await pg.queryPg<{ id: string }>(
      "select coalesce(max(id), 0)::text as id from crm_buyer_profile_changes where company_id = $1",
      [id],
    );
    const second = await dossiers.saveDossier(id, dossierFor(id), 1);
    expect(second.kind).toBe("saved");
    if (second.kind !== "saved") return;
    expect(second.unchanged).toBe(true);
    expect(second.version).toBe(1);
    expect(second.profileChanged).toBe(false);
    const [afterSecond] = await pg.queryPg<{ version: number }>(
      "select buyer_dossier_version::int as version from crm_companies where id = $1",
      [id],
    );
    expect(afterSecond.version).toBe(1);
    const writes = await pg.queryPg(
      "select 1 from crm_buyer_profile_changes where company_id = $1 and id > $2::bigint",
      [id, beforeSecond.id],
    );
    expect(writes).toHaveLength(0);
  });

  it("refuses a dossier whose frontmatter names a different company", async () => {
    const id = await company("wrong-company");
    const other = await company("wrong-company-target");
    const result = await dossiers.saveDossier(id, dossierFor(other), 0);
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") {
      return;
    }
    expect(result.errors.join(" ")).toContain("company_id");
    const [row] = await pg.queryPg<{ buyer_dossier: string | null; version: number }>(
      "select buyer_dossier, buyer_dossier_version::int as version from crm_companies where id = $1",
      [id],
    );
    expect(row.buyer_dossier).toBeNull();
    expect(row.version).toBe(0);
  });

  it("refuses a stale editor with a conflict and leaves the text alone", async () => {
    const id = await company("conflict");
    expect((await dossiers.saveDossier(id, dossierFor(id), 0)).kind).toBe("saved");
    const conflict = await dossiers.saveDossier(id, `${dossierFor(id)}\nedited while stale\n`, 0);
    expect(conflict).toMatchObject({ kind: "conflict", currentVersion: 1 });
    const [row] = await pg.queryPg<{ buyer_dossier: string; version: number }>(
      "select buyer_dossier, buyer_dossier_version::int as version from crm_companies where id = $1",
      [id],
    );
    expect(row.version).toBe(1);
    expect(row.buyer_dossier).not.toContain("edited while stale");
  });

  it("writes nothing when the dossier has validation errors", async () => {
    const id = await company("invalid");
    const broken = dossierFor(id).replace("status: bought", "status: maybe");
    const result = await dossiers.saveDossier(id, broken, 0);
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.errors.join(" ")).toContain("products[0].status");
    const [row] = await pg.queryPg<{ buyer_dossier: string | null; version: number }>(
      "select buyer_dossier, buyer_dossier_version::int as version from crm_companies where id = $1",
      [id],
    );
    expect(row.buyer_dossier).toBeNull();
    expect(row.version).toBe(0);
    expect((await dossiers.saveDossier(id, "   \n ", 0)).kind).toBe("invalid");
  });

  it("rejects a direct buyer_profile write on a dossier row but leaves other columns editable", async () => {
    const id = await company("guard");
    expect((await dossiers.saveDossier(id, dossierFor(id), 0)).kind).toBe("saved");

    await expect(
      pg.queryPg(`update crm_companies set buyer_profile = '{"wants":"diverged"}'::jsonb where id = $1`, [id]),
    ).rejects.toThrow(/written only by the dossier write path/);
    await pg.queryPg("update crm_companies set notes = 'an unrelated edit' where id = $1", [id]);
    const [row] = await pg.queryPg<{ notes: string; wants: string }>(
      "select notes, buyer_profile->>'wants' as wants from crm_companies where id = $1",
      [id],
    );
    expect(row.notes).toBe("an unrelated edit");
    expect(row.wants).toContain("Volkswagen");
  });

  it("allows the first load only through the setting", async () => {
    const id = await company("first-load");
    await expect(
      pg.queryPg("update crm_companies set buyer_dossier = 'text' where id = $1", [id]),
    ).rejects.toThrow(/written only by the dossier write path/);
    const [row] = await pg.queryPg<{ buyer_dossier: string | null }>(
      "select buyer_dossier from crm_companies where id = $1",
      [id],
    );
    expect(row.buyer_dossier).toBeNull();
  });

  it("refuses dossier text on insert unless the setting is on, and lets a plain profile insert through", async () => {
    const id = `co_dossier_insert_${suffix}`;
    await expect(
      pg.queryPg("insert into crm_companies (id, name, buyer_dossier) values ($1, 'Insert Guard', 'text')", [id]),
    ).rejects.toThrow(/written only by the dossier write path/);
    const plain = `co_dossier_insert_plain_${suffix}`;
    await pg.queryPg("insert into crm_companies (id, name, buyer_profile) values ($1, 'Plain Insert', '{\"wants\":\"x\"}'::jsonb)", [plain]);
    const [row] = await pg.queryPg<{ buyer_dossier: string | null }>(
      "select buyer_dossier from crm_companies where id = $1",
      [plain],
    );
    expect(row.buyer_dossier).toBeNull();
  });

  it("rejects the generic entry update on buyer_profile but lets another company column through", async () => {
    const id = await company("entry-path");
    expect((await dossiers.saveDossier(id, dossierFor(id), 0)).kind).toBe("saved");

    // The disposable database is built from schema.sql and the migrations, which seed no 'company' object (production
    // has one). Register it plus a buyer_profile field for this test so the generic entry update path is exercised
    // against the guard; both rows go afterwards.
    const objectId = `obj_test_${suffix}_company`;
    const fieldId = `fld_test_${suffix}_buyer_profile`;
    const stageFieldId = `fld_test_${suffix}_buyer_stage`;
    await pg.queryPg(
      `insert into crm_objects (id, name, entity_table, display_field)
       values ($1, 'company', 'crm_companies', 'name') on conflict (name) do nothing`,
      [objectId],
    );
    await pg.queryPg(
      `insert into crm_fields (id, object_id, name, type, canonical_column, sort_order)
       select $1, id, 'ZZ Test Buyer Profile', 'text', 'buyer_profile', 999 from crm_objects where name = 'company'`,
      [fieldId],
    );
    await pg.queryPg(
      `insert into crm_fields (id, object_id, name, type, canonical_column, sort_order)
       select $1, id, 'Buyer Stage', 'enum', 'buyer_stage', 1 from crm_objects where name = 'company'`,
      [stageFieldId],
    );
    try {
      const mutations = await import("./entry-mutations");
      await expect(
        mutations.updatePostgresEntry("company", id, { "ZZ Test Buyer Profile": '{"wants":"diverged"}' }),
      ).rejects.toThrow(/written only by the dossier write path/);
      await expect(
        mutations.updatePostgresEntry("company", id, { "Buyer Stage": "Contacted" }),
      ).resolves.toMatchObject({ ok: true });
    } finally {
      await pg.queryPg("delete from crm_fields where id = any($1::text[])", [[fieldId, stageFieldId]]);
      await pg.queryPg("delete from crm_objects where id = $1", [objectId]);
    }
    const [row] = await pg.queryPg<{ stage: string | null; wants: string }>(
      "select buyer_stage as stage, buyer_profile->>'wants' as wants from crm_companies where id = $1",
      [id],
    );
    expect(row.stage).toBe("Contacted");
    expect(row.wants).toContain("Volkswagen");
  });

  it("marks a dossier reviewed without touching its text", async () => {
    const id = await company("reviewed");
    expect((await dossiers.saveDossier(id, dossierFor(id), 0)).kind).toBe("saved");
    await pg.queryPg(
      `update crm_companies set buyer_dossier_stale_since = '2026-11-01',
         buyer_dossier_stale_reasons = '[{"date":"2026-11-01","reason":"new saved search","source_id":"saved_search:1"}]'::jsonb
       where id = $1`,
      [id],
    );
    const before = await dossiers.getCompanyDossier(id);
    expect(before?.stale_since).toBe("2026-11-01");
    expect(before?.stale_reasons).toHaveLength(1);

    expect((await dossiers.markDossierReviewed(id)).ok).toBe(true);
    const after = await dossiers.getCompanyDossier(id);
    expect(after?.stale_since).toBeNull();
    expect(after?.stale_reasons).toEqual([]);
    expect(after?.text).toBe(dossierFor(id));
    expect(after?.last_verified).toBe("2026-07-02");
    expect((await dossiers.markDossierReviewed(id)).ok).toBe(false);
  });

  it("reads the buyer's saved searches as dated alerts", async () => {
    const id = await company("alerts");
    await pg.queryPg(
      `insert into crm_company_context_notes (id, company_id, note, category, source_kind, source_ref, observed_on)
       values ($1, $2, 'LFP packs under 60 kWh', 'saved_search', 'saved_search', 'saved_search:9', '2026-11-02')`,
      [`ccn_${suffix}_alerts`, id],
    );
    const dossier = await dossiers.getCompanyDossier(id);
    expect(dossier?.saved_searches).toEqual([
      {
        id: `ccn_${suffix}_alerts`,
        note: "LFP packs under 60 kWh",
        observed_on: "2026-11-02",
        source_kind: "saved_search",
        source_ref: "saved_search:9",
        source_url: null,
      },
    ]);
  });

  it("returns missing for a company that does not exist", async () => {
    expect((await dossiers.saveDossier(`co_missing_${suffix}`, dossierFor("x"), 0)).kind).toBe("missing");
    expect(await dossiers.getCompanyDossier(`co_missing_${suffix}`)).toBeNull();
  });
});
