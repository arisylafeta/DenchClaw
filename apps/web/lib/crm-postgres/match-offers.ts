import "server-only";

// The offers already made on one listing, keyed the way a Matches row asks for them: by company, else by person,
// else by the written name. Read only.

import { queryPg } from "../postgres";
import type { MatchOffer } from "../matches-types";

type OfferRow = {
  id: string; stage: string | null; date: string | null;
  company_id: string | null; person_id: string | null; name: string | null;
};

export type OfferLookup = {
  /** The offer this counterparty already has on the listing, if any. */
  find: (companyId: string | null | undefined, personId: string | null | undefined, name: string) => MatchOffer | null;
};

const NOTHING: OfferLookup = { find: () => null };

/**
 * Offers on this listing only. A linked offer made on the opposite listing belongs to that side's counterparty, so it
 * is not this listing's answer to "Add to offers"; the pair guard already stops the same pairing twice.
 */
export async function offersForListing(listingId: string): Promise<OfferLookup> {
  const rows = await queryPg<OfferRow>(
    `select id, stage, coalesce(last_touch_on, updated_at::date)::text as date, company_id, person_id, lower(coalesce(name, '')) as name
     from crm_bulk_offers
     where bulk_listing_id = $1 and role = 'counterparty'
     order by updated_at desc`, [listingId]);
  if (!rows.length) {
    return NOTHING;
  }
  const byCompany = new Map<string, MatchOffer>();
  const byPerson = new Map<string, MatchOffer>();
  const byName = new Map<string, MatchOffer>();
  for (const row of rows) {
    const offer: MatchOffer = { id: row.id, stage: row.stage ?? "candidate", date: row.date };
    if (row.company_id) {
      if (!byCompany.has(row.company_id)) {
        byCompany.set(row.company_id, offer);
      }
    } else if (row.person_id) {
      if (!byPerson.has(row.person_id)) {
        byPerson.set(row.person_id, offer);
      }
    } else if (row.name && !byName.has(row.name)) {
      byName.set(row.name, offer);
    }
  }
  return {
    find: (companyId, personId, name) => (companyId ? byCompany.get(companyId) : undefined)
      ?? (personId ? byPerson.get(personId) : undefined)
      ?? byName.get(name.trim().toLowerCase())
      ?? null,
  };
}
