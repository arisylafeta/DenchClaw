export type PayoutCopReviewStatus =
  | "requested"
  | "processing"
  | "approved"
  | "rejected"
  | "cancelled";

export type PayoutCopReviewListItem = {
  id: string;
  status: PayoutCopReviewStatus;
  accountId: string;
  accountName: string;
  accountRole: string;
  payoutProfileStatus: string;
  payoutMethodLast4: string | null;
  payoutCountry: string | null;
  payoutCurrency: string | null;
  matchResult: "partial_match" | "mismatch" | "unavailable";
  providerMessage: string | null;
  requestedAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewReason: string | null;
};

export type PayoutCopReviewActionResult =
  | { success: true }
  | { success: false; error: string };
