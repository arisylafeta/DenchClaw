/** Chance (0-100 %) that a deal completes, set per deal. Unset leaves the score unchanged. */
export const LIKELIHOOD_OPTIONS = [5, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100] as const;

export function likelihoodOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}

/** SQL expression: a listing score multiplied by the likelihood (percent) stored in `contextSql` (jsonb). Unset keeps the score; null stays null. */
export function likelihoodScoreSql(scoreSql: string, contextSql: string): string {
  return `round((${scoreSql}) * coalesce((${contextSql}->>'likelihood')::numeric / 100, 1))::int`;
}
