import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SavedView, ViewTypeSettings } from "../object-filters";
import type * as Postgres from "../postgres";
import type * as Views from "./views";

// Runs only against a disposable database: scripts/rebattery/crm-test-db.sh up prints the URL.
const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

const buyers: SavedView = {
  name: "Buyers",
  view_type: "table",
  filters: {
    id: "root",
    conjunction: "and",
    rules: [{ id: "purpose", field: "Purpose", operator: "is_any_of", value: ["Buyer"] }],
  },
  sort: [{ field: "Full Name", direction: "asc" }],
  columns: ["Full Name", "Purpose", "Email"],
  column_widths: { "Full Name": 240, Email: 320 },
  settings: { listTitleField: "Full Name", galleryTitleField: "Full Name" },
};
const dismantlers: SavedView = {
  name: "Dismantlers",
  view_type: "table",
  filters: {
    id: "root",
    conjunction: "and",
    rules: [{ id: "purpose", field: "Purpose", operator: "is_any_of", value: ["Dismantler"] }],
  },
};
const settings: ViewTypeSettings = {
  column_widths: { "Full Name": 280 },
  kanbanField: "Purpose",
  kanbanHiddenColumns: ["Dismantler"],
  calendarMode: "week",
};

describe.skipIf(!TEST_URL)("postgres saved views", () => {
  let pg: typeof Postgres;
  let storage: typeof Views;
  let objectId: string;
  let objectName: string;
  let otherId: string;
  let otherName: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    // Import after setting the disposable URL: the Postgres module constructs its pool on load.
    pg = await import("../postgres");
    storage = await import("./views");
  });

  beforeEach(async () => {
    objectId = randomUUID();
    otherId = randomUUID();
    objectName = `saved_views_${objectId}`;
    otherName = `saved_views_${otherId}`;
    await pg.queryPg(
      "insert into crm_objects (id, name) values ($1, $2), ($3, $4)",
      [objectId, objectName, otherId, otherName],
    );
  });

  afterEach(async () => {
    await pg.queryPg("delete from crm_objects where id in ($1, $2)", [objectId, otherId]);
  });

  afterAll(async () => {
    await pg.pgPool.end();
  });

  it("round trips filters, columns, widths, sort and both saved and object settings", async () => {
    expect(await storage.getPostgresObjectViews(objectName)).toEqual({
      views: [], activeView: undefined, viewSettings: undefined,
    });
    expect(await storage.savePostgresObjectViews(objectName, [buyers, dismantlers], "Buyers", settings)).toBe(true);
    expect(await storage.getPostgresObjectViews(objectName)).toEqual({
      views: [buyers, dismantlers], activeView: "Buyers", viewSettings: settings,
    });
    // A changed saved filter is persisted, rather than reconstructed from default purpose views.
    const refined: SavedView = {
      ...buyers,
      filters: {
        ...buyers.filters!,
        rules: [...buyers.filters!.rules, { id: "email", field: "Email", operator: "is_not_empty" }],
      },
    };
    expect(await storage.savePostgresObjectViews(objectName, [refined], "Buyers", {})).toBe(true);
    expect(await storage.getPostgresObjectViews(objectName)).toEqual({
      views: [refined], activeView: "Buyers", viewSettings: {},
    });
  });

  it("deletes saved views and clears a deleted or unknown active selection", async () => {
    await storage.savePostgresObjectViews(objectName, [buyers, dismantlers], "Buyers", settings);
    expect(await storage.savePostgresObjectViews(objectName, [dismantlers], "Buyers")).toBe(true);
    expect(await storage.getPostgresObjectViews(objectName)).toEqual({
      views: [dismantlers], activeView: undefined, viewSettings: settings,
    });
    await storage.savePostgresObjectViews(objectName, [dismantlers], "Missing");
    expect((await storage.getPostgresObjectViews(objectName)).activeView).toBeUndefined();
    expect(await storage.savePostgresObjectViews(objectName, [], "Dismantlers")).toBe(true);
    expect(await storage.getPostgresObjectViews(objectName)).toEqual({
      views: [], activeView: undefined, viewSettings: settings,
    });
  });

  it("preserves omitted settings and replaces explicitly provided settings", async () => {
    await storage.savePostgresObjectViews(objectName, [buyers], "Buyers", settings);
    await storage.savePostgresObjectViews(objectName, [dismantlers], "Dismantlers");
    expect(await storage.getPostgresObjectViews(objectName)).toEqual({
      views: [dismantlers], activeView: "Dismantlers", viewSettings: settings,
    });
    const replacement: ViewTypeSettings = { timelineZoom: "quarter" };
    await storage.savePostgresObjectViews(objectName, [dismantlers], "Dismantlers", replacement);
    expect((await storage.getPostgresObjectViews(objectName)).viewSettings).toEqual(replacement);
    await storage.savePostgresObjectViews(objectName, [dismantlers], undefined, {});
    expect((await storage.getPostgresObjectViews(objectName)).viewSettings).toEqual({});
  });

  it("isolates objects and never reports success for an unregistered object", async () => {
    await storage.savePostgresObjectViews(objectName, [buyers], "Buyers", settings);
    expect(await storage.getPostgresObjectViews(otherName)).toEqual({
      views: [], activeView: undefined, viewSettings: undefined,
    });
    await storage.savePostgresObjectViews(otherName, [dismantlers], "Dismantlers");
    const unknownName = `unknown_${randomUUID()}`;
    expect(await storage.savePostgresObjectViews(unknownName, [buyers], "Buyers", settings)).toBe(false);
    expect(await storage.getPostgresObjectViews(unknownName)).toEqual({
      views: [], activeView: undefined, viewSettings: undefined,
    });
    expect(await storage.getPostgresObjectViews(objectName)).toEqual({
      views: [buyers], activeView: "Buyers", viewSettings: settings,
    });
    expect(await storage.getPostgresObjectViews(otherName)).toEqual({
      views: [dismantlers], activeView: "Dismantlers", viewSettings: undefined,
    });
    await pg.queryPg("delete from crm_objects where id = $1", [otherId]);
    expect(await pg.queryPg("select object_id from crm_object_views where object_id = $1", [otherId])).toEqual([]);
  });

  it("rejects malformed storage and stale active names without losing the previous state", async () => {
    await storage.savePostgresObjectViews(objectName, [buyers], "Buyers", settings);
    for (const invalidViews of [{ name: "Buyers" }, ["Buyers"], [{}], [{ name: 123 }]]) {
      await expect(pg.queryPg(
        "update crm_object_views set views = $2::jsonb where object_id = $1",
        [objectId, JSON.stringify(invalidViews)],
      )).rejects.toMatchObject({ code: "23514" });
    }
    await expect(pg.queryPg(
      "update crm_object_views set active_view = 'Missing' where object_id = $1", [objectId],
    )).rejects.toMatchObject({ code: "23514" });
    await expect(pg.queryPg(
      "update crm_object_views set view_settings = '[]'::jsonb where object_id = $1", [objectId],
    )).rejects.toMatchObject({ code: "23514" });
    expect(await storage.getPostgresObjectViews(objectName)).toEqual({
      views: [buyers], activeView: "Buyers", viewSettings: settings,
    });
  });
});
