import { beforeEach, describe, expect, it, vi } from "vitest";

const noStore = vi.fn();
const getSupabaseAdminClient = vi.fn();

vi.mock("next/cache", () => ({ unstable_noStore: noStore, revalidatePath: vi.fn() }));
vi.mock("@/lib/platform-admin/supabase", () => ({ getSupabaseAdminClient }));

function query(data: unknown[]) {
  const result = { data, error: null };
  const builder = {
    select: vi.fn(),
    order: vi.fn(),
    limit: vi.fn(),
    in: vi.fn(),
    then: (resolve: (value: typeof result) => unknown) => Promise.resolve(result).then(resolve),
  };
  builder.select.mockReturnValue(builder);
  builder.order.mockReturnValue(builder);
  builder.limit.mockReturnValue(builder);
  builder.in.mockReturnValue(builder);
  return builder;
}

describe("getPayoutCopReviews", () => {
  beforeEach(() => vi.clearAllMocks());

  it("keeps payout join filters within bounded request sizes", async () => {
    const reviews = Array.from({ length: 250 }, (_, index) => ({
      id: `review-${index}`,
      payout_profile_id: `profile-${index}`,
      account_id: `account-${index}`,
      provider_recipient_id: `recipient-${index}`,
      provider_payout_method_id: `method-${index}`,
      confirmation_of_payee_match_result: "mismatch",
      provider_message: null,
      status: "requested",
      requested_at: "2026-08-15T00:00:00.000Z",
      reviewed_at: null,
      reviewed_by: null,
      review_reason: null,
    }));
    const reviewQuery = query(reviews);
    const accountQuery = query([]);
    const profileQuery = query([]);
    getSupabaseAdminClient.mockReturnValue({
      from: vi.fn((table: string) => ({
        payout_cop_reviews: reviewQuery,
        accounts: accountQuery,
        account_payout_profiles: profileQuery,
      })[table]),
    });

    const { getPayoutCopReviews } = await import("./actions");
    await getPayoutCopReviews();

    expect(reviewQuery.select.mock.calls[0][0]).not.toContain("*");
    for (const builder of [accountQuery, profileQuery]) {
      expect(builder.in).toHaveBeenCalledTimes(3);
      for (const [, ids] of builder.in.mock.calls) {
        expect(ids.length).toBeGreaterThan(0);
        expect(ids.length).toBeLessThanOrEqual(100);
      }
    }
  });
});
