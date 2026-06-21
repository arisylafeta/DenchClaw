import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("crm postgres schema", () => {
  it("contains core canonical and extension tables", () => {
    const sql = readFileSync(join(process.cwd(), "lib/crm-postgres/schema.sql"), "utf-8");

    expect(sql).toContain("create table if not exists crm_people");
    expect(sql).toContain("create table if not exists crm_companies");
    expect(sql).toContain("create or replace view crm_relation_links");
    expect(sql).toContain("create index if not exists crm_people_company_idx");
  });
});
