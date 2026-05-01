export type CanonicalField = { table: string; column: string };

const canonicalFields: Record<string, Record<string, CanonicalField>> = {
  people: {
    "Full Name": { table: "crm_people", column: "full_name" },
    "First Name": { table: "crm_people", column: "first_name" },
    "Last Name": { table: "crm_people", column: "last_name" },
    "Email Address": { table: "crm_people", column: "email" },
    "Phone Number": { table: "crm_people", column: "phone" },
    Company: { table: "crm_people", column: "company_id" },
    "Source Company Name": { table: "crm_people", column: "source_company_name" },
    "Company Domain": { table: "crm_people", column: "company_domain" },
    "Job Title": { table: "crm_people", column: "job_title" },
    "LinkedIn URL": { table: "crm_people", column: "linkedin_url" },
    "Avatar URL": { table: "crm_people", column: "avatar_url" },
    "Lifecycle Stage": { table: "crm_people", column: "lifecycle_stage" },
    "Lead Status": { table: "crm_people", column: "lead_status" },
    "Market Role": { table: "crm_people", column: "market_role" },
    Source: { table: "crm_people", column: "source" },
    "Strength Score": { table: "crm_people", column: "strength_score" },
    "Last Interaction At": { table: "crm_people", column: "last_interaction_at" },
    "Raw JSON": { table: "crm_people", column: "raw_json" },
  },
  company: {
    "Company Name": { table: "crm_companies", column: "name" },
    Domain: { table: "crm_companies", column: "domain" },
    Website: { table: "crm_companies", column: "website" },
    "Phone Number": { table: "crm_companies", column: "phone" },
    "LinkedIn URL": { table: "crm_companies", column: "linkedin_url" },
    "Company Type": { table: "crm_companies", column: "company_type" },
    "Platform Role": { table: "crm_companies", column: "platform_role" },
    "Company Sector": { table: "crm_companies", column: "sector" },
    "Role Confidence": { table: "crm_companies", column: "role_confidence" },
    "Role Source": { table: "crm_companies", column: "role_source" },
    Country: { table: "crm_companies", column: "country" },
    City: { table: "crm_companies", column: "city" },
    "Employee Count": { table: "crm_companies", column: "employee_count" },
    "Annual Revenue Micros": { table: "crm_companies", column: "annual_revenue_micros" },
    "Lifecycle Stage": { table: "crm_companies", column: "lifecycle_stage" },
    "Lead Status": { table: "crm_companies", column: "lead_status" },
    "Strength Score": { table: "crm_companies", column: "strength_score" },
    "Last Interaction At": { table: "crm_companies", column: "last_interaction_at" },
    "Raw JSON": { table: "crm_companies", column: "raw_json" },
  },
};

export function normalizeObjectName(name: string): string {
  return name === "companies" ? "company" : name;
}

export function getCanonicalField(objectName: string, fieldName: string): CanonicalField | null {
  return canonicalFields[normalizeObjectName(objectName)]?.[fieldName] ?? null;
}
