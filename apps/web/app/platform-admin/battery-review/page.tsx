import { getBatteryFilterOptions, getBatteryReviewPage } from "./actions";
import { BatteryReviewClient } from "./battery-review-client";
import type { BatteryEvidenceRow, BatteryReviewPage, BatteryReviewRow } from "./actions";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function BatteryReviewPage() {
  const [canonical, evidence, filterOptions] = await Promise.all([
    getBatteryReviewPage({ tab: "canonical" }),
    getBatteryReviewPage({ tab: "evidence" }),
    getBatteryFilterOptions(),
  ]);

  return <BatteryReviewClient initialCanonical={canonical as BatteryReviewPage<BatteryReviewRow>} initialEvidence={evidence as BatteryReviewPage<BatteryEvidenceRow>} filterOptions={filterOptions} />;
}
