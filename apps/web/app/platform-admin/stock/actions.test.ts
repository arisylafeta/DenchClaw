import { beforeEach, describe, expect, it, vi } from "vitest";

const { noStore, queryPg } = vi.hoisted(() => ({
  noStore: vi.fn(),
  queryPg: vi.fn(),
}));

vi.mock("next/cache", () => ({ unstable_noStore: noStore }));
vi.mock("@/lib/postgres", () => ({ queryPg }));

const dbRow = {
  id: "stock-1234567890abcdef12345678",
  stock_id: "synetiq:123",
  supplier: "Synetiq",
  make: "MG",
  model: "4",
  year: "2023",
  part_number: "PN-1",
  quantity: "1",
  location: "Winsford",
  chemistry: "LFP",
  capacity_kwh: "51",
  scope: "complete_pack_candidate",
  stock_status: "unverified",
  commercial_bucket: "LFP_confirmation_required",
  enrich_status: "pending",
  created_at: "2026-09-22T17:32:59.121Z",
  updated_at: "2026-09-22T17:32:59.121Z",
};

describe("stock reads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryPg.mockImplementation((sql: string) => {
      if (sql.startsWith("select distinct supplier")) {return Promise.resolve([{ value: "Synetiq" }]);}
      if (sql.startsWith("select distinct chemistry")) {return Promise.resolve([{ value: "LFP" }]);}
      if (sql.startsWith("select distinct scope")) {return Promise.resolve([{ value: "complete_pack_candidate" }]);}
      if (sql.startsWith("select distinct commercial_bucket")) {return Promise.resolve([{ value: "LFP_confirmation_required" }]);}
      if (sql === "select count(*)::int as count from crm_stock_items") {return Promise.resolve([{ count: 1028 }]);}
      if (sql.includes("count(*)::int")) {return Promise.resolve([{ count: 1 }]);}
      return Promise.resolve([dbRow]);
    });
  });

  it("uses bounded, parameterized filters and maps stock rows", async () => {
    const { getStockPage } = await import("./actions");
    const page = await getStockPage({
      search: "MG 4",
      supplier: "Synetiq",
      status: "unverified",
      chemistry: "LFP",
      scope: "complete_pack_candidate",
      commercialBucket: "LFP_confirmation_required",
      sort: "uploaded_desc",
      page: 999,
    });

    expect(page).toMatchObject({ totalCount: 1, allCount: 1028, pageSize: 50, page: 1 });
    expect(page.rows[0]).toMatchObject({
      stockId: "synetiq:123",
      supplier: "Synetiq",
      capacityKwh: 51,
      stockStatus: "unverified",
    });
    const rowCall = queryPg.mock.calls.find(([sql]) =>
      String(sql).includes("select id, stock_id"),
    );
    expect(rowCall).toBeDefined();
    const [sql, params] = rowCall!;
    expect(sql).toContain("order by created_at desc, id desc");
    expect(sql).not.toContain("MG 4");
    expect(params).toEqual([
      "%MG 4%",
      "Synetiq",
      "unverified",
      "LFP",
      "complete_pack_candidate",
      "LFP_confirmation_required",
      50,
      0,
    ]);
  });

  it("rejects unsupported statuses and sorts", async () => {
    const { getStockPage } = await import("./actions");
    const page = await getStockPage({ status: "invented" as never, sort: "drop table" });
    expect(page.filters.status).toBe("");
    expect(page.filters.sort).toBe("updated_desc");
  });

  it("rejects malformed detail identifiers without querying", async () => {
    const { getStockDetails } = await import("./actions");
    expect(await getStockDetails("not-a-stock-id")).toBeNull();
    expect(queryPg).not.toHaveBeenCalled();
  });
});
