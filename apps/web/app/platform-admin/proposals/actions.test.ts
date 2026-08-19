import { beforeEach, describe, expect, it, vi } from "vitest";

const noStore = vi.fn();
const getSupabaseAdminClient = vi.fn();
const sendRecyclerOpportunityInvitationEmail = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: noStore }));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));
vi.mock("@/lib/platform-admin/email/templates/recycler-opportunity-invitation", () => ({ sendRecyclerOpportunityInvitationEmail }));

function query(data: unknown[] = []) {
  const result = { data, error: null };
  const builder = {
    select: vi.fn(),
    order: vi.fn(),
    eq: vi.fn(),
    in: vi.fn(),
    range: vi.fn(),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  builder.select.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.eq.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  builder.range.mockReturnValue(builder);
  return builder;
}

describe("getProposalData", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses only channel values supported by the live listing schema", async () => {
    const proposals = query();
    const listings = query();
    const recyclers = query();
    getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => ({
        recycler_opportunity_links: proposals,
        listings,
        accounts: recyclers,
      })[table]),
    });

    const { getProposalData } = await import("./actions");
    await getProposalData();

    expect(listings.in).toHaveBeenCalledWith("channel_mode", ["recycling"]);
  });

  it("does not reactivate or re-email a claimed opportunity", async () => {
    const listingResult = {
      data: { id: "listing-1", title: "Battery lot", seo_slug: "battery-lot", listing_specs: null },
      error: null,
    };
    const listing = {
      select: vi.fn(), eq: vi.fn(), maybeSingle: vi.fn(async () => listingResult),
    };
    listing.select.mockReturnValue(listing);
    listing.eq.mockReturnValue(listing);

    const eligible = query([{ id: "recycler-1" }]);
    const existing = query([{ id: "link-1", recycler_account_id: "recycler-1", state: "claimed" }]);
    const update = vi.fn();
    const insert = vi.fn();
    Object.assign(existing, { update, insert });
    getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => ({
        listings: listing,
        accounts: eligible,
        recycler_opportunity_links: existing,
      })[table]),
    });

    const { createInvitations } = await import("./actions");
    const result = await createInvitations("listing-1", ["recycler-1"]);

    expect(result).toEqual(expect.objectContaining({ success: true, alreadyActive: 1, reactivated: 0 }));
    expect(update).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
    expect(sendRecyclerOpportunityInvitationEmail).not.toHaveBeenCalled();
  });
});
