import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DismantlerRow } from "./crm-postgres/dismantlers";

vi.mock("server-only", () => ({}));

type Row = Record<string, unknown>;
const tables: Record<string, Row[]> = {};
let failing = false;

// A tiny stand-in for the Supabase query builder: select, eq, in, order and range.
function from(table: string) {
  const filters: Array<(row: Row) => boolean> = [];
  const query = {
    select: () => query,
    order: () => query,
    eq: (column: string, value: unknown) => { filters.push((row) => row[column] === value); return query; },
    in: (column: string, values: unknown[]) => { filters.push((row) => values.includes(row[column])); return query; },
    range: async (start: number, end: number) => {
      if (failing) return { data: null, error: { message: "ReBattery is down" } };
      return { data: (tables[table] ?? []).filter((row) => filters.every((keep) => keep(row))).slice(start, end + 1), error: null };
    },
  };
  return query;
}
vi.mock("./platform-admin/supabase", () => ({ getSupabaseAdminClient: () => ({ from }) }));

const row = (o: Partial<DismantlerRow>): DismantlerRow => ({
  id: "d", company_id: "c", name: "Yard", stage: "Talking", stage_since: "2026-09-01", parked_from: null, park_reason: null,
  revisit_on: null, next_step: null, next_step_due: null, next_step_person_id: null, next_step_person_name: null,
  owner_user_id: null, owner_name: null, goal: false, country: null, ebay_username: null, ebay_listings: null,
  platform_account_id: null, source: null, notes: null, last_contact: null, updated_at: "", match_emails: null, match_domain: null, ...o,
});

describe("ReBattery facts on dismantlers", () => {
  beforeEach(() => {
    vi.resetModules();
    failing = false;
    Object.assign(tables, {
      accounts: [
        { id: "a1", name: "Lister Ltd", role: "supplier", created_at: "2026-08-20T10:00:00Z" },
        { id: "a2", name: "New Signup", role: "supplier", created_at: "2026-09-25T10:00:00Z" },
        { id: "b1", name: "A Buyer", role: "buyer", created_at: "2026-01-01T00:00:00Z" },
      ],
      account_memberships: [
        { id: "m1", account_id: "a1", user_id: "u1" },
        { id: "m2", account_id: "a2", user_id: "u2" },
        { id: "m3", account_id: "b1", user_id: "u3" },
      ],
      users: [
        { id: "u1", email: "sam@lister.example" },
        { id: "u2", email: "kim@newsignup.example" },
        { id: "u3", email: "buyer@lister.example" },
      ],
      listings: [
        { id: "l1", supplier_account_id: "a1", listing_status: "published", created_at: "2026-09-10T09:00:00Z" },
        { id: "l2", supplier_account_id: "a1", listing_status: "published", created_at: "2026-09-28T09:00:00Z" },
        { id: "l3", supplier_account_id: "a1", listing_status: "completed", created_at: "2026-09-01T09:00:00Z" },
      ],
      deals: [
        { id: "x1", supplier_account_id: "a1", status: "completed" },
        { id: "x2", supplier_account_id: "a1", status: "open" },
      ],
    });
  });

  it("matches supplier accounts, counts listings and sales, and lifts the stage", async () => {
    const { withPlatform } = await import("./dismantlers-platform");
    const { dismantlers, platform_error } = await withPlatform([
      row({ id: "lister", match_emails: ["sam@lister.example"] }),
      row({ id: "signup", stage: "Found", match_domain: "https://newsignup.example" }),
      row({ id: "nobody", match_emails: ["someone@elsewhere.example"] }),
    ]);
    expect(platform_error).toBeNull();
    expect(dismantlers.map((d) => [d.id, d.saved_stage, d.stage])).toEqual([
      ["lister", "Talking", "Live"],
      ["signup", "Found", "Signed up"],
      ["nobody", "Talking", "Talking"],
    ]);
    expect(dismantlers[0].platform).toEqual({
      account_id: "a1", account_name: "Lister Ltd", matched_by: "email", signed_up_on: "2026-08-20",
      listed: 2, listed_ever: 3, sold: 1, last_listed_on: "2026-09-28",
    });
    expect(dismantlers[1].platform).toMatchObject({ matched_by: "domain", listed_ever: 0 });
    // The match inputs stay on the server.
    expect(dismantlers[0]).not.toHaveProperty("match_emails");
  });

  it("keeps saved stages and says why when ReBattery cannot be read", async () => {
    failing = true;
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { withPlatform } = await import("./dismantlers-platform");
    const { dismantlers, platform_error } = await withPlatform([row({ id: "lister", match_emails: ["sam@lister.example"] })]);
    expect(dismantlers[0]).toMatchObject({ stage: "Talking", saved_stage: "Talking", platform: null });
    expect(platform_error).toMatch(/Could not read ReBattery/);
  });
});
