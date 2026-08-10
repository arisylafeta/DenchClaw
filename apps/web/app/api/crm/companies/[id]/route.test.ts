import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

vi.mock("@/lib/auth", () => ({
  currentUser: vi.fn(async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    email: "ari@rebattery.io",
    displayName: "Ari",
  })),
}));

const { getPostgresCompanyProfileMock } = vi.hoisted(() => ({
  getPostgresCompanyProfileMock: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/company-profile", () => ({
  getPostgresCompanyProfile: getPostgresCompanyProfileMock,
}));

describe("CRM company profile API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Postgres company profile reader", async () => {
    getPostgresCompanyProfileMock.mockResolvedValue({
      company: {
        id: "comp_pg",
        name: "Postgres Co",
        domain: "postgres.example",
        website: "https://postgres.example",
        industry: null,
        type: null,
        source: null,
        strength_score: 0,
        strength_label: "New",
        strength_color: "gray",
        last_interaction_at: null,
        notes: null,
        created_at: null,
        updated_at: null,
      },
      people: [],
      threads: [],
      events: [],
      summary: {
        people_count: 0,
        thread_count: 0,
        event_count: 0,
        strongest_contact: null,
      },
      commercial: {
        roles: [],
        profiles: [],
        opportunities: [],
        summary: {
          active_profile_count: 0,
          buyer_profile_count: 0,
          supplier_profile_count: 0,
          recycler_profile_count: 0,
          open_supply_count: 0,
          open_demand_count: 0,
          urgent_supply_count: 0,
          urgent_demand_count: 0,
          latest_profile_verified_at: null,
          latest_supply_at: null,
          latest_demand_at: null,
          next_deadline_at: null,
          commercial_status: "inactive",
          commercial_priority_score: 0,
        },
      },
    });

    const res = await GET(
      new Request("http://localhost/api/crm/companies/comp_pg"),
      { params: Promise.resolve({ id: "comp_pg" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      company: { id: "comp_pg", name: "Postgres Co" },
      commercial: {
        roles: [],
      },
    });
    expect(getPostgresCompanyProfileMock).toHaveBeenCalledWith(
      "comp_pg",
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("returns 404 when the Postgres profile is not found", async () => {
    getPostgresCompanyProfileMock.mockResolvedValue(null);

    const res = await GET(
      new Request("http://localhost/api/crm/companies/missing"),
      { params: Promise.resolve({ id: "missing" }) },
    );

    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toMatchObject({ error: "Company not found." });
  });
});
