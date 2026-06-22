import { queryPgEnrichment } from "../postgres-enrichment";

export interface CrmCompanyEnrichment {
  company_id: string;
  domain: string | null;
  country: string | null;
  city: string | null;
  about: string | null;
  sectors: string[] | null;
  roles: string[] | null;
  evidence_url: string | null;
  evidence_snippet: string | null;
  confidence: string | null;
  confidence_reason: string | null;
  created_at: string | Date | null;
  updated_at: string | Date | null;
}

export async function getEnrichedCompanyById(
  companyId: string,
): Promise<CrmCompanyEnrichment | null> {
  const rows = await queryPgEnrichment<CrmCompanyEnrichment>(
    "select * from public.crm_company_enrichments where company_id = $1 limit 1",
    [companyId],
  );
  return rows[0] ?? null;
}

export async function getEnrichedCompanyByDomain(
  domain: string,
): Promise<CrmCompanyEnrichment | null> {
  const rows = await queryPgEnrichment<CrmCompanyEnrichment>(
    "select * from public.crm_company_enrichments where lower(domain) = lower($1) limit 1",
    [domain],
  );
  return rows[0] ?? null;
}

export async function listEnrichedCompanies(
  limit = 100,
): Promise<CrmCompanyEnrichment[]> {
  return queryPgEnrichment<CrmCompanyEnrichment>(
    "select * from public.crm_company_enrichments order by updated_at desc limit $1",
    [limit],
  );
}

export async function validateEnrichmentSchema(): Promise<{
  ok: boolean;
  error?: string;
}> {
  try {
    await queryPgEnrichment(
      "select 1 from public.crm_company_enrichments limit 0",
    );
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
  }
}
