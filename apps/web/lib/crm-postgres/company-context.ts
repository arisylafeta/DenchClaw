import { queryPg } from "../postgres";

/** Source-attributed context lives independently of the mutable buyer profile (migration 046). */
export type CompanyContextNote = {
  id: string;
  company_id: string;
  note: string;
  category: "ask" | "bid" | "offer_reply" | "project" | "preference" | "trading_style" | "past_deal" | "note";
  source_url: string | null;
  source_kind: string;
  source_ref: string | null;
  observed_on: string;
  created_at: string;
};

/** Shared SQL expression so sheets and company profiles show the same dated context. */
export function companyContextSql(companyId: string): string {
  return `coalesce((select json_agg(json_build_object(
    'id', context.id, 'company_id', context.company_id, 'note', context.note,
    'source_kind', context.source_kind, 'source_ref', context.source_ref,
    'category', context.category, 'source_url', context.source_url,
    'observed_on', to_char(context.observed_on, 'YYYY-MM-DD'), 'created_at', context.created_at
  ) order by context.observed_on desc, context.created_at desc, context.id)
  from crm_company_context_notes context where context.company_id = ${companyId}), '[]'::json)`;
}

export async function listCompanyContextNotes(companyId: string): Promise<CompanyContextNote[]> {
  const [row] = await queryPg<{ notes: CompanyContextNote[] }>(`select ${companyContextSql("$1")} as notes`, [companyId]);
  return row.notes;
}
