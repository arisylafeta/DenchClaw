import { beforeEach, describe, expect, it, vi } from "vitest";

const withPgTransaction = vi.hoisted(() => vi.fn());
vi.mock("../postgres", () => ({ withPgTransaction }));

const ARI = "11111111-1111-4111-8111-111111111111";
const ALEX = "22222222-2222-4222-8222-222222222222";
let query: ReturnType<typeof vi.fn>;

function client(entryVisible = true) {
  query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("from crm_objects")) {
      return {
        rows: [
          {
            id: "work-task-object",
            name: "work_task",
            entity_table: "work_tasks",
          },
        ],
      };
    }
    if (sql.includes("from crm_fields")) {
      return {
        rows: [
          {
            id: "title",
            object_id: "work-task-object",
            name: "Title",
            type: "text",
            canonical_column: "title",
          },
          {
            id: "assignee",
            object_id: "work-task-object",
            name: "Assignee",
            type: "relation",
            canonical_column: "assignee_id",
            relationship_type: "many_to_one",
          },
        ],
      };
    }
    if (sql.includes("select id from") && sql.includes("work_tasks")) {
      return { rows: entryVisible ? [{ id: params?.[0] }] : [] };
    }
    return { rows: [], rowCount: 1 };
  });
  return { query };
}

describe("Work Task authorization", () => {
  beforeEach(() => {
    vi.resetModules();
    withPgTransaction.mockReset();
    withPgTransaction.mockImplementation(async (fn) => fn(client()));
  });

  it("forces normal creation to the authenticated user", async () => {
    const { createPostgresEntry } = await import("./entry-mutations");
    await createPostgresEntry("work_task", { Title: "Scoped task" }, ARI);
    const insert = query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("insert into") &&
        String(sql).includes("work_tasks"),
    );
    expect(insert?.[0]).toContain('"assignee_id"');
    expect(insert?.[1]).toContain(ARI);
  });

  it("rejects creation or reassignment to another user", async () => {
    const { createPostgresEntry, updatePostgresEntry } = await import(
      "./entry-mutations"
    );
    await expect(
      createPostgresEntry("work_task", { Title: "Wrong", Assignee: ALEX }, ARI),
    ).rejects.toThrow("authenticated user");
    await expect(
      updatePostgresEntry("work_task", "task-alex", { Assignee: ALEX }, ARI),
    ).rejects.toThrow("cannot be changed");
    await expect(
      updatePostgresEntry("work_task", "task-ari", { Assignee: "" }, ARI),
    ).rejects.toThrow("cannot be changed");
  });

  it("uses the authenticated assignee predicate for detail mutations", async () => {
    withPgTransaction.mockImplementation(async (fn) => fn(client(false)));
    const { deletePostgresEntry } = await import("./entry-mutations");
    await expect(
      deletePostgresEntry("work_task", "task-alex", ARI),
    ).rejects.toThrow("Entry not found");
    const existence = query.mock.calls.find(
      ([sql]) =>
        String(sql).includes("select id from") &&
        String(sql).includes("work_tasks"),
    );
    expect(existence?.[0]).toContain("assignee_id = $2::uuid");
    expect(existence?.[1]).toEqual(["task-alex", ARI]);
  });
});
