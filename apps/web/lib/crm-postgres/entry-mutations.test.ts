import { beforeEach, describe, expect, it, vi } from "vitest";

const withPgTransaction = vi.hoisted(() => vi.fn());
let txQuery: ReturnType<typeof vi.fn>;

vi.mock("../postgres", () => ({
  withPgTransaction,
}));

vi.mock("../workspace", () => ({
  duckdbQueryAsync: vi.fn(() => {
    throw new Error("DuckDB should not be used");
  }),
}));

function makeClient() {
  txQuery = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("from crm_objects") && sql.includes("where name = $1")) {
      return { rows: [{ id: "obj_people", name: "people", entity_table: "crm_people" }] };
    }

    if (sql.includes("from crm_fields") && sql.includes("where object_id = $1")) {
      return {
        rows: [
          { id: "f_name", name: "Full Name", type: "text", canonical_column: "full_name" },
          { id: "f_notes", name: "Notes", type: "text", canonical_column: null },
          { id: "f_company", name: "Company", type: "relation", canonical_column: null, relationship_type: "many_to_many" },
        ],
      };
    }

    if (sql.includes("delete from crm_relation_links") && sql.includes("where field_id = $1 and source_entry_id = $2")) {
      return { rows: [] };
    }

    if (sql.includes("delete from crm_custom_field_values") && sql.includes("entry_id = any($1::text[])")) {
      return { rows: [] };
    }

    if (sql.includes("delete from crm_relation_links") && sql.includes("source_entry_id = any($1::text[])")) {
      return { rows: [] };
    }

    if (sql.includes("delete from crm_documents") || sql.includes("delete from crm_action_runs")) {
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

    if (sql.includes("insert into crm_custom_field_values") || sql.includes("update crm_custom_field_values")) {
      return { rows: [] };
    }

    if (sql.includes("insert into crm_relation_links")) {
      return { rows: [] };
    }

    return { rows: [] };
  });

  return { query: txQuery };
}

describe("crm-postgres entry mutations", () => {
  beforeEach(() => {
    vi.resetModules();
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

  it("creates custom scalar values in crm_custom_field_values", async () => {
    const { createPostgresEntry } = await import("./entry-mutations");
    const result = await createPostgresEntry("people", { Notes: "important" });

    expect(result.ok).toBe(true);

    const queryCalls = txQuery.mock.calls;
    const upsert = queryCalls.find(([sql]) => String(sql).includes("insert into crm_custom_field_values"));
    expect(upsert?.[0]).toContain("crm_custom_field_values");
  });

  it("updates relation links by replacing existing links and inserting with positions", async () => {
    const { updatePostgresEntry } = await import("./entry-mutations");
    const result = await updatePostgresEntry("people", "entry_1", { Company: ["c1", "c2"] });

    expect(result).toEqual({ ok: true, updatedCount: 1 });

    const queryCalls = txQuery.mock.calls;
    expect(queryCalls.some(([sql]) => String(sql).includes("delete from crm_relation_links") && String(sql).includes("field_id = $1"))).toBe(true);

    const inserts = queryCalls.filter(([sql]) => String(sql).includes("insert into crm_relation_links"));
    expect(inserts).toHaveLength(2);
    expect(inserts[0]?.[1]).toEqual(["obj_people", "f_company", "entry_1", "c1", 0]);
    expect(inserts[1]?.[1]).toEqual(["obj_people", "f_company", "entry_1", "c2", 1]);
  });

  it("deletes one entry with full cleanup and canonical row removal", async () => {
    const { deletePostgresEntry } = await import("./entry-mutations");
    const result = await deletePostgresEntry("people", "entry_1");

    expect(result).toEqual({ ok: true });

    const queryCalls = txQuery.mock.calls.map(([sql]) => String(sql));
    expect(queryCalls.some((sql) => sql.includes("delete from crm_custom_field_values"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_relation_links") && sql.includes("source_entry_id = $1"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_relation_links") && sql.includes("target_entry_id = $1"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_documents"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_action_runs"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from") && sql.includes("crm_people") && sql.includes("where id = $1"))).toBe(true);
  });

  it("bulk deletes entries and reports deleted count", async () => {
    const { bulkDeletePostgresEntries } = await import("./entry-mutations");
    const result = await bulkDeletePostgresEntries("people", ["e1", "e2"]);

    expect(result).toEqual({ ok: true, deletedCount: 2 });

    const queryCalls = txQuery.mock.calls.map(([sql]) => String(sql));
    expect(queryCalls.some((sql) => sql.includes("delete from crm_custom_field_values") && sql.includes("entry_id = any($2::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_relation_links") && sql.includes("source_entry_id = any($1::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_relation_links") && sql.includes("target_entry_id = any($1::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_documents") && sql.includes("entry_id = any($1::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from crm_action_runs") && sql.includes("entry_id = any($1::text[])"))).toBe(true);
    expect(queryCalls.some((sql) => sql.includes("delete from") && sql.includes("crm_people") && sql.includes("id = any($1::text[])"))).toBe(true);
  });
});
