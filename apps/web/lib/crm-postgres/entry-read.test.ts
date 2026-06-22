import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());

vi.mock("../postgres", () => ({
  queryPg,
}));

describe("postgres entry read", () => {
  beforeEach(() => {
    queryPg.mockReset();
    queryPg.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql.includes("from crm_objects") && sql.includes("where name = $1")) {
        const objectName = params?.[0] ?? queryPg.mock.calls.at(-1)?.[1]?.[0];
        if (objectName === "task") return [{ id: "obj_task", name: "task", default_view: "kanban" }];
        return [{ id: "seed_obj_people", name: "people", default_view: "table", display_field: "Full Name" }];
      }
      if (sql.includes("from information_schema.columns")) {
        return [
          { column_name: "id" },
          { column_name: "created_at" },
          { column_name: "updated_at" },
          { column_name: "full_name" },
          { column_name: "email" },
          { column_name: "company_id" },
        ];
      }
      if (sql.includes("from crm_fields") && sql.includes("left join crm_objects")) {
        return [
          { id: "f1", name: "Full Name", type: "text", canonical_column: "full_name", sort_order: 1 },
          { id: "f2", name: "Email", type: "email", canonical_column: "email", sort_order: 2 },
          { id: "f3", name: "Company", type: "relation", canonical_column: "company_id", related_object_id: "obj_company", related_object_name: "company", sort_order: 3 },
          { id: "f4", name: "Strength Score", type: "number", canonical_column: "strength_score", sort_order: 4 },
        ];
      }
      if (sql.includes("from crm_people")) {
        return [{ entry_id: "p1", created_at: "2026-01-01", updated_at: "2026-01-01", "Full Name": "Ada", Email: "ada@example.com", Company: "c1" }];
      }
      if (sql.includes("from crm_companies")) {
        return [{ id: "c1", name: "Acme", domain: "acme.test", website: null }];
      }
      if (sql.includes("from crm_relation_links")) {
        return [
          { field_name: "From", source_object_name: "email_message", source_object_id: "email_obj", source_entry_id: "m1", display_field: "Subject", label: "Hello" },
          { field_name: "From", source_object_name: "email_message", source_object_id: "email_obj", source_entry_id: "m1", display_field: "Subject", label: "Hello duplicate" },
          { field_name: "Participants", source_object_name: "calendar_event", source_object_id: "event_obj", source_entry_id: "e1", display_field: "Title", label: "Planning" },
        ];
      }
      return [];
    });
  });

  it("returns reverse relation links for one entry without broad scans", async () => {
    const { getReverseRelationsForEntry } = await import("./entry-read");
    const links = await getReverseRelationsForEntry("people", "p1");
    expect(links[0]).toMatchObject({ fieldName: "From", sourceObjectName: "email_message" });
  });

  it("groups reverse relations by source field and deduplicates canonical labels", async () => {
    const { getReverseRelationsForEntry } = await import("./entry-read");
    const links = await getReverseRelationsForEntry("people", "p1");

    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ fieldName: "From", sourceObjectName: "email_message", displayField: "Subject" });
    expect(links[0].links).toEqual([{ id: "m1", label: "Hello" }]);
    expect(links[1]).toMatchObject({ fieldName: "Participants", sourceObjectName: "calendar_event", displayField: "Title" });
  });

  describe("getPostgresEntryData", () => {
    it("returns the entry and filters out stale canonical fields", async () => {
      const { getPostgresEntryData } = await import("./entry-read");
      const data = await getPostgresEntryData("people", "p1");

      expect(data.entry.entry_id).toBe("p1");
      expect(data.fields.map((field) => field.name)).toEqual(["Full Name", "Email", "Company"]);
      expect(data.fields.some((field) => field.name === "Strength Score")).toBe(false);
      expect(data.effectiveDisplayField).toBe("Full Name");
      expect(data.relationLabels.Company.c1).toBe("Acme");
    });

    it("does not filter fields when the object has no backing table", async () => {
      // The task object has no supported Postgres table, so we cannot validate
      // canonical columns and must leave fields untouched.
      await expect(import("./entry-read").then(({ getPostgresEntryData }) => getPostgresEntryData("task", "t1")))
        .rejects.toThrow("Entry not found");
    });
  });
});
