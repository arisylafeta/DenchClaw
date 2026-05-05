# Migrate Remaining DuckDB API Paths To Postgres Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all remaining normal request-time CRM/workspace object APIs from DuckDB CLI helpers to Postgres when `CRM_DB_BACKEND=postgres`, while preserving DuckDB fallback behavior.

**Architecture:** Keep route handlers as thin backend switches. Add focused helpers under `apps/web/lib/crm-postgres/` for object metadata, entry mutations, fields, tree/search, activity, photos, enrichment, documents, actions, and SQL execution. Do not remove DuckDB fallback code until every Postgres path is covered and tested.

**Tech Stack:** Next.js route handlers, TypeScript, Vitest, `pg`, existing `queryPg`/`withPgTransaction`, existing CRM Postgres schema in `apps/web/lib/crm-postgres/schema.sql`.

---

## Current State

Already Postgres-gated:
- `GET /api/crm/people`
- `GET /api/crm/people/:id`
- `GET /api/crm/inbox`
- `GET /api/crm/inbox/:threadId`
- `GET /api/crm/calendar`
- `GET /api/crm/calendar/:id`
- `GET /api/crm/companies/:id`
- `GET /api/workspace/search-index`
- `GET /api/workspace/objects/:name`
- `GET /api/workspace/objects/:name/entries/:id`
- `GET/PUT /api/workspace/objects/:name/views`

Still requiring Postgres branches:
- `GET /api/crm/people/:id/activity`
- `POST /api/crm/enrich/:type/:id`
- `POST /api/crm/photos/sync`
- `GET /api/workspace/tree`
- `GET /api/workspace/suggest-files`
- `POST /api/workspace/objects`
- `POST /api/workspace/objects/:name/entries`
- `PATCH /api/workspace/objects/:name/entries/:id`
- `DELETE /api/workspace/objects/:name/entries/:id`
- `POST /api/workspace/objects/:name/entries/bulk-delete`
- `GET /api/workspace/objects/:name/entries/options`
- `GET/PUT /api/workspace/objects/:name/entries/:id/content`
- `POST /api/workspace/objects/:name/fields`
- `PATCH/DELETE /api/workspace/objects/:name/fields/:fieldId`
- `PATCH /api/workspace/objects/:name/fields/reorder`
- `PATCH /api/workspace/objects/:name/fields/:fieldId/enum-rename`
- `PATCH /api/workspace/objects/:name/display-field`
- `POST /api/workspace/objects/:name/enrich`
- `POST /api/workspace/objects/:name/actions`
- `GET /api/workspace/objects/:name/actions/runs`
- `POST /api/workspace/query`
- `POST /api/workspace/execute`
- `POST /api/workspace/reports/execute`
- `POST /api/workspace/db/query`
- `GET /api/workspace/db/introspect`
- `DELETE /api/workspace/file` object-folder cleanup path

## File Structure

Create:
- `apps/web/lib/crm-postgres/value-codec.ts`: convert API field values to `crm_custom_field_values` typed columns and parse relation IDs.
- `apps/web/lib/crm-postgres/object-metadata.ts`: shared Postgres object/field/status lookup, object creation, display field updates, field reorder.
- `apps/web/lib/crm-postgres/entry-mutations.ts`: create/update/delete/bulk-delete entries using canonical tables, custom values, and relation links.
- `apps/web/lib/crm-postgres/entry-options.ts`: relation dropdown options.
- `apps/web/lib/crm-postgres/tree.ts`: tree object discovery and projection targets from `crm_objects`.
- `apps/web/lib/crm-postgres/suggest-files.ts`: object and entry suggestions from Postgres.
- `apps/web/lib/crm-postgres/activity.ts`: person activity timeline from `crm_interactions` plus email/calendar hydration.
- `apps/web/lib/crm-postgres/enrich-target.ts`: person/company enrichment lookup.
- `apps/web/lib/crm-postgres/photos.ts`: avatar update helpers used by Google photo sync.
- `apps/web/lib/crm-postgres/documents.ts`: entry markdown document registry via `crm_documents`.
- `apps/web/lib/crm-postgres/actions.ts`: action config lookup and action run persistence.
- `apps/web/lib/crm-postgres/sql-execution.ts`: read-only Postgres SQL execution/introspection replacements.

Modify:
- `apps/web/app/api/crm/people/[id]/activity/route.ts`
- `apps/web/app/api/crm/enrich/[type]/[id]/route.ts`
- `apps/web/app/api/crm/photos/sync/route.ts`
- `apps/web/lib/gmail-photo-sync.ts`
- `apps/web/app/api/workspace/tree/route.ts`
- `apps/web/app/api/workspace/suggest-files/route.ts`
- `apps/web/app/api/workspace/objects/route.ts`
- `apps/web/app/api/workspace/objects/[name]/entries/route.ts`
- `apps/web/app/api/workspace/objects/[name]/entries/[id]/route.ts`
- `apps/web/app/api/workspace/objects/[name]/entries/bulk-delete/route.ts`
- `apps/web/app/api/workspace/objects/[name]/entries/options/route.ts`
- `apps/web/app/api/workspace/objects/[name]/entries/[id]/content/route.ts`
- `apps/web/app/api/workspace/objects/[name]/fields/route.ts`
- `apps/web/app/api/workspace/objects/[name]/fields/[fieldId]/route.ts`
- `apps/web/app/api/workspace/objects/[name]/fields/reorder/route.ts`
- `apps/web/app/api/workspace/objects/[name]/fields/[fieldId]/enum-rename/route.ts`
- `apps/web/app/api/workspace/objects/[name]/display-field/route.ts`
- `apps/web/app/api/workspace/objects/[name]/enrich/route.ts`
- `apps/web/app/api/workspace/objects/[name]/actions/route.ts`
- `apps/web/app/api/workspace/objects/[name]/actions/runs/route.ts`
- `apps/web/app/api/workspace/query/route.ts`
- `apps/web/app/api/workspace/execute/route.ts`
- `apps/web/app/api/workspace/reports/execute/route.ts`
- `apps/web/app/api/workspace/db/query/route.ts`
- `apps/web/app/api/workspace/db/introspect/route.ts`
- `apps/web/app/api/workspace/file/route.ts`

Test files:
- Add or update route tests beside each migrated route.
- Add focused helper tests under `apps/web/lib/crm-postgres/*.test.ts`.

---

### Task 1: Shared Postgres Value Codec

**Files:**
- Create: `apps/web/lib/crm-postgres/value-codec.ts`
- Test: `apps/web/lib/crm-postgres/value-codec.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it } from "vitest";
import { parseRelationIds, toCustomValueColumns } from "./value-codec";

describe("crm-postgres value-codec", () => {
  it("maps text-like fields to text_value", () => {
    expect(toCustomValueColumns("email", "a@example.com")).toEqual({
      text_value: "a@example.com",
      number_value: null,
      boolean_value: null,
      date_value: null,
      json_value: null,
    });
  });

  it("maps number, boolean, date, and json values", () => {
    expect(toCustomValueColumns("number", "42").number_value).toBe(42);
    expect(toCustomValueColumns("boolean", "true").boolean_value).toBe(true);
    expect(toCustomValueColumns("date", "2026-05-05T00:00:00.000Z").date_value).toBe("2026-05-05T00:00:00.000Z");
    expect(toCustomValueColumns("tags", ["a", "b"]).json_value).toEqual(["a", "b"]);
  });

  it("parses relation ids from scalar and json-array values", () => {
    expect(parseRelationIds("p1")).toEqual(["p1"]);
    expect(parseRelationIds('["p1","p2"]')).toEqual(["p1", "p2"]);
    expect(parseRelationIds(["p1", "p2"])).toEqual(["p1", "p2"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/crm-postgres/value-codec.test.ts`

Expected: FAIL because `value-codec.ts` does not exist.

- [ ] **Step 3: Implement minimal codec**

```ts
export type CustomValueColumns = {
  text_value: string | null;
  number_value: number | null;
  boolean_value: boolean | null;
  date_value: string | null;
  json_value: unknown | null;
};

const textTypes = new Set(["text", "richtext", "email", "phone", "url", "enum", "file", "action"]);

export function parseRelationIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (typeof value !== "string") return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
    } catch {
      return [];
    }
  }
  return [trimmed];
}

export function relationStorageValue(ids: string[], relationshipType?: string | null): string | null {
  if (ids.length === 0) return null;
  return relationshipType === "many_to_many" ? JSON.stringify(ids) : ids[0];
}

export function toCustomValueColumns(fieldType: string, value: unknown): CustomValueColumns {
  const empty: CustomValueColumns = { text_value: null, number_value: null, boolean_value: null, date_value: null, json_value: null };
  if (value == null || value === "") return empty;
  if (fieldType === "number") return { ...empty, number_value: Number(value) };
  if (fieldType === "boolean") return { ...empty, boolean_value: value === true || value === "true" };
  if (fieldType === "date") return { ...empty, date_value: String(value) };
  if (fieldType === "relation" || fieldType === "tags") return { ...empty, json_value: Array.isArray(value) ? value : parseRelationIds(value) };
  if (textTypes.has(fieldType)) return { ...empty, text_value: String(value) };
  return { ...empty, text_value: typeof value === "string" ? value : JSON.stringify(value) };
}
```

- [ ] **Step 4: Verify**

Run: `npm test -- lib/crm-postgres/value-codec.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web/lib/crm-postgres/value-codec.ts apps/web/lib/crm-postgres/value-codec.test.ts && git commit -m "test: add postgres crm value codec"`

---

### Task 2: Shared Postgres Object Metadata Helpers

**Files:**
- Create: `apps/web/lib/crm-postgres/object-metadata.ts`
- Test: `apps/web/lib/crm-postgres/object-metadata.test.ts`

- [ ] **Step 1: Write failing tests**

Mock `queryPg` and `withPgTransaction`; prove helpers use `crm_objects`, `crm_fields`, and never import workspace DuckDB helpers.

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../postgres", () => ({
  queryPg: vi.fn(),
  withPgTransaction: vi.fn(async (fn) => fn({ query: vi.fn(async () => ({ rows: [] })) })),
}));

describe("crm-postgres object metadata", () => {
  beforeEach(() => vi.resetModules());

  it("loads an object by name from crm_objects", async () => {
    const postgres = await import("../postgres");
    vi.mocked(postgres.queryPg).mockResolvedValueOnce([{ id: "obj1", name: "people", display_field: "Full Name" }]);
    const { getPostgresObjectByName } = await import("./object-metadata");
    await expect(getPostgresObjectByName("people")).resolves.toMatchObject({ id: "obj1" });
    expect(postgres.queryPg).toHaveBeenCalledWith(expect.stringContaining("from crm_objects"), ["people"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/crm-postgres/object-metadata.test.ts`

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement helpers**

Create exports:
- `getPostgresObjectByName(name)`
- `getPostgresFields(objectId)`
- `getPostgresStatuses(objectId)`
- `resolvePostgresDisplayField(object, fields)`
- `createPostgresObject(input)`
- `updatePostgresDisplayField(objectName, displayField)`
- `reorderPostgresFields(objectName, fieldOrder)`

Use `queryPg` for reads and `withPgTransaction` for mutations.

- [ ] **Step 4: Verify**

Run: `npm test -- lib/crm-postgres/object-metadata.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web/lib/crm-postgres/object-metadata.ts apps/web/lib/crm-postgres/object-metadata.test.ts && git commit -m "feat: add postgres object metadata helpers"`

---

### Task 3: Postgres Entry Mutation Helpers

**Files:**
- Create: `apps/web/lib/crm-postgres/entry-mutations.ts`
- Test: `apps/web/lib/crm-postgres/entry-mutations.test.ts`

- [ ] **Step 1: Write failing tests**

Test behavior:
- `createPostgresEntry("people", { "Full Name": "Ada" })` inserts into `crm_people` when object has `entity_table = 'crm_people'`.
- Custom fields insert into `crm_custom_field_values`.
- Relation fields replace `crm_relation_links` for that field/source pair.
- Delete removes canonical table row or custom values/relation links for custom objects.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/crm-postgres/entry-mutations.test.ts`

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement helpers**

Create exports:
- `createPostgresEntry(objectName, fields)` returns `{ entryId, ok: true }`.
- `updatePostgresEntry(objectName, entryId, fields)` returns `{ ok: true, updatedCount }`.
- `deletePostgresEntry(objectName, entryId)` returns `{ ok: true }`.
- `bulkDeletePostgresEntries(objectName, entryIds)` returns `{ ok: true, deletedCount }`.

Implementation rules:
- Use `crm_objects.entity_table` and `crm_fields.canonical_column` to decide canonical versus custom storage.
- For canonical fields, update the canonical table column.
- For non-canonical scalar fields, upsert `crm_custom_field_values` using `toCustomValueColumns`.
- For relation fields, delete existing `crm_relation_links` for `(field_id, source_entry_id)` and insert one row per parsed target id with `position`.
- On delete, delete from the canonical table if `entity_table` exists; otherwise delete from `crm_custom_field_values`, `crm_relation_links`, `crm_documents`, and `crm_action_runs` by entry id.

- [ ] **Step 4: Verify**

Run: `npm test -- lib/crm-postgres/entry-mutations.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web/lib/crm-postgres/entry-mutations.ts apps/web/lib/crm-postgres/entry-mutations.test.ts && git commit -m "feat: add postgres entry mutations"`

---

### Task 4: Migrate Object and Entry Mutation Routes

**Files:**
- Modify: `apps/web/app/api/workspace/objects/route.ts`
- Modify: `apps/web/app/api/workspace/objects/[name]/entries/route.ts`
- Modify: `apps/web/app/api/workspace/objects/[name]/entries/[id]/route.ts`
- Modify: `apps/web/app/api/workspace/objects/[name]/entries/bulk-delete/route.ts`
- Test: existing and new route tests under `apps/web/app/api/workspace/objects*.test.ts`

- [ ] **Step 1: Add failing route tests**

For each route, set `process.env.CRM_DB_BACKEND = "postgres"`, mock the new helper, and assert DuckDB helper imports are not called.

Example for `POST /api/workspace/objects/:name/entries`:

```ts
it("uses Postgres entry creation when CRM_DB_BACKEND is postgres", async () => {
  process.env.CRM_DB_BACKEND = "postgres";
  const mutations = await import("@/lib/crm-postgres/entry-mutations");
  vi.mocked(mutations.createPostgresEntry).mockResolvedValue({ entryId: "e1", ok: true });
  const route = await import("./objects/[name]/entries/route");
  const res = await route.POST(new Request("http://test", { method: "POST", body: JSON.stringify({ fields: { Name: "Ada" } }) }), { params: Promise.resolve({ name: "people" }) });
  await expect(res.json()).resolves.toMatchObject({ entryId: "e1", ok: true });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/api/workspace/objects.test.ts app/api/workspace/objects/[name]/entries/[id]/route.test.ts`

Expected: FAIL because routes still call DuckDB.

- [ ] **Step 3: Add Postgres branches**

At the top of each mutating handler, after validation and body parsing, add:

```ts
if (process.env.CRM_DB_BACKEND === "postgres") {
  const data = await createPostgresEntry(name, body.fields ?? {});
  return Response.json(data, { status: 201 });
}
```

Use the corresponding helper for update/delete/bulk delete/object create. Leave existing DuckDB code unchanged below the branch.

- [ ] **Step 4: Verify**

Run: `npm test -- app/api/workspace/objects.test.ts app/api/workspace/objects/[name]/entries/[id]/route.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web/app/api/workspace/objects apps/web/lib/crm-postgres && git commit -m "feat: route object mutations through postgres"`

---

### Task 5: Postgres Field Mutation Helpers and Routes

**Files:**
- Extend: `apps/web/lib/crm-postgres/object-metadata.ts`
- Modify field routes listed below.
- Tests: `apps/web/app/api/workspace/objects/[name]/fields/[fieldId]/route.test.ts` plus new route tests as needed.

Routes:
- `POST /api/workspace/objects/:name/fields`
- `PATCH/DELETE /api/workspace/objects/:name/fields/:fieldId`
- `PATCH /api/workspace/objects/:name/fields/reorder`
- `PATCH /api/workspace/objects/:name/fields/:fieldId/enum-rename`
- `PATCH /api/workspace/objects/:name/display-field`

- [ ] **Step 1: Add failing tests**

Each route test should set `CRM_DB_BACKEND=postgres`, mock the new metadata helper, and assert the response shape matches existing DuckDB behavior.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/api/workspace/objects/[name]/fields/[fieldId]/route.test.ts`

Expected: FAIL before route branches exist.

- [ ] **Step 3: Implement helpers**

Add exports:
- `createPostgresField(objectName, body)`
- `updatePostgresField(objectName, fieldId, body)`
- `deletePostgresField(objectName, fieldId)`
- `renamePostgresEnumValue(objectName, fieldId, oldValue, newValue)`

Rules:
- Field rows live in `crm_fields`.
- Do not recreate pivot views in Postgres.
- For enum renames, update `crm_fields.enum_values` and update matching `crm_custom_field_values.text_value` for that field.

- [ ] **Step 4: Add route branches**

Pattern:

```ts
if (process.env.CRM_DB_BACKEND === "postgres") {
  const data = await createPostgresField(name, body);
  return Response.json(data, { status: 201 });
}
```

- [ ] **Step 5: Verify**

Run: `npm test -- app/api/workspace/objects/[name]/fields/[fieldId]/route.test.ts && npx tsc --noEmit`

Expected: PASS and no type errors.

- [ ] **Step 6: Commit**

Run: `git add apps/web/app/api/workspace/objects/[name]/fields apps/web/app/api/workspace/objects/[name]/display-field apps/web/lib/crm-postgres/object-metadata.ts && git commit -m "feat: route field mutations through postgres"`

---

### Task 6: Postgres Tree and Suggest Files

**Files:**
- Create: `apps/web/lib/crm-postgres/tree.ts`
- Create: `apps/web/lib/crm-postgres/suggest-files.ts`
- Modify: `apps/web/app/api/workspace/tree/route.ts`
- Modify: `apps/web/app/api/workspace/suggest-files/route.ts`
- Test: `apps/web/app/api/workspace/tree-browse.test.ts`

- [ ] **Step 1: Add failing tests**

Add tests proving Postgres mode does not call `duckdbQueryAllAsync`, `discoverDuckDBPaths`, or `duckdbQueryOnFileAsync` for tree/suggestions.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/api/workspace/tree-browse.test.ts`

Expected: FAIL for new assertions.

- [ ] **Step 3: Implement helpers**

`tree.ts` exports `loadPostgresTreeObjects()` returning `Map<string, DbObject>` from:

```sql
select id, name, description, default_view
from crm_objects
where hidden_in_sidebar = false
order by sort_order, name
```

`suggest-files.ts` exports:
- `searchPostgresObjects(query, max)` from `crm_objects`.
- `searchPostgresEntries(query, max)` using canonical tables for known objects and `crm_custom_field_values` for custom objects.

- [ ] **Step 4: Add route branches**

In `tree/route.ts`, replace `const dbObjects = await loadDbObjects();` with backend switch.

In `suggest-files/route.ts`, switch `searchObjects`/`searchEntries` to Postgres helpers when `CRM_DB_BACKEND=postgres`.

- [ ] **Step 5: Verify**

Run: `npm test -- app/api/workspace/tree-browse.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add apps/web/app/api/workspace/tree/route.ts apps/web/app/api/workspace/suggest-files/route.ts apps/web/lib/crm-postgres/tree.ts apps/web/lib/crm-postgres/suggest-files.ts && git commit -m "feat: route workspace tree search through postgres"`

---

### Task 7: CRM Activity and Enrichment Lookup

**Files:**
- Create: `apps/web/lib/crm-postgres/activity.ts`
- Create: `apps/web/lib/crm-postgres/enrich-target.ts`
- Modify: `apps/web/app/api/crm/people/[id]/activity/route.ts`
- Modify: `apps/web/app/api/crm/enrich/[type]/[id]/route.ts`
- Tests: add route tests beside each route.

- [ ] **Step 1: Write failing tests**

Tests:
- Activity route uses `getPostgresPersonActivity` when `CRM_DB_BACKEND=postgres`.
- Enrich target route uses `getPostgresEnrichmentTarget` when `CRM_DB_BACKEND=postgres`.
- DuckDB helper `safeQuery` is not called in Postgres mode.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/api/crm/people/[id]/activity/route.test.ts app/api/crm/enrich/[type]/[id]/route.test.ts`

Expected: FAIL because tests/routes do not exist or route still uses DuckDB.

- [ ] **Step 3: Implement activity helper**

Use `crm_interactions` as the primary table:

```sql
select i.id, i.type, i.direction, i.occurred_at, i.email_message_id, i.calendar_event_id,
       m.thread_id, m.subject, m.body_preview, m.from_person_id,
       e.title, e.start_at, e.end_at, e.meeting_type
from crm_interactions i
left join crm_email_messages m on m.id = i.email_message_id
left join crm_calendar_events e on e.id = i.calendar_event_id
where i.person_id = $1
order by i.occurred_at desc nulls last
limit $2 offset $3
```

Hydrate `m.from_person_id` from `crm_people`.

- [ ] **Step 4: Implement enrichment target helper**

For `people`, read `crm_people.email`. For `company`, read `crm_companies.domain`.

- [ ] **Step 5: Add route branches and verify**

Run: `npm test -- app/api/crm/people/[id]/activity/route.test.ts app/api/crm/enrich/[type]/[id]/route.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add apps/web/app/api/crm/people/[id]/activity apps/web/app/api/crm/enrich apps/web/lib/crm-postgres/activity.ts apps/web/lib/crm-postgres/enrich-target.ts && git commit -m "feat: route crm activity through postgres"`

---

### Task 8: Google Photo Sync Writes Through Postgres

**Files:**
- Create: `apps/web/lib/crm-postgres/photos.ts`
- Modify: `apps/web/lib/gmail-photo-sync.ts`
- Modify: `apps/web/app/api/crm/photos/sync/route.ts` only if needed.
- Test: add `apps/web/lib/gmail-photo-sync.test.ts` or extend existing tests.

- [ ] **Step 1: Write failing tests**

Test that when `CRM_DB_BACKEND=postgres`, photo sync reads people from `crm_people` and updates `crm_people.avatar_url`, not DuckDB `entry_fields`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- lib/gmail-photo-sync.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement Postgres helpers**

Exports:
- `getPostgresPhotoSyncPeople()` returns `{ id, email, avatar_url }[]`.
- `updatePostgresAvatarUrls(updates)` batches updates inside `withPgTransaction`.

- [ ] **Step 4: Branch inside sync**

Inside `syncGooglePhotos`, switch the data read/write helpers based on `CRM_DB_BACKEND` while preserving existing Google API logic.

- [ ] **Step 5: Verify**

Run: `npm test -- lib/gmail-photo-sync.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add apps/web/lib/gmail-photo-sync.ts apps/web/lib/crm-postgres/photos.ts apps/web/lib/gmail-photo-sync.test.ts && git commit -m "feat: route crm photo sync through postgres"`

---

### Task 9: Entry Content and Document Registry

**Files:**
- Create: `apps/web/lib/crm-postgres/documents.ts`
- Modify: `apps/web/app/api/workspace/objects/[name]/entries/[id]/content/route.ts`
- Test: `apps/web/app/api/workspace/objects/[name]/entries/[id]/content/route.test.ts`

- [ ] **Step 1: Add failing tests**

Postgres mode should:
- Resolve object id from `crm_objects`.
- Verify entry exists in canonical table or `crm_custom_field_values`.
- Read/write `crm_documents` instead of DuckDB `documents`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/api/workspace/objects/[name]/entries/[id]/content/route.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement documents helper**

Exports:
- `resolvePostgresEntryDocument(objectName, entryId)`.
- `verifyPostgresEntryExists(objectName, entryId)`.
- `registerPostgresEntryDocument(objectName, entryId, resolved)`.

Use `crm_documents` columns already present in schema.

- [ ] **Step 4: Add route branches**

Preserve filesystem markdown read/write behavior; replace only DB context/document registry reads/writes in Postgres mode.

- [ ] **Step 5: Verify**

Run: `npm test -- app/api/workspace/objects/[name]/entries/[id]/content/route.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add apps/web/app/api/workspace/objects/[name]/entries/[id]/content/route.ts apps/web/lib/crm-postgres/documents.ts && git commit -m "feat: route entry documents through postgres"`

---

### Task 10: Object Enrichment and Actions

**Files:**
- Create: `apps/web/lib/crm-postgres/actions.ts`
- Modify: `apps/web/app/api/workspace/objects/[name]/enrich/route.ts`
- Modify: `apps/web/app/api/workspace/objects/[name]/actions/route.ts`
- Modify: `apps/web/app/api/workspace/objects/[name]/actions/runs/route.ts`
- Test: existing enrich route test plus new action route tests.

- [ ] **Step 1: Add failing tests**

Tests:
- Enrich route loads entries/input fields from Postgres when backend is Postgres.
- Actions route loads action field config and entry contexts from Postgres.
- Action run persistence writes to `crm_action_runs`.
- Action runs route reads from `crm_action_runs`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/api/workspace/objects/[name]/enrich/route.test.ts`

Expected: FAIL for new Postgres expectations.

- [ ] **Step 3: Implement actions helper**

Exports:
- `getPostgresActionConfig(objectName, fieldId, actionId)`.
- `getPostgresActionContexts(objectName, entryIds)`.
- `persistPostgresActionRun(run)`.
- `getPostgresActionRuns(objectName, filters)`.

- [ ] **Step 4: Migrate enrich route**

Add a Postgres branch that uses `crm_fields`, canonical tables, and `crm_custom_field_values` to select entries and update the enrichment field after Apollo returns a value.

- [ ] **Step 5: Verify**

Run: `npm test -- app/api/workspace/objects/[name]/enrich/route.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add apps/web/app/api/workspace/objects/[name]/enrich apps/web/app/api/workspace/objects/[name]/actions apps/web/lib/crm-postgres/actions.ts && git commit -m "feat: route object actions through postgres"`

---

### Task 11: SQL Query, Report, DB Query, and Introspection Routes

**Files:**
- Create: `apps/web/lib/crm-postgres/sql-execution.ts`
- Modify: `apps/web/app/api/workspace/query/route.ts`
- Modify: `apps/web/app/api/workspace/execute/route.ts`
- Modify: `apps/web/app/api/workspace/reports/execute/route.ts`
- Modify: `apps/web/app/api/workspace/db/query/route.ts`
- Modify: `apps/web/app/api/workspace/db/introspect/route.ts`
- Test: `apps/web/app/api/workspace/db.test.ts`

- [ ] **Step 1: Add failing tests**

Postgres mode should use `queryPg` for generic workspace SQL routes and never call DuckDB helpers. For `db/query` and `db/introspect`, keep DuckDB behavior when a user explicitly selected a `.duckdb` file; use Postgres only when the selected path is the active workspace DB abstraction or when no file-specific path is needed.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- app/api/workspace/db.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement SQL execution helper**

Exports:
- `postgresReadOnlyQuery(sql)` with the same SELECT/PRAGMA/SHOW safety restrictions translated for Postgres.
- `introspectPostgresCrm()` querying `information_schema.tables` and `information_schema.columns` for `crm_%` tables.

- [ ] **Step 4: Add route branches**

Use Postgres branches for `workspace/query`, `workspace/execute`, and `reports/execute` when `CRM_DB_BACKEND=postgres`. Preserve DuckDB file-specific behavior for explicit database file tools unless product decision says those routes should query the app Postgres DB.

- [ ] **Step 5: Verify**

Run: `npm test -- app/api/workspace/db.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 6: Commit**

Run: `git add apps/web/app/api/workspace/query/route.ts apps/web/app/api/workspace/execute/route.ts apps/web/app/api/workspace/reports/execute/route.ts apps/web/app/api/workspace/db apps/web/lib/crm-postgres/sql-execution.ts && git commit -m "feat: route workspace sql tools through postgres"`

---

### Task 12: File Delete Object Cleanup

**Files:**
- Modify: `apps/web/app/api/workspace/file/route.ts`
- Test: `apps/web/app/api/workspace/file-ops.test.ts`

- [ ] **Step 1: Add failing test**

When `CRM_DB_BACKEND=postgres`, deleting an object folder should not call `findDuckDBForObjectAsync`, `duckdbPathAsync`, or `duckdbExecOnFileAsync`.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- app/api/workspace/file-ops.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement Postgres cleanup**

In Postgres mode, object folder deletion does not need pivot view cleanup. Optionally clear or soft-hide the object row only if existing product behavior deletes object metadata; otherwise return `{ ok: true }` from cleanup.

- [ ] **Step 4: Verify**

Run: `npm test -- app/api/workspace/file-ops.test.ts && npx tsc --noEmit`

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web/app/api/workspace/file/route.ts apps/web/app/api/workspace/file-ops.test.ts && git commit -m "fix: skip duckdb cleanup in postgres file delete"`

---

### Task 13: End-to-End DuckDB Audit Test

**Files:**
- Create: `apps/web/app/api/postgres-backend-duckdb-regression.test.ts`

- [ ] **Step 1: Write failing audit tests**

Create a test that imports every migrated route in Postgres mode, mocks `@/lib/workspace` DuckDB helpers as throwing functions, and verifies the Postgres branch returns a mocked response without touching DuckDB.

- [ ] **Step 2: Run test to verify failures are meaningful**

Run: `npm test -- app/api/postgres-backend-duckdb-regression.test.ts`

Expected: FAIL for any route not yet migrated.

- [ ] **Step 3: Fix route misses**

For every failing route, add the missing Postgres branch at the top of the handler after input validation.

- [ ] **Step 4: Verify full targeted suite**

Run:

```bash
npm test -- \
  app/api/postgres-backend-duckdb-regression.test.ts \
  app/api/workspace/tree-browse.test.ts \
  app/api/workspace/objects.test.ts \
  app/api/workspace/objects/[name]/route.test.ts \
  app/api/workspace/objects/[name]/entries/[id]/route.test.ts \
  app/api/workspace/objects/[name]/entries/[id]/content/route.test.ts \
  app/api/workspace/objects/[name]/fields/[fieldId]/route.test.ts \
  app/api/workspace/db.test.ts \
  app/api/workspace/file-ops.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

Run: `git add apps/web/app/api/postgres-backend-duckdb-regression.test.ts && git commit -m "test: guard postgres backend from duckdb route calls"`

---

### Task 14: Final Verification and Benchmark

**Files:**
- No source changes expected unless verification finds misses.

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`

Expected: exit code 0.

- [ ] **Step 2: Run full tests**

Run: `npm test`

Expected: all tests pass.

- [ ] **Step 3: Run DuckDB grep audit**

Run:

```bash
rg -n "duckdb(Query|Exec|Path)|findDuckDB|discoverDuckDB|duckdbQueryAsync|duckdbExecAsync" app/api lib --glob '*.ts'
```

Expected: Remaining matches are either:
- DuckDB fallback branches below `CRM_DB_BACKEND !== "postgres"` checks.
- Explicit database-file tools intentionally querying selected `.duckdb` files.
- Migration/import scripts like `crm-postgres/migrate-duckdb.ts`.

- [ ] **Step 4: Benchmark representative endpoints**

Benchmark these route handlers in `CRM_DB_BACKEND=postgres` mode:
- `GET /api/workspace/tree`
- `GET /api/workspace/suggest-files?q=a`
- `GET /api/crm/people/:id/activity`
- `POST /api/workspace/objects/:name/entries`
- `PATCH /api/workspace/objects/:name/entries/:id`
- `GET /api/workspace/objects/:name/entries/options`

Expected: no DuckDB CLI process logs/errors; warm latencies should be in milliseconds or low tens of milliseconds for typical local data.

- [ ] **Step 5: Commit final fixes**

Run: `git add . && git commit -m "chore: verify postgres backend migration"`

---

## Self-Review

Spec coverage:
- Every route identified in the audit is assigned to a task.
- Shared storage concerns are handled before route migration.
- Tests are required before each implementation group.

Known scope decisions:
- DuckDB fallback remains for non-Postgres mode.
- Explicit user-selected database file routes may keep DuckDB for `.duckdb` file inspection even after app CRM APIs move to Postgres.
- Pivot view regeneration is not needed in Postgres.

Residual risks:
- Existing Postgres schema may need additional indexes after real benchmark runs.
- `crm_fields.canonical_column` coverage must be correct for canonical object mutation routes.
- Field mutation behavior must be checked carefully for canonical columns because renaming a canonical field should not rename a physical Postgres column.
