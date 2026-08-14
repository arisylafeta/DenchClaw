export type ProposalFilterRow = {
  id?: string;
  listing_id: string;
  listing_title: string | null;
  listing_reference: string | null;
  listing_supplier_name?: string | null;
  recycler_account_id?: string;
  recycler_name: string | null;
  recycler_display_name: string | null;
  recycler_country: string | null;
  recycler_region: string | null;
  recycler_city: string | null;
  recycler_public_fields?: {
    recycler_type?: string;
    chemistries?: string[];
    accepted_formats?: string[];
    capacity_kg_per_month?: number;
    capacity_band?: string;
    accepted_streams?: string;
  } | null;
  state: string;
  link_type: string;
  rebattery_notes?: string | null;
  created_at?: string;
};

export type ProposalFilters = {
  search: string;
  listingId: string;
  state: string;
  type: string;
};

export function getUniqueProposalListings(proposals: ProposalFilterRow[]) {
  const map = new Map<
    string,
    { id: string; title: string; reference: string | null }
  >();
  for (const proposal of proposals) {
    if (proposal.listing_id && proposal.listing_title) {
      map.set(proposal.listing_id, {
        id: proposal.listing_id,
        title: proposal.listing_title,
        reference: proposal.listing_reference,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) =>
    a.title.localeCompare(b.title),
  );
}

export function formatListingFilterLabel(listing: {
  title: string;
  reference: string | null;
}) {
  return listing.reference
    ? `${listing.reference} · ${listing.title}`
    : listing.title;
}

function matchesSearch(
  values: Array<string | number | null | undefined>,
  search: string,
) {
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[_-]+/g, " ");
  const terms = normalize(search).trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;

  const haystack = normalize(values.filter((value) => value != null).join(" "));
  return terms.every((term) => haystack.includes(term));
}

export function filterProposals<T extends ProposalFilterRow>(
  proposals: T[],
  filters: ProposalFilters,
) {
  return proposals.filter((proposal) => {
    if (filters.search.trim()) {
      const fields: Array<string | number | null | undefined> = [
        proposal.id,
        proposal.listing_id,
        proposal.listing_reference,
        proposal.listing_title,
        proposal.listing_supplier_name,
        proposal.recycler_account_id,
        proposal.recycler_name,
        proposal.recycler_display_name,
        proposal.recycler_country,
        proposal.recycler_region,
        proposal.recycler_city,
        proposal.recycler_public_fields?.recycler_type,
        ...(proposal.recycler_public_fields?.chemistries ?? []),
        ...(proposal.recycler_public_fields?.accepted_formats ?? []),
        proposal.recycler_public_fields?.capacity_kg_per_month,
        proposal.recycler_public_fields?.capacity_band,
        proposal.recycler_public_fields?.accepted_streams,
        proposal.link_type,
        proposal.state,
        proposal.rebattery_notes,
        proposal.created_at,
      ];

      if (!matchesSearch(fields, filters.search)) return false;
    }

    if (
      filters.listingId !== "all" &&
      proposal.listing_id !== filters.listingId
    ) {
      return false;
    }
    if (filters.state !== "all" && proposal.state !== filters.state) {
      return false;
    }
    if (filters.type !== "all" && proposal.link_type !== filters.type) {
      return false;
    }

    return true;
  });
}
