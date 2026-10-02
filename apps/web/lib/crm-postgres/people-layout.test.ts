import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type * as Postgres from "../postgres";
import type * as Objects from "./object-read";
import type * as Mutations from "./entry-mutations";

const TEST_URL = process.env.BULK_TRADES_TEST_DATABASE_URL;
const schema = `people_layout_${randomUUID().replaceAll("-", "")}`;

describe.skipIf(!TEST_URL)("People layout and editable tag badges", () => {
  let admin: Pool;
  let pg: typeof Postgres;
  let objects: typeof Objects;
  let mutations: typeof Mutations;

  beforeAll(async () => {
    if (!new URL(TEST_URL!).pathname.includes("_test")) throw new Error("Use a disposable test database");
    admin = new Pool({ connectionString: TEST_URL });
    const client = await admin.connect();
    try {
      await client.query(`create schema ${schema}`);
      await client.query(`set search_path to ${schema}, public`);
      for (const table of ["crm_objects", "crm_fields", "crm_people", "crm_companies", "crm_dismantlers", "crm_object_views", "crm_private_object_views"]) {
        await client.query(`create table ${table} (like public.${table} including defaults including indexes)`);
      }
      await client.query("insert into crm_objects select * from public.crm_objects where name in ('company', 'people')");
      await client.query("insert into crm_fields select f.* from public.crm_fields f join crm_objects o on o.id=f.object_id");
      await client.query("delete from crm_fields where object_id=(select id from crm_objects where name='people')");
      await client.query(`insert into crm_fields (id, object_id, name, type, canonical_column, related_object_id, sort_order)
        select 'layout_' || spec.col, o.id, spec.label, spec.kind, spec.col, related.id, spec.position
        from crm_objects o cross join (values
          ('full_name','Full Name','text',0), ('first_name','First Name','text',1),
          ('email','Email Address','email',2), ('last_name','Last Name','text',3),
          ('company_id','Company','relation',4), ('tags','Tags','select',5),
          ('job_title','Job Title','text',6), ('phone','Phone Number','phone',7),
          ('notes','Notes','richtext',8), ('linkedin_url','LinkedIn URL','url',9),
          ('email_opted_out','Email Opted Out','boolean',10)
        ) spec(col,label,kind,position)
        left join crm_objects related on spec.col='company_id' and related.name='company'
        where o.name='people'`);
      await client.query(readFileSync(new URL("./migrations/031_people_column_layout.sql", import.meta.url), "utf8"));
    } finally { client.release(); }
    const scoped = new URL(TEST_URL!);
    scoped.searchParams.set("options", `-c search_path=${schema},public`);
    process.env.DATABASE_URL = scoped.toString();
    // Exercise the pool's module-loading boundary: configure the isolated search_path before import.
    pg = await import("../postgres");
    objects = await import("./object-read");
    mutations = await import("./entry-mutations");
  });

  afterAll(async () => {
    if (pg) await pg.pgPool.end();
    if (admin) {
      await admin.query(`drop schema if exists ${schema} cascade`);
      await admin.end();
    }
  });

  it("keeps primary contact columns first and name components last regardless of fill rates", async () => {
    const data = await objects.getPostgresObjectData("people", new URL("http://test/people"));
    expect(data.fields.slice(0, 8).map((field) => field.name)).toEqual([
      "Full Name", "Email Address", "Company", "Job Title", "Purpose", "Tags", "Phone Number", "LinkedIn URL",
    ]);
    expect(data.fields.slice(-2).map((field) => field.name)).toEqual(["First Name", "Last Name"]);
    expect(data.fields.find((field) => field.name === "Tags")).toMatchObject({ type: "tags", enum_multiple: true });
  });

  it("persists JSON tag-editor values as separate tags and supports clearing them", async () => {
    const { entryId: id } = await mutations.createPostgresEntry("people", {
      "Full Name": "Layout smoke contact", "Tags": JSON.stringify(["Buyer", "Research cohort"]),
    });
    expect(await pg.queryPg("select tags from crm_people where id=$1", [id])).toEqual([{ tags: ["Buyer", "Research cohort"] }]);
    await mutations.updatePostgresEntry("people", id, { "Tags": JSON.stringify(["Buyer", "Follow-up needed"]) });
    const data = await objects.getPostgresObjectData("people", new URL("http://test/people"));
    expect(data.entries.find((entry) => entry.entry_id === id)?.Tags).toEqual(["Buyer", "Follow-up needed"]);
    await mutations.updatePostgresEntry("people", id, { "Tags": "" });
    expect(await pg.queryPg("select tags from crm_people where id=$1", [id])).toEqual([{ tags: [] }]);
  });
});
