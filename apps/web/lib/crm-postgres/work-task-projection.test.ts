import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as Postgres from "../postgres";
import type * as ObjectRead from "./object-read";

const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;

// Only a disposable database; metadata and rows are isolated from other suites.
describe.skipIf(!TEST_URL)("Work Task list projection", () => {
  const schema = `task_projection_${Math.random().toString(36).slice(2, 12)}`;
  const originalDatabaseUrl = process.env.DATABASE_URL;
  const supervisor = randomUUID();
  const delegate = randomUUID();
  const unrelated = randomUUID();
  const details = ` \n\tObjective:   finish the API\r\n${"Detailed\timplementation  requirements\n".repeat(20)}PRIVATE TAIL `;
  const expectedPreview = details.replace(/\s+/g, " ").trim().slice(0, 240);
  let admin: Pool;
  let pg: typeof Postgres;
  let objects: typeof ObjectRead;

  beforeAll(async () => {
    admin = new Pool({ connectionString: TEST_URL });
    const client = await admin.connect();
    try {
      await client.query(`create schema ${schema}`);
      await client.query(`set search_path to ${schema}, public`);
      for (const table of ["crm_objects", "crm_fields", "crm_object_views", "crm_private_object_views", "crm_users", "projects", "work_tasks"]) {
        await client.query(`create table ${table} (like public.${table} including defaults including indexes)`);
      }
      await client.query(`insert into crm_objects select * from public.crm_objects where name in ('work_task', 'project', 'crm_user')`);
      await client.query(`insert into crm_fields select f.* from public.crm_fields f join crm_objects o on o.id = f.object_id`);
      await client.query(`delete from crm_fields where object_id = (select id from crm_objects where name = 'work_task')`);
      await client.query(`insert into crm_fields (id, object_id, name, type, canonical_column, related_object_id, sort_order)
        select 'projection_' || spec.column_name, task.id, spec.field_name, spec.field_type, spec.column_name, related.id, spec.position
        from crm_objects task
        cross join (values
          ('Title', 'text', 'title', null, 0),
          ('Task Details', 'text', 'task_details', null, 1),
          ('Project', 'relation', 'project_id', 'project', 2),
          ('Assignee', 'relation', 'assignee_id', 'crm_user', 3)
        ) spec(field_name, field_type, column_name, related_name, position)
        left join crm_objects related on related.name = spec.related_name
        where task.name = 'work_task'`);
      await client.query(`insert into crm_users (id, email, display_name, is_active, password_hash) values
        ($1, 'ari@rebattery.io', 'Supervisor', true, 'disabled-test-login'),
        ($2, 'alex@rebattery.io', 'Delegate', true, 'disabled-test-login'),
        ($3, 'unrelated@example.test', 'Unrelated', true, 'disabled-test-login')`, [supervisor, delegate, unrelated]);
      await client.query(`insert into projects (id, name, status) values ('project_active', 'API delivery', 'Active'), ('project_finished', 'Finished history', 'Finished')`);
      await client.query(`insert into work_tasks (id, reb_key, title, status, project_id, assignee_id, task_details) values
        ('delegate_task', 'DELEGATE', 'Finalize API', 'In Progress', 'project_active', $1, $3),
        ('unrelated_task', 'UNRELATED', 'Private unrelated task', 'In Progress', 'project_active', $2, 'Unrelated private details')`, [delegate, unrelated, details]);
    } finally {
      client.release();
    }
    const scopedUrl = new URL(TEST_URL!);
    scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = scopedUrl.toString();
    // The database pool captures its URL at module load, after fixture search_path is configured.
    pg = await import("../postgres");
    objects = await import("./object-read");
  });

  afterAll(async () => {
    if (pg) await pg.pgPool.end();
    if (admin) {
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("returns a bounded normalized preview without full details for the allowlisted supervisor", async () => {
    const data = await objects.getPostgresObjectData("work_task", new URL("http://localhost?pageSize=10"), supervisor);
    expect(data.totalCount).toBe(1);
    expect(data.entries.map((entry) => entry.entry_id)).toEqual(["delegate_task"]);
    expect(data.entries[0]).toMatchObject({ Title: "Finalize API", Preview: expectedPreview, Project: "project_active", Assignee: delegate });
    expect(String(data.entries[0].Preview)).toHaveLength(240);
    expect(data.entries[0]).not.toHaveProperty("Task Details");
    expect(data.entries[0]).not.toHaveProperty("task_details");
    expect(JSON.stringify(data.entries)).not.toContain("PRIVATE TAIL");
    expect(data.fields.map((field) => field.name)).toContain("Preview");
    expect(data.fields.map((field) => field.name)).not.toContain("Task Details");
    expect(data.relationLabels.Project).toEqual({ project_active: "API delivery" });
    expect(data.relationLabels.Assignee).toEqual({ [delegate]: "alex@rebattery.io" });
  });

  it("keeps task visibility assigned to the authenticated user and denies anonymous access", async () => {
    const url = new URL("http://localhost?pageSize=10");
    const assigned = await objects.getPostgresObjectData("work_task", url, delegate);
    expect(assigned.entries.map((entry) => entry.entry_id)).toEqual(["delegate_task"]);
    const other = await objects.getPostgresObjectData("work_task", url, unrelated);
    expect(other.entries.map((entry) => entry.entry_id)).toEqual(["unrelated_task"]);
    const anonymous = await objects.getPostgresObjectData("work_task", url);
    expect(anonymous.entries).toEqual([]);
    expect(anonymous.totalCount).toBe(0);
  });
});
