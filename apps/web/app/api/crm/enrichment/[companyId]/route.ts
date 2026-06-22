import { queryPg } from "@/lib/postgres";
import {
  getEnrichedCompanyById,
  getEnrichedCompanyByDomain,
} from "@/lib/crm-postgres/enrichment";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ companyId: string }> },
) {
  try {
    const { companyId } = await ctx.params;
    const trimmedId = companyId?.trim();
    if (!trimmedId) {
      return Response.json({ error: "Missing company id." }, { status: 400 });
    }

    const companyRows = await queryPg<{ domain: string | null }>(
      "select domain from crm_companies where id = $1 limit 1",
      [trimmedId],
    );
    const company = companyRows[0] ?? null;
    if (!company) {
      return Response.json({ error: "Company not found." }, { status: 404 });
    }

    // Try company_id first, then fall back to domain
    let enrichment = await getEnrichedCompanyById(trimmedId);
    if (!enrichment && company.domain) {
      enrichment = await getEnrichedCompanyByDomain(company.domain);
    }

    return Response.json({ enrichment });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
