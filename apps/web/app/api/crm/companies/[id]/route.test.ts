import { beforeEach, describe, expect, it, vi } from "vitest";
import { ONBOARDING_OBJECT_IDS } from "@/lib/workspace-schema-migrations";
import { GET } from "./route";

const { loadCrmFieldMapsMock, safeQueryMock } = vi.hoisted(() => ({
  loadCrmFieldMapsMock: vi.fn(),
  safeQueryMock: vi.fn(),
}));

const { getPostgresCompanyProfileMock } = vi.hoisted(() => ({
  getPostgresCompanyProfileMock: vi.fn(),
}));

vi.mock("@/lib/crm-queries", () => ({
  buildEntryProjection: vi.fn((params: {
    objectId: string;
    aliasedFields: Array<{ name: string; alias: string }>;
    whereSql?: string;
  }) => {
    const aliases = params.aliasedFields
      .map(({ name, alias }) => `${name}:${alias}`)
      .join(",");
    return `projection object=${params.objectId} fields=${aliases} where=${params.whereSql ?? ""}`;
  }),
  buildLatestMessagePerThreadCte: vi.fn(() => null),
  hydratePeopleByIds: vi.fn(async () => new Map()),
  jsonArrayContains: (columnExpr: string, id: string) => {
    const safeId = id.replace(/'/g, "''").replace(/"/g, '""');
    return `${columnExpr} LIKE '%"${safeId}"%'`;
  },
  loadCrmFieldMaps: loadCrmFieldMapsMock,
  safeQuery: safeQueryMock,
  sqlString: (value: string) => `'${value.replace(/'/g, "''")}'`,
}));

vi.mock("@/lib/crm-postgres/company-profile", () => ({
  getPostgresCompanyProfile: getPostgresCompanyProfileMock,
}));

const baseFieldMaps = {
  people: {
    "Full Name": "people_name",
    "Email Address": "people_email",
    Company: "people_company",
    "Job Title": "people_job_title",
    "Strength Score": "people_strength",
    "Last Interaction At": "people_last_interaction",
    "Avatar URL": "people_avatar",
  },
  company: {
    "Company Name": "company_name",
    Domain: "company_domain",
    Website: "company_website",
    Industry: "company_industry",
    Type: "company_type",
    Source: "company_source",
    "Strength Score": "company_strength",
    "Last Interaction At": "company_last_interaction",
    Notes: "company_notes",
  },
  email_thread: {},
  email_message: {},
  calendar_event: {},
  interaction: {},
};

describe("CRM company profile API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CRM_DB_BACKEND;
    loadCrmFieldMapsMock.mockResolvedValue(baseFieldMaps);
  });

  it("uses the Postgres company profile reader when CRM_DB_BACKEND is postgres", async () => {
    process.env.CRM_DB_BACKEND = "postgres";
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
    expect(getPostgresCompanyProfileMock).toHaveBeenCalledWith("comp_pg");
    expect(loadCrmFieldMapsMock).not.toHaveBeenCalled();
    expect(safeQueryMock).not.toHaveBeenCalled();
  });

  it("populates Team from the People.Company relation even when email domain does not match", async () => {
    let peopleSql = "";
    safeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`object=${ONBOARDING_OBJECT_IDS.company}`)) {
        return [{
          entry_id: "comp_plaid_012",
          name: "Plaid",
          domain: "plaid.com",
          website: "https://plaid.com",
          strength_score: "0",
        }];
      }
      if (sql.includes(`object=${ONBOARDING_OBJECT_IDS.people}`)) {
        peopleSql = sql;
        if (!sql.includes("sub.company_id = 'comp_plaid_012'")) {
          return [];
        }
        return [{
          entry_id: "ppl_zachperret_20",
          name: "Zach Perret",
          email: "zach@founder.example",
          company_id: "comp_plaid_012",
          job_title: "CEO",
          strength_score: "12",
          last_interaction_at: null,
          avatar_url: null,
        }];
      }
      return [];
    });

    const res = await GET(
      new Request("http://localhost/api/crm/companies/comp_plaid_012"),
      { params: Promise.resolve({ id: "comp_plaid_012" }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.people).toHaveLength(1);
    expect(json.people[0]).toMatchObject({
      id: "ppl_zachperret_20",
      name: "Zach Perret",
      email: "zach@founder.example",
      job_title: "CEO",
    });
    expect(json.summary.people_count).toBe(1);
    expect(json.summary.strongest_contact).toBe("Zach Perret");
    expect(peopleSql).toContain("Company:company_id");
    expect(peopleSql).toContain("sub.company_id = 'comp_plaid_012'");
    expect(peopleSql).toContain(`sub.company_id LIKE '%"comp_plaid_012"%'`);
  });

  it("normalizes URL-like company domains for the email-domain fallback", async () => {
    loadCrmFieldMapsMock.mockResolvedValue({
      ...baseFieldMaps,
      people: {
        ...baseFieldMaps.people,
        Company: undefined,
      },
    });
    safeQueryMock.mockImplementation(async (sql: string) => {
      if (sql.includes(`object=${ONBOARDING_OBJECT_IDS.company}`)) {
        return [{
          entry_id: "comp_plaid_012",
          name: "Plaid",
          domain: "https://plaid.com/about",
          website: null,
          strength_score: "0",
        }];
      }
      if (sql.includes(`object=${ONBOARDING_OBJECT_IDS.people}`)) {
        if (!sql.includes("LOWER(SUBSTR(sub.email, INSTR(sub.email, '@') + 1)) = 'plaid.com'")) {
          return [];
        }
        return [{
          entry_id: "ppl_domain_match",
          name: "Domain Match",
          email: "person@plaid.com",
          job_title: "Operator",
          strength_score: null,
          last_interaction_at: null,
          avatar_url: null,
        }];
      }
      return [];
    });

    const res = await GET(
      new Request("http://localhost/api/crm/companies/comp_plaid_012"),
      { params: Promise.resolve({ id: "comp_plaid_012" }) },
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.people).toHaveLength(1);
    expect(json.people[0]).toMatchObject({
      id: "ppl_domain_match",
      name: "Domain Match",
      email: "person@plaid.com",
    });
  });
});
