export const CONVICTIONS = ["high", "medium", "low"] as const;
export type Conviction = (typeof CONVICTIONS)[number];
export const CONVICTION_LABEL: Record<Conviction, string> = { high: "High conviction", medium: "Medium conviction", low: "Low conviction" };
/** Score multiplier per conviction. Medium (and unset) leaves the score unchanged. */
export const CONVICTION_FACTOR: Record<Conviction, number> = { high: 1.3, medium: 1, low: 0.6 };

export function convictionOf(value: unknown): Conviction {
  return CONVICTIONS.find((c) => c === value) ?? "medium";
}

/** SQL expression: a listing score scaled by the conviction stored in `contextSql` (jsonb), capped at 100. Null stays null. */
export function convictionScoreSql(scoreSql: string, contextSql: string): string {
  return `least(100, round((${scoreSql}) * case ${contextSql}->>'conviction' when 'high' then ${CONVICTION_FACTOR.high} when 'low' then ${CONVICTION_FACTOR.low} else 1 end))::int`;
}
