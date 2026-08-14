import { getPayoutCopReviews } from "./actions";
import { PayoutReviewsClient } from "./payout-reviews-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function PayoutReviewsPage() {
  const reviews = await getPayoutCopReviews();
  return <PayoutReviewsClient reviews={reviews} />;
}
