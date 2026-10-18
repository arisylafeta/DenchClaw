export type Reputation = "paid" | "active" | "email" | "inbound" | "anon";
export type PriceBasis = "buyer" | "estimate";
export type ScoreBand = "Hot" | "Warm" | "Low" | "Cold";
export const REPUTATION_LABEL: Record<Reputation, string> = {
  paid: "Paid us before", active: "Active buyer", email: "Emailing", inbound: "Single inbound", anon: "Unknown",
};
const CLOSE_CHANCE: Record<Reputation, number> = { paid: .60, active: .35, email: .20, inbound: .10, anon: .03 };
const day = (value: string | Date) => Date.parse((typeof value === "string" ? value : value.toISOString()).slice(0, 10) + "T00:00:00Z");

/** Mirrors bulk_demand_score / bulk_demand_expected_fee. Date-only arithmetic avoids DST drift. */
export function scoreDemand(input: {
  feeEur: number | null; priceBasis: PriceBasis | null; reputation: Reputation | null; askedOn: string | null;
}, today: string | Date = new Date()) {
  const daysAgo = input.askedOn ? Math.max(0, Math.floor((day(today) - day(input.askedOn)) / 86_400_000)) : 0;
  const freshness = Math.pow(.5, daysAgo / 30);
  const closeChance = CLOSE_CHANCE[input.reputation ?? "anon"];
  const expectedFee = input.feeEur === null ? null : input.feeEur * (input.priceBasis === "buyer" ? 1 : .5) * closeChance * freshness;
  const score = expectedFee === null ? null : Math.min(100, Math.round(25 * Math.log10(1 + expectedFee)));
  const band: ScoreBand | null = score === null ? null : score >= 80 ? "Hot" : score >= 60 ? "Warm" : score >= 40 ? "Low" : "Cold";
  return { score, band, expectedFee, closeChance, freshness, daysAgo };
}

export function formatFee(feeEur: number | null): string {
  if (feeEur === null) return "Needs quantity";
  return new Intl.NumberFormat("en-IE", { style: "currency", currency: "EUR", notation: feeEur >= 1000 ? "compact" : "standard", maximumFractionDigits: 1 }).format(feeEur);
}
