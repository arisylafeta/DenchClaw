import { getBatteryEvidencePage } from "./actions";
import { BatteryReviewClient } from "./battery-review-client";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function BatteryReviewPage() {
  return <BatteryReviewClient initialPage={await getBatteryEvidencePage()} />;
}
