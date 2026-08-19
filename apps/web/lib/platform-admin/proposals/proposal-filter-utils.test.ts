import { describe, expect, it } from "vitest";
import { filterProposals, getUniqueProposalListings } from "./proposal-filter-utils";

const proposals = [
  {
    listing_id: "listing-1",
    listing_title: "Battery pack lot",
    listing_reference: "RB-LIST-001",
    listing_supplier_name: "West Battery Supply",
    recycler_name: "North Recycler",
    recycler_display_name: null,
    recycler_country: "US",
    recycler_region: "CA",
    recycler_city: "Oakland",
    recycler_public_fields: { chemistries: ["lfp"] },
    state: "active",
    link_type: "invited",
  },
  {
    listing_id: "listing-2",
    listing_title: "Module lot",
    listing_reference: "RB-LIST-002",
    listing_supplier_name: null,
    recycler_name: "South Recycler",
    recycler_display_name: null,
    recycler_country: "US",
    recycler_region: "TX",
    recycler_city: "Austin",
    recycler_public_fields: { chemistries: ["nmc"] },
    state: "paused",
    link_type: "suggested",
  },
];

describe("proposal filters", () => {
  it("matches listing references and supplier names", () => {
    expect(
      filterProposals(proposals, {
        search: "rb-list-002",
        listingId: "all",
        state: "all",
        type: "all",
      }).map((proposal) => proposal.listing_id),
    ).toEqual(["listing-2"]);

    expect(
      filterProposals(proposals, {
        search: "west battery",
        listingId: "all",
        state: "all",
        type: "all",
      }).map((proposal) => proposal.listing_id),
    ).toEqual(["listing-1"]);
  });

  it("matches terms across different proposal fields", () => {
    expect(
      filterProposals(proposals, {
        search: "north active lfp",
        listingId: "all",
        state: "all",
        type: "all",
      }).map((proposal) => proposal.listing_id),
    ).toEqual(["listing-1"]);
  });

  it("returns unique listing options with references", () => {
    expect(getUniqueProposalListings(proposals)).toEqual([
      {
        id: "listing-1",
        title: "Battery pack lot",
        reference: "RB-LIST-001",
      },
      { id: "listing-2", title: "Module lot", reference: "RB-LIST-002" },
    ]);
  });
});
