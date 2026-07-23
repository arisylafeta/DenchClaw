import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPostgresPeople } from "./people";

const { queryPgMock } = vi.hoisted(() => ({
  queryPgMock: vi.fn(),
}));

vi.mock("../postgres", () => ({
  queryPg: queryPgMock,
}));

describe("getPostgresPeople", () => {
  beforeEach(() => {
    queryPgMock.mockReset();
  });

  it("returns last_interaction_at and sorts by most recent interaction first", async () => {
    queryPgMock.mockResolvedValue([
      {
        id: "p1",
        name: "Ada Lovelace",
        email: "ada@example.com",
        company_name: "Acme",
        job_title: "Founder",
        last_interaction_at: "2026-06-22T11:59:24Z",
      },
    ]);

    const result = await getPostgresPeople({ limit: 12 });

    const [sql] = queryPgMock.mock.calls[0];
    expect(String(sql)).toContain("p.last_interaction_at");
    expect(String(sql)).toContain("order by p.last_interaction_at desc nulls last");
    expect(result.people[0].last_interaction_at).toBe("2026-06-22T11:59:24Z");
  });
});
