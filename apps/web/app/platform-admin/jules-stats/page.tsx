import { loadJulesStats } from "./reads";
import { JulesStatsView } from "./jules-stats-view";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export default async function JulesStatsPage() {
  return <JulesStatsView stats={await loadJulesStats()} />;
}
