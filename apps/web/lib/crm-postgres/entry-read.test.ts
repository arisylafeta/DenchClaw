import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());

vi.mock("../postgres", () => ({
  queryPg,
}));

describe("postgres entry read", () => {
  beforeEach(() => {
    queryPg.mockReset();
    queryPg.mockImplementation(async (sql: string) => {
      if (sql.includes("from crm_objects") && sql.includes("where name = $1")) {
        const objectName = queryPg.mock.calls.at(-1)?.[1]?.[0];
        if (objectName === "task") return [{ id: "obj_task", name: "task", default_view: "kanban" }];
        return [{ id: "seed_obj_people_00000000000000", name: "people", default_view: "table" }];
      }
      if (sql.includes("from crm_fields") && sql.includes("left join crm_objects")) {
        return [
          { id: "title", name: "Title", type: "text", sort_order: 1 },
          { id: "status", name: "Status", type: "enum", sort_order: 2 },
        ];
      }
      if (sql.includes("from crm_relation_links")) {
        return [
          { field_name: "From", source_object_name: "email_message", source_object_id: "email_obj", source_entry_id: "m1", display_field: "Subject", label: "Hello" },
          { field_name: "From", source_object_name: "email_message", source_object_id: "email_obj", source_entry_id: "m1", display_field: "Subject", label: "Hello duplicate" },
          { field_name: "Participants", source_object_name: "calendar_event", source_object_id: "event_obj", source_entry_id: "e1", display_field: "Title", label: "Planning" },
        ];
      }
      if (sql.includes("from crm_custom_field_values")) {
        return [
          { entry_id: "t1", field_name: "Title", text_value: "Prepare investor deck" },
          { entry_id: "t1", field_name: "Status", text_value: "In Queue" },
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

  it("loads detail data for custom-value-only objects such as task", async () => {
    const { getPostgresEntryData } = await import("./entry-read");
    const data = await getPostgresEntryData("task", "t1");

    expect(data.object.name).toBe("task");
    expect(data.entry).toMatchObject({
      entry_id: "t1",
      Title: "Prepare investor deck",
      Status: "In Queue",
    });
  });
});
