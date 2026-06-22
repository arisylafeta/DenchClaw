import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { getPostgresPeopleMock } = vi.hoisted(() => ({
  getPostgresPeopleMock: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/people", () => ({
  getPostgresPeople: getPostgresPeopleMock,
}));

describe("CRM people API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Postgres people reader", async () => {
    getPostgresPeopleMock.mockResolvedValue({
      people: [{
        id: "person_pg",
        name: "Postgres Person",
        email: "person@example.com",
        company_name: "Acme",
        strength_score: 42,
        last_interaction_at: null,
        avatar_url: null,
        job_title: "Founder",
      }],
    });

    const res = await GET(new Request("http://localhost/api/crm/people?limit=25"));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      people: [{ id: "person_pg", name: "Postgres Person" }],
    });
    expect(getPostgresPeopleMock).toHaveBeenCalledWith({ limit: 25 });
  });
});
