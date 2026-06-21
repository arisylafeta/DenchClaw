import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPostgresPersonProfile } from "./person-profile";

const { queryPgMock } = vi.hoisted(() => ({
  queryPgMock: vi.fn(),
}));

vi.mock("../postgres", () => ({
  queryPg: queryPgMock,
}));

describe("getPostgresPersonProfile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads Notes from custom field values for CRM profile pages", async () => {
    queryPgMock.mockImplementation(async (sql: string) => {
      if (sql.includes("from crm_people")) {
        return [
          {
            id: "gog:person:ari.sylafeta@gmail.com",
            name: "Ari Sylafeta",
            email: null,
            company_id: null,
            phone: null,
            status: null,
            job_title: null,
            linkedin_url: null,
            notes: "Typeform submission - Buyer Sourcing Criteria",
            created_at: null,
            updated_at: null,
          },
        ];
      }
      return [];
    });

    const profile = await getPostgresPersonProfile("gog:person:ari.sylafeta@gmail.com");

    expect(profile?.person.notes).toBe("Typeform submission - Buyer Sourcing Criteria");
  });
});
