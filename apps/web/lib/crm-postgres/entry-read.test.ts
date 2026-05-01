import { beforeEach, describe, expect, it, vi } from "vitest";

const queryPg = vi.hoisted(() => vi.fn());

vi.mock("../postgres", () => ({
  queryPg,
}));

describe("postgres entry read", () => {
  beforeEach(() => {
    queryPg.mockReset();
    queryPg.mockImplementation(async (sql: string) => {
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
});
