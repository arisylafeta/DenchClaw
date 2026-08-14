"use server";

import { unstable_noStore as noStore, revalidatePath } from "next/cache";
import { getSupabaseAdminClient } from "@/lib/platform-admin/supabase";
import { getStripeGlobalPayoutsAdminClient } from "@/lib/platform-admin/payouts/stripe-global-payouts";
import type {
  PayoutCopReviewActionResult,
  PayoutCopReviewListItem,
  PayoutCopReviewStatus,
} from "./types";

type ReviewRow = {
  id: string;
  payout_profile_id: string;
  account_id: string;
  provider_recipient_id: string;
  provider_payout_method_id: string;
  confirmation_of_payee_match_result:
    | "partial_match"
    | "mismatch"
    | "unavailable";
  provider_message: string | null;
  status: PayoutCopReviewStatus;
  requested_at: string;
  reviewed_at: string | null;
  reviewed_by: string | null;
  review_reason: string | null;
};

type ProfileRow = {
  id: string;
  provider_recipient_id: string | null;
  provider_payout_method_id: string | null;
  status: string;
  method_last4: string | null;
  country: string | null;
  default_currency: string | null;
};

type AccountRow = { id: string; name: string; role: string };

function adminDb() {
  // The admin app's copied generated types predate Held Payouts. This cast is
  // contained at the new shared-table boundary until its next full regen.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return getSupabaseAdminClient() as any;
}

function cleanReviewInput(input: {
  reviewerName: string;
  reason: string;
}): { reviewerName: string; reason: string } {
  const reviewerName = input.reviewerName.trim();
  const reason = input.reason.trim();
  if (reviewerName.length < 2 || reviewerName.length > 100) {
    throw new Error("Enter the reviewing operator's name");
  }
  if (reason.length < 10 || reason.length > 1000) {
    throw new Error("Enter a review reason of at least 10 characters");
  }
  return { reviewerName, reason };
}

async function loadReviewAndProfile(reviewId: string): Promise<{
  review: ReviewRow;
  profile: ProfileRow;
}> {
  const db = adminDb();
  const { data: review, error: reviewError } = await db
    .from("payout_cop_reviews")
    .select("*")
    .eq("id", reviewId)
    .single();
  if (reviewError || !review) {
    throw new Error(reviewError?.message ?? "Payout review not found");
  }

  const { data: profile, error: profileError } = await db
    .from("account_payout_profiles")
    .select(
      "id, provider_recipient_id, provider_payout_method_id, status, method_last4, country, default_currency",
    )
    .eq("id", review.payout_profile_id)
    .single();
  if (profileError || !profile) {
    throw new Error(profileError?.message ?? "Payout profile not found");
  }
  return { review: review as ReviewRow, profile: profile as ProfileRow };
}

export async function getPayoutCopReviews(): Promise<
  PayoutCopReviewListItem[]
> {
  noStore();
  const db = adminDb();
  const { data: reviews, error } = await db
    .from("payout_cop_reviews")
    .select("*")
    .order("requested_at", { ascending: false })
    .limit(250);
  if (error) throw new Error(error.message);
  if (!reviews?.length) return [];

  const typedReviews = reviews as ReviewRow[];
  const accountIds = [...new Set(typedReviews.map((review) => review.account_id))];
  const profileIds = [
    ...new Set(typedReviews.map((review) => review.payout_profile_id)),
  ];
  const [accountsResult, profilesResult] = await Promise.all([
    db.from("accounts").select("id, name, role").in("id", accountIds),
    db
      .from("account_payout_profiles")
      .select(
        "id, provider_recipient_id, provider_payout_method_id, status, method_last4, country, default_currency",
      )
      .in("id", profileIds),
  ]);
  if (accountsResult.error) throw new Error(accountsResult.error.message);
  if (profilesResult.error) throw new Error(profilesResult.error.message);

  const accounts = new Map<string, AccountRow>(
    ((accountsResult.data ?? []) as AccountRow[]).map((account) => [
      account.id,
      account,
    ]),
  );
  const profiles = new Map<string, ProfileRow>(
    ((profilesResult.data ?? []) as ProfileRow[]).map((profile) => [
      profile.id,
      profile,
    ]),
  );

  return typedReviews.map((review) => {
    const account = accounts.get(review.account_id);
    const profile = profiles.get(review.payout_profile_id);
    return {
      id: review.id,
      status: review.status,
      accountId: review.account_id,
      accountName: account?.name ?? "Unknown account",
      accountRole: account?.role ?? "unknown",
      payoutProfileStatus: profile?.status ?? "unknown",
      payoutMethodLast4: profile?.method_last4 ?? null,
      payoutCountry: profile?.country ?? null,
      payoutCurrency: profile?.default_currency ?? null,
      matchResult: review.confirmation_of_payee_match_result,
      providerMessage: review.provider_message,
      requestedAt: review.requested_at,
      reviewedAt: review.reviewed_at,
      reviewedBy: review.reviewed_by,
      reviewReason: review.review_reason,
    };
  });
}

export async function approvePayoutCopReview(input: {
  reviewId: string;
  reviewerName: string;
  reason: string;
}): Promise<PayoutCopReviewActionResult> {
  let externallyConfirmed = false;
  let claimedReviewId: string | null = null;
  try {
    const { reviewerName, reason } = cleanReviewInput(input);
    const db = adminDb();
    const loaded = await loadReviewAndProfile(input.reviewId);
    if (loaded.review.status === "approved") return { success: true };
    if (!["requested", "processing"].includes(loaded.review.status)) {
      throw new Error(`This review is already ${loaded.review.status}`);
    }
    if (
      loaded.profile.provider_recipient_id !==
        loaded.review.provider_recipient_id ||
      loaded.profile.provider_payout_method_id !==
        loaded.review.provider_payout_method_id
    ) {
      throw new Error("The payout method changed after this review was requested");
    }

    let review = loaded.review;
    if (review.status === "requested") {
      const { data: claimed, error: claimError } = await db
        .from("payout_cop_reviews")
        .update({
          status: "processing",
          reviewed_at: new Date().toISOString(),
          reviewed_by: reviewerName,
          review_reason: reason,
        })
        .eq("id", review.id)
        .eq("status", "requested")
        .select("*")
        .maybeSingle();
      if (claimError) throw new Error(claimError.message);
      if (!claimed) throw new Error("This review is already being processed");
      review = claimed as ReviewRow;
    }
    claimedReviewId = review.id;

    const stripe = getStripeGlobalPayoutsAdminClient();
    const context = await stripe.retrieveReviewContext({
      recipientId: review.provider_recipient_id,
      payoutMethodId: review.provider_payout_method_id,
    });
    if (
      context.recipientId !== review.provider_recipient_id ||
      context.payoutMethodId !== review.provider_payout_method_id ||
      context.payoutMethodType !== "gb_bank_account"
    ) {
      throw new Error("Stripe returned a different payout recipient or method");
    }
    if (
      context.confirmationOfPayeeMatchResult !==
      review.confirmation_of_payee_match_result
    ) {
      throw new Error("The Stripe bank-name result changed; request a fresh review");
    }

    const confirmation =
      context.confirmationOfPayeeStatus === "confirmed"
        ? context
        : context.confirmationOfPayeeStatus === "awaiting_acknowledgement"
          ? await stripe.acknowledgeConfirmationOfPayee({
              recipientId: review.provider_recipient_id,
              payoutMethodId: review.provider_payout_method_id,
              idempotencyKey: `cop-review:${review.id}`,
            })
          : null;
    if (!confirmation || confirmation.confirmationOfPayeeStatus !== "confirmed") {
      throw new Error("The bank account is not ready for CoP acknowledgement");
    }
    externallyConfirmed = true;

    const acknowledgedAt = new Date().toISOString();
    // Persist the profile first. If finalizing the review fails afterward, the
    // review remains processing and a retry can safely repeat both writes.
    const { data: updatedProfile, error: profileError } = await db
      .from("account_payout_profiles")
      .update({
        confirmation_of_payee_status: "confirmed",
        confirmation_of_payee_match_result:
          confirmation.confirmationOfPayeeMatchResult,
        confirmation_of_payee_message: confirmation.confirmationOfPayeeMessage,
        confirmation_of_payee_checked_at:
          confirmation.confirmationOfPayeeCheckedAt,
        status:
          context.accountReadiness === "active"
            ? "active"
            : context.accountReadiness,
        activated_at:
          context.accountReadiness === "active" ? acknowledgedAt : null,
        restricted_at:
          context.accountReadiness === "active" ? null : acknowledgedAt,
        last_synced_at: acknowledgedAt,
      })
      .eq("id", loaded.profile.id)
      .eq("provider_recipient_id", review.provider_recipient_id)
      .eq("provider_payout_method_id", review.provider_payout_method_id)
      .select("id")
      .maybeSingle();
    if (profileError || !updatedProfile) {
      throw new Error(profileError?.message ?? "Could not update the payout profile");
    }

    const { data: approved, error: approvalError } = await db
      .from("payout_cop_reviews")
      .update({
        status: "approved",
        provider_acknowledged_at: acknowledgedAt,
        provider_request_id: confirmation.requestId ?? context.requestId,
      })
      .eq("id", review.id)
      .eq("status", "processing")
      .select("id")
      .maybeSingle();
    if (approvalError || !approved) {
      throw new Error(approvalError?.message ?? "Could not finalize the review");
    }

    revalidatePath("/platform-admin/payout-reviews");
    return { success: true };
  } catch (error) {
    if (claimedReviewId && !externallyConfirmed) {
      await adminDb()
        .from("payout_cop_reviews")
        .update({
          status: "requested",
          reviewed_at: null,
          reviewed_by: null,
          review_reason: null,
        })
        .eq("id", claimedReviewId)
        .eq("status", "processing");
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not approve review",
    };
  }
}

export async function rejectPayoutCopReview(input: {
  reviewId: string;
  reviewerName: string;
  reason: string;
}): Promise<PayoutCopReviewActionResult> {
  try {
    const { reviewerName, reason } = cleanReviewInput(input);
    const db = adminDb();
    const { data, error } = await db
      .from("payout_cop_reviews")
      .update({
        status: "rejected",
        reviewed_at: new Date().toISOString(),
        reviewed_by: reviewerName,
        review_reason: reason,
      })
      .eq("id", input.reviewId)
      .eq("status", "requested")
      .select("id")
      .maybeSingle();
    if (error) throw new Error(error.message);
    if (!data) throw new Error("This review is no longer awaiting a decision");

    revalidatePath("/platform-admin/payout-reviews");
    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Could not reject review",
    };
  }
}
