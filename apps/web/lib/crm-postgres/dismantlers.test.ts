import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("dismantlers object", () => {
  let pg: typeof import("../postgres");
  let entries: typeof import("./entry-mutations");
  let objects: typeof import("./object-read");
  const suffix = Math.random().toString(36).slice(2, 8);

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    pg = await import("../postgres");
    entries = await import("./entry-mutations");
    objects = await import("./object-read");
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  const company = async (id: string) =>
    (await pg.queryPg<{ name: string; tags: string[] | null }>(
      "select name, tags from crm_companies where id = $1", [id],
    ))[0];
  const dismantler = async (id: string) =>
    (await pg.queryPg<{ name: string; company_id: string; stage: string; stage_since: string }>(
      "select name, company_id, stage, stage_since::text from crm_dismantlers where id = $1", [id],
    ))[0];

  it("creates a CRM company, tagged dismantler, for a new name", async () => {
    const { entryId } = await entries.createPostgresEntry("dismantler", { Name: `Synthetic Breakers ${suffix}` });
    const row = await dismantler(entryId);
    expect(row).toMatchObject({ stage: "Found" });
    expect(await company(row.company_id)).toEqual({ name: `Synthetic Breakers ${suffix}`, tags: ["dismantler"] });
  });

  it("links the existing company of the same name instead of duplicating it", async () => {
    await pg.queryPg("insert into crm_companies (id, name, tags) values ($1, $2, '{supplier}')",
      [`co-${suffix}`, `Existing ATF ${suffix}`]);
    const { entryId } = await entries.createPostgresEntry("dismantler", { Name: ` existing atf ${suffix} ` });
    expect((await dismantler(entryId)).company_id).toBe(`co-${suffix}`);
    expect((await company(`co-${suffix}`)).tags).toEqual(["supplier", "dismantler"]);
  });

  it("refuses a name shared by several companies", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ($1, $3), ($2, $3)",
      [`dup-a-${suffix}`, `dup-b-${suffix}`, `Twin Salvage ${suffix}`]);
    await expect(entries.createPostgresEntry("dismantler", { Name: `Twin Salvage ${suffix}` }))
      .rejects.toThrow(/Several CRM companies/);
  });

  it("takes the name from a picked company", async () => {
    await pg.queryPg("insert into crm_companies (id, name) values ($1, $2)", [`pick-${suffix}`, `Picked Motors ${suffix}`]);
    const { entryId } = await entries.createPostgresEntry("dismantler", { Company: `pick-${suffix}`, Stage: "Contacted" });
    expect(await dismantler(entryId)).toMatchObject({ name: `Picked Motors ${suffix}`, stage: "Contacted" });
  });

  it("resets the stage date only when the stage changes", async () => {
    const { entryId } = await entries.createPostgresEntry("dismantler", { Name: `Stage Clock ${suffix}` });
    await pg.queryPg("alter table crm_dismantlers disable trigger crm_dismantlers_link_company_trigger");
    await pg.queryPg("update crm_dismantlers set stage_since = '2026-01-01' where id = $1", [entryId]);
    await pg.queryPg("alter table crm_dismantlers enable trigger crm_dismantlers_link_company_trigger");

    await entries.updatePostgresEntry("dismantler", entryId, { "Next step": "Call about eBay" });
    expect((await dismantler(entryId)).stage_since).toBe("2026-01-01");
    await entries.updatePostgresEntry("dismantler", entryId, { Stage: "Onboarding" });
    expect((await dismantler(entryId)).stage_since).not.toBe("2026-01-01");
  });

  it("keeps due dates as plain YYYY-MM-DD, clears blanks and refuses bad dates", async () => {
    const { entryId } = await entries.createPostgresEntry("dismantler", { Name: `Due Dates ${suffix}`, "Next step due": "2026-10-08" });
    const due = async () => (await pg.queryPg<{ next_step_due: string | null }>(
      "select next_step_due from crm_dismantlers where id = $1", [entryId]))[0].next_step_due;
    expect(await due()).toBe("2026-10-08");
    await entries.updatePostgresEntry("dismantler", entryId, { "Next step due": "" });
    expect(await due()).toBeNull();
    await expect(entries.updatePostgresEntry("dismantler", entryId, { "Next step due": "2026-02-30" })).rejects.toThrow();
  });

  it("shows on the board with stage columns and company labels, and untags on delete", async () => {
    const { entryId } = await entries.createPostgresEntry("dismantler", { Name: `Board Card ${suffix}` });
    const data = await objects.getPostgresObjectData("dismantler", new URL("http://test/?path=dismantler"));
    expect(data.object.default_view).toBe("kanban");
    expect(data.fields.find((field) => field.name === "Stage")?.enum_values)
      .toEqual(["Found", "Contacted", "Onboarding", "Live", "Syncing", "Parked"]);
    const card = data.entries.find((entry) => entry.entry_id === entryId || entry.id === entryId);
    expect(card).toMatchObject({ Name: `Board Card ${suffix}`, Stage: "Found" });
    const companyId = (await dismantler(entryId)).company_id;
    expect(data.relationLabels.Company[companyId]).toBe(`Board Card ${suffix}`);

    await entries.deletePostgresEntry("dismantler", entryId);
    expect((await company(companyId)).tags).toEqual([]);
  });
});
