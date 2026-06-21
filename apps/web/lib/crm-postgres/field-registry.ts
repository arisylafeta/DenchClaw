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
    Source: { table: "crm_people", column: "source" },
    "Contact Type": { table: "crm_people", column: "contact_type" },
    Tags: { table: "crm_people", column: "tags" },
    Notes: { table: "crm_people", column: "notes" },
    "Buyer Sourced At": { table: "crm_people", column: "buyer_sourced_at" },
    "Email Opted Out": { table: "crm_people", column: "email_opted_out" },
    "Strength Score": { table: "crm_people", column: "strength_score" },
    "Last Interaction At": { table: "crm_people", column: "last_interaction_at" },
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
    Notes: { table: "crm_companies", column: "notes" },
    "Countries With Facilities": { table: "crm_companies", column: "countries_with_facilities" },
    "Buyer Category": { table: "crm_companies", column: "buyer_category" },
    "Buyer Workstream Status": { table: "crm_companies", column: "buyer_workstream_status" },
    "Buyer Evidence": { table: "crm_companies", column: "buyer_evidence" },
    "Buyer Last Reviewed At": { table: "crm_companies", column: "buyer_last_reviewed_at" },
    "Strength Score": { table: "crm_companies", column: "strength_score" },
    "Last Interaction At": { table: "crm_companies", column: "last_interaction_at" },
  },
};

export function normalizeObjectName(name: string): string {
  return name === "companies" ? "company" : name;
}

export function getCanonicalField(objectName: string, fieldName: string): CanonicalField | null {
  return canonicalFields[normalizeObjectName(objectName)]?.[fieldName] ?? null;
}
