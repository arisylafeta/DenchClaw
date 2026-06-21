export type CanonicalField = { table: string; column: string };

const canonicalFields: Record<string, Record<string, CanonicalField>> = {
  people: {
    "Full Name": { table: "crm_people", column: "full_name" },
    "First Name": { table: "crm_people", column: "first_name" },
    "Last Name": { table: "crm_people", column: "last_name" },
    "Email Address": { table: "crm_people", column: "email" },
    "Phone Number": { table: "crm_people", column: "phone" },
    Company: { table: "crm_people", column: "company_id" },
    "Job Title": { table: "crm_people", column: "job_title" },
    "LinkedIn URL": { table: "crm_people", column: "linkedin_url" },
    Tags: { table: "crm_people", column: "tags" },
    Notes: { table: "crm_people", column: "notes" },
    "Email Opted Out": { table: "crm_people", column: "email_opted_out" },
  },
  company: {
    "Company Name": { table: "crm_companies", column: "name" },
    Domain: { table: "crm_companies", column: "domain" },
    Website: { table: "crm_companies", column: "website" },
    "Phone Number": { table: "crm_companies", column: "phone" },
    "LinkedIn URL": { table: "crm_companies", column: "linkedin_url" },
    Country: { table: "crm_companies", column: "country" },
    City: { table: "crm_companies", column: "city" },
    Notes: { table: "crm_companies", column: "notes" },
    Tags: { table: "crm_companies", column: "tags" },
  },
};

export function normalizeObjectName(name: string): string {
  return name === "companies" ? "company" : name;
}

export function getCanonicalField(objectName: string, fieldName: string): CanonicalField | null {
  return canonicalFields[normalizeObjectName(objectName)]?.[fieldName] ?? null;
}
