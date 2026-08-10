import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "ari@rebattery.io",
    displayName: "Ari",
  })),
}));

vi.mock("@/lib/crm-postgres/object-read", () => ({
  getPostgresObjectData: vi.fn(async () => ({
    object: { name: "people" },
    fields: [],
    statuses: [],
    entries: [],
    totalCount: 0,
  })),
}));

describe("object route postgres flag", () => {
  beforeEach(() => {
    vi.resetModules();
    process.env.CRM_DB_BACKEND = "postgres";
  });

  it("uses postgres adapter when CRM_DB_BACKEND=postgres", async () => {
    const { GET } = await import("./route");
    const res = await GET(new Request("http://localhost/api/workspace/objects/people?pageSize=10"), {
      params: Promise.resolve({ name: "people" }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ object: { name: "people" } });
  });
});
