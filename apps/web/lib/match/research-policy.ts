// Research policy: which lot formats a company's observed activity makes it a possible buyer for.
// Facts (activities) are extracted from a company's own site; this table is the one place the judgement lives.
// Change it by bumping RESEARCH_POLICY_VERSION. Alex and Ari own it; outcomes of research outreach tune the weights.

export const RESEARCH_POLICY_VERSION = 1;

export type LotFormat = "cells" | "modules" | "packs" | "systems";
export const STRONG = 3;
export const MEDIUM = 2;

export type ResearchActivity = {
  /** Shown as "Research: <label> (site)". */
  label: string;
  /** Lot format to fit weight. A format that is absent does not fit. */
  formats: Partial<Record<LotFormat, number>>;
};

export const RESEARCH_POLICY: Record<string, ResearchActivity> = {
  repairs_ev_packs: { label: "repairs EV packs", formats: { packs: STRONG, modules: MEDIUM } },
  repairs_hybrid_packs: { label: "repairs hybrid packs", formats: { packs: STRONG, modules: MEDIUM } },
  replaces_modules: { label: "replaces modules", formats: { modules: STRONG } },
  replaces_cells: { label: "replaces cells", formats: { cells: MEDIUM } },
  builds_packs_from_cells: { label: "builds packs from cells", formats: { cells: STRONG, modules: MEDIUM } },
  sells_loose_cells: { label: "sells loose cells", formats: { cells: STRONG } },
  sells_finished_batteries: { label: "sells finished batteries", formats: {} },
  integrates_storage: { label: "integrates storage systems", formats: { modules: STRONG, packs: STRONG, systems: STRONG } },
  converts_vehicles: { label: "converts vehicles", formats: { packs: STRONG, modules: STRONG } },
  recycles: { label: "recycles", formats: { cells: MEDIUM, modules: MEDIUM, packs: MEDIUM, systems: MEDIUM } },
  trades_used_batteries: { label: "trades used batteries", formats: { cells: STRONG, modules: STRONG, packs: STRONG } },
  manufactures_batteries: { label: "manufactures batteries", formats: {} },
  none: { label: "no battery activity", formats: {} },
};

/** The strongest fit any of these activities gives a lot format, with the activity that gives it. Unknown activities are ignored. */
export function activityFit(activities: readonly string[], format: string | null | undefined): { weight: number; activity: string | null } {
  const fmt = String(format ?? "").toLowerCase() as LotFormat;
  let best = { weight: 0, activity: null as string | null };
  for (const activity of activities) {
    const weight = RESEARCH_POLICY[activity]?.formats[fmt] ?? 0;
    if (weight > best.weight) {
      best = { weight, activity };
    }
  }
  return best;
}
