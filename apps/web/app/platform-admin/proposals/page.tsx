import { getProposalData } from "./actions";
import { ProposalsClient } from "./proposals-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function parsePage(value?: string) {
  const parsed = Number.parseInt(value ?? "1", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
}

export default async function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<{
    proposalPage?: string;
    listingPage?: string;
    recyclerPage?: string;
    proposalSearch?: string;
    proposalListingFilter?: string;
    proposalStateFilter?: string;
    proposalTypeFilter?: string;
    listingSearch?: string;
    listingChannelFilter?: string;
    recyclerSearch?: string;
    chemistryFilter?: string;
    countryFilter?: string;
    capacityFilter?: string;
  }>;
}) {
  const params = await searchParams;
  const proposalData = await getProposalData({
    proposalPage: parsePage(params.proposalPage),
    listingPage: parsePage(params.listingPage),
    recyclerPage: parsePage(params.recyclerPage),
    proposalSearch: params.proposalSearch,
    proposalListingFilter: params.proposalListingFilter,
    proposalStateFilter: params.proposalStateFilter,
    proposalTypeFilter: params.proposalTypeFilter,
    listingSearch: params.listingSearch,
    listingChannelFilter: params.listingChannelFilter,
    recyclerSearch: params.recyclerSearch,
    chemistryFilter: params.chemistryFilter,
    countryFilter: params.countryFilter,
    capacityFilter: params.capacityFilter,
  });

  return (
    <ProposalsClient
      proposals={proposalData.proposals}
      listings={proposalData.listings}
      recyclers={proposalData.recyclers}
      proposalListingOptions={proposalData.proposalListingOptions}
      recyclerFilterOptions={proposalData.recyclerFilterOptions}
    />
  );
}
