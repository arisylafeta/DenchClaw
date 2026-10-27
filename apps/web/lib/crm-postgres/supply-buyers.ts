import "server-only";

// Buyer companies that might want one supply listing, from crm_companies.buyer_profile. Read only; saving a suggestion is
// addOffer (a `candidate` counterparty offer). Nothing is sent from here.
import { queryPg } from "../postgres";
import { countryFromText } from "../demand-match";
import { compareBuyers, isLead, scoreBuyer, type BuyerFit, type BuyerProfile, type SupplyProfile } from "../buyer-suggestions";
import { getListing } from "./bulk-listings";

export type BuyerContact = { id: string; name: string | null; email: string | null; jobTitle: string | null; main: boolean; optedOut: boolean };
export type BuyerSuggestion = {
  companyId: string; name: string; stage: string | null; tier: string | null; basis: string | null;
  wants: string | null; evidenceUrl: string | null; nextStep: string | null;
  /** Latest email in or out with anyone at the company. */
  lastTouch: string | null;
  fit: BuyerFit; contacts: BuyerContact[];
};
export type SupplyBuyers = { ranked: BuyerSuggestion[]; leads: BuyerSuggestion[]; supply: SupplyProfile };

const CHEM = /\b(LFP|NMC|NCA|LTO|LMO|NIMH|LEAD)\b/i;
const FORMAT: [RegExp, string][] = [[/\bcells?\b|\bcylindrical\b|\bprismatic\b|\bpouch\b/i, "Cells"], [/\bmodules?\b/i, "Modules"], [/\bpacks?\b/i, "Packs"], [/\b(bess|container|systems?|cabinet)\b/i, "Systems"]];

export async function supplyProfile(supplyId: string): Promise<SupplyProfile | null> {
  const listing = await getListing(supplyId);
  if (!listing || listing.kind !== "supply") return null;
  const rows = await queryPg<{ field_key: string; value: string | null }>(
    `select field_key, value from crm_bulk_listing_fields where bulk_listing_id = $1 and field_key in ('chemistry', 'format', 'model', 'location') and status <> 'missing'`, [supplyId]);
  const f = new Map(rows.map((r) => [r.field_key, r.value ?? ""]));
  const title = String(listing.context.listing_title ?? listing.spec.listing_title ?? listing.summary ?? "");
  const text = `${f.get("model") ?? ""} ${title} ${listing.summary ?? ""}`;
  const chemistry = (f.get("chemistry") ?? "").match(CHEM)?.[1] ?? text.match(CHEM)?.[1] ?? null;
  const tradeKind = String(listing.context.trade_kind ?? listing.spec.trade_kind ?? "");
  const format = FORMAT.find(([re]) => re.test(f.get("format") ?? ""))?.[1] ?? FORMAT.find(([re]) => re.test(`${title} ${tradeKind}`))?.[1] ?? null;
  return { chemistry: chemistry ? chemistry.toUpperCase() : null, format, text: text.toLowerCase(), country: countryFromText(f.get("location") ?? listing.location) };
}

type CompanyRow = {
  id: string; name: string; stage: string | null; tier: string | null; basis: string | null; profile: BuyerProfile & { evidence_url?: string };
  next_step: string | null; main_contact: string | null;
};

export async function supplyBuyers(supplyId: string): Promise<SupplyBuyers | null> {
  const [supply, listing] = await Promise.all([supplyProfile(supplyId), getListing(supplyId)]);
  if (!supply || !listing) return null;
  const companies = await queryPg<CompanyRow>(
    `select c.id, c.name, c.buyer_stage as stage, c.buyer_tier as tier, c.buyer_profile_basis as basis, c.buyer_profile as profile,
            c.buyer_next_step as next_step, c.buyer_main_contact_id as main_contact
     from crm_companies c
     where c.buyer_profile <> '{}'::jsonb and c.buyer_exclusion_reason is null and coalesce(c.relationship_stage, '') <> 'Excluded'
       and ($2::text is null or c.id <> $2)
       and not exists (select 1 from crm_bulk_offers o where o.bulk_listing_id = $1 and o.role = 'counterparty' and o.company_id = c.id)`,
    [supplyId, listing.company_id]);
  const scored = companies.flatMap((c) => { const fit = scoreBuyer(supply, c.profile); return fit ? [{ c, fit }] : []; });
  if (!scored.length) return { ranked: [], leads: [], supply };
  const ids = scored.map((s) => s.c.id);
  const [people, touches] = await Promise.all([
    queryPg<{ id: string; company_id: string; full_name: string | null; email: string | null; job_title: string | null; email_opted_out: boolean | null }>(
      `select id, company_id, full_name, email, job_title, email_opted_out from crm_people where company_id = any($1::text[]) order by full_name`, [ids]),
    queryPg<{ company_id: string; last: string }>(
      `select p.company_id, max(coalesce(m.sent_at, m.created_at))::text as last from mail_message m join crm_people p on p.id = m.person_id
       where p.company_id = any($1::text[]) group by 1`, [ids]),
  ]);
  const touch = new Map(touches.map((t) => [t.company_id, t.last]));
  const byCompany = new Map<string, BuyerContact[]>();
  for (const p of people) {
    const main = scored.find((s) => s.c.id === p.company_id)?.c.main_contact === p.id;
    byCompany.set(p.company_id, [...(byCompany.get(p.company_id) ?? []), { id: p.id, name: p.full_name, email: p.email, jobTitle: p.job_title, main, optedOut: !!p.email_opted_out }]);
  }
  const rows = scored.map(({ c, fit }) => ({
    companyId: c.id, name: c.name, stage: c.stage, tier: c.tier, basis: c.basis, wants: c.profile.wants ?? null, evidenceUrl: c.profile.evidence_url ?? null,
    nextStep: c.next_step, lastTouch: touch.get(c.id) ?? null, fit,
    contacts: (byCompany.get(c.id) ?? []).sort((a, b) => Number(b.main) - Number(a.main)).slice(0, 5),
  } satisfies BuyerSuggestion)).sort(compareBuyers);
  return { ranked: rows.filter((r) => !isLead(r)), leads: rows.filter(isLead), supply };
}
