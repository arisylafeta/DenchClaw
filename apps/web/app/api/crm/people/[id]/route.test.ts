import { beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

const { getPostgresPersonProfileMock } = vi.hoisted(() => ({
  getPostgresPersonProfileMock: vi.fn(),
}));

vi.mock("@/lib/crm-postgres/person-profile", () => ({
  getPostgresPersonProfile: getPostgresPersonProfileMock,
}));

describe("CRM person profile API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the Postgres person profile reader", async () => {
    getPostgresPersonProfileMock.mockResolvedValue({
      person: {
        id: "person_pg",
        name: "Postgres Person",
        email: "person@example.com",
        company_name: null,
        company_id: null,
        phone: null,
        status: null,
        source: null,
        strength_score: 0,
        strength_label: "New",
        strength_color: "gray",
        last_interaction_at: null,
        job_title: null,
        linkedin_url: null,
        avatar_url: null,
        notes: null,
        created_at: null,
        updated_at: null,
      },
      company: null,
      derived_website: "https://example.com",
      threads: [],
      events: [],
      interactions_summary: {
        email_count: 0,
        meeting_count: 0,
        total: 0,
        last_outbound_at: null,
        last_inbound_at: null,
      },
    });

    const res = await GET(
      new Request("http://localhost/api/crm/people/person_pg"),
      { params: Promise.resolve({ id: "person_pg" }) },
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      person: { id: "person_pg", name: "Postgres Person" },
    });
    expect(getPostgresPersonProfileMock).toHaveBeenCalledWith("person_pg");
  });
});
