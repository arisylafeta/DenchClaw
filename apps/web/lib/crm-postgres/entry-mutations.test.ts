import { beforeEach, describe, expect, it, vi } from "vitest";

const withPgTransaction = vi.hoisted(() => vi.fn());
let txQuery: ReturnType<typeof vi.fn>;
let sqlLog: string[];
let objectRow: { id: string; name: string; entity_table: string | null };
let fieldRows: Array<{ id: string; name: string; type: string; canonical_column: string | null; relationship_type?: string | null }>;
let canonicalEntryExists = true;

vi.mock("../postgres", () => ({
  withPgTransaction,
}));

function makeClient() {
  txQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    sqlLog.push(String(sql));
    if (sql.includes("from crm_objects") && sql.includes("where name = $1")) {
      return { rows: [objectRow] };
    }

    if (sql.includes("from crm_fields") && sql.includes("where object_id = $1")) {
      return { rows: fieldRows };
    }

    if (sql.includes("select id from") && sql.includes("where id = $1") && sql.includes("limit 1")) {
      return { rows: canonicalEntryExists ? [{ id: params?.[0] }] : [] };
    }

    if (sql.includes("delete from crm_documents")) {
      return { rows: [] };
    }

    if (sql.includes("delete from") && sql.includes("crm_people") && sql.includes("id = any($1::text[])")) {
      const ids = (params?.[0] as string[]) ?? [];
      return { rows: ids.map((id) => ({ id })) };
    }

    if (sql.includes("delete from") && sql.includes("crm_people") && sql.includes("where id = $1")) {
      return { rows: [] };
    }

    if (sql.includes("insert into") && sql.includes("crm_people")) {
      return { rows: [] };
    }

    if (sql.includes("update") && sql.includes("crm_people") && sql.includes("where id =")) {
      return { rows: [], rowCount: 1 };
    }

    // Junction tables
    if (sql.includes("delete from crm_email_thread_participants") || sql.includes("delete from crm_email_message_recipients") || sql.includes("delete from crm_calendar_event_attendees")) {
      return { rows: [] };
    }

    if (sql.includes("insert into crm_email_thread_participants") || sql.includes("insert into crm_email_message_recipients") || sql.includes("insert into crm_calendar_event_attendees")) {
      return { rows: [] };
    }

    return { rows: [] };
  });

  return { query: txQuery };
}

describe("crm-postgres entry mutations", () => {
  beforeEach(() => {
    vi.resetModules();
    objectRow = { id: "obj_people", name: "people", entity_table: "crm_people" };
    fieldRows = [
      { id: "f_name", name: "Full Name", type: "text", canonical_column: "full_name" },
    ];
    canonicalEntryExists = true;
    sqlLog = [];
    withPgTransaction.mockReset();
    withPgTransaction.mockImplementation(async (fn) => fn(makeClient()));
  });

  it("creates canonical values in the entity table", async () => {
    const { createPostgresEntry } = await import("./entry-mutations");
    const result = await createPostgresEntry("people", { "Full Name": "Ada" });

    expect(result.ok).toBe(true);
    expect(result.entryId).toBeTruthy();

    const queryCalls = txQuery.mock.calls;
    const insert = queryCalls.find(([sql]) => String(sql).includes("insert into") && String(sql).includes("crm_people"));
    expect(insert?.[0]).toContain("full_name");
  });

  it("updates many_to_many relation through junction tables", async () => {
    fieldRows = [{ id: "f_company", name: "Company", type: "relation", canonical_column: null, relationship_type: "many_to_many" }];
    const { updatePostgresEntry } = await import("./entry-mutations");
    const result = await updatePostgresEntry("people", "entry_1", { Company: ["c1", "c2"] });

    expect(result).toEqual({ ok: true, updatedCount: 1 });

    const queryCalls = txQuery.mock.calls.map(([sql]) => String(sql));
    // crm_relation_links is a VIEW; writes go through junction tables or canonical columns.
    expect(queryCalls.some((sql) => sql.includes("crm_relation_links"))).toBe(false);
  });

  it("deletes one entry with full cleanup and canonical row removal", async () => {
    const { deletePostgresEntry } = await import("./entry-mutations");
    const result = await deletePostgresEntry("people", "entry_1");

    expect(result).toEqual({ ok: true });

    const queryCalls = txQuery.mock.calls.map(([sql]) => String(sql));
    expect(queryCalls.some((sql) => sql.includes("delete from crm_email_thread_participants"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_email_message_recipients"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_calendar_event_attendees"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_documents"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from") && sql.includes("crm_people") && sql.includes("where id = $1"))).toBe(true);
  });

  it("bulk deletes entries and reports deleted count", async () => {
    const { bulkDeletePostgresEntries } = await import("./entry-mutations");
    const result = await bulkDeletePostgresEntries("people", ["e1", "e2"]);

    expect(result).toEqual({ ok: true, deletedCount: 2 });

    const queryCalls = txQuery.mock.calls.map(([sql]) => String(sql));
    expect(queryCalls.some((sql) => sql.includes("delete from crm_email_thread_participants") && sql.includes("any($1::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_email_message_recipients") && sql.includes("any($1::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_calendar_event_attendees") && sql.includes("any($1::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_documents") && sql.includes("entry_id = any($1::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from") && sql.includes("crm_people") && sql.includes("id = any($1::text[])"))).toBe(true);
  });

  it("uses inferred canonical table when entity_table is null for people", async () => {
    objectRow = { id: "obj_people", name: "people", entity_table: null };
    const { createPostgresEntry, updatePostgresEntry, deletePostgresEntry } = await import("./entry-mutations");

    await createPostgresEntry("people", { "Full Name": "Ada" });
    await updatePostgresEntry("people", "entry_1", { "Full Name": "Ada Lovelace" });
    await deletePostgresEntry("people", "entry_1");

    const sqlCalls = sqlLog;
    expect(sqlCalls.some((sql) => sql.includes("insert into") && sql.includes("crm_people"))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes("update") && sql.includes("crm_people") && sql.includes("where id ="))).toBe(true);
    expect(sqlCalls.some((sql) => sql.includes("delete from") && sql.includes("crm_people") && sql.includes("where id = $1"))).toBe(true);
  });

  it("rejects custom-only update when entry does not exist and writes no custom values", async () => {
    objectRow = { id: "obj_task", name: "task", entity_table: null };
    fieldRows = [{ id: "f_notes", name: "Notes", type: "text", canonical_column: null }];
    canonicalEntryExists = false;
    const { updatePostgresEntry } = await import("./entry-mutations");

    await expect(updatePostgresEntry("task", "missing_1", { Notes: "nope" })).rejects.toThrow("Entry not found: missing_1");
  });

  it("rejects mutations for loop monitoring projections", async () => {
    const { createPostgresEntry, updatePostgresEntry, deletePostgresEntry } = await import("./entry-mutations");

    await expect(createPostgresEntry("automation_loop", {})).rejects.toThrow("read-only");
    await expect(updatePostgresEntry("automation_loop_run", "activity-1", {})).rejects.toThrow("read-only");
    await expect(deletePostgresEntry("automation_loop", "loop-1")).rejects.toThrow("read-only");
    expect(withPgTransaction).not.toHaveBeenCalled();
  });

  it("updates canonical many_to_one relation field in canonical table only", async () => {
    fieldRows = [{ id: "f_company", name: "Company", type: "relation", canonical_column: "company_id", relationship_type: "many_to_one" }];
    const { updatePostgresEntry } = await import("./entry-mutations");

    const result = await updatePostgresEntry("people", "entry_1", { Company: ["c9", "c10"] });
    expect(result).toEqual({ ok: true, updatedCount: 1 });

    const calls = txQuery.mock.calls;
    const canonicalUpdate = calls.find(([sql]) => String(sql).includes("update") && String(sql).includes("crm_people"));
    expect(canonicalUpdate?.[0]).toContain("company_id");
    expect(canonicalUpdate?.[1]).toEqual(["c9", "entry_1"]);
    expect(calls.some(([sql]) => String(sql).includes("crm_relation_links"))).toBe(false);
  });
});
