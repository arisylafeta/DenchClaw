import { getLabelReviewPage } from "./actions";
import { LabelReviewClient } from "./label-review-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function LabelReviewPage() {
  return <LabelReviewClient initialPage={await getLabelReviewPage()} />;
}
