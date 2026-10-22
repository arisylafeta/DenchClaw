// Home: assembles the page payload from the three sources (weekly snapshots, live platform rows, CRM
// bulk trades), writes the one-line readings and the data-health notes. Pure, so it is unit tested.
// Either live source can fail on its own; the page then shows what it has and says what is missing.
import type { PulseWeek } from "./marketplace-pulse";
import type { BulkHome, ClosingLot } from "./home-bulk";
import type { PlatformHome, ReplyBuckets, SinceDeal } from "./home-platform";
import {
  EUR_GBP, POSTHOG_UNDERCOUNT_SINCE, REPLY_SINCE, TARGETS,
  biggestDrop, dayLabel, fillRate, freshness, funnelEnd, funnelSteps, funnelWeeks, longDayLabel, mondayOf,
  monthName, monthPosition, pace, percent, snapshotSum, daysBetween,
  type Freshness, type FunnelStepKey, type FunnelStepStat, type Pace, type WindowRate,
} from "./home-metrics";

/** A reading is plain text with some figures in bold. */
export type Segment = string | { strong: string };

export type HealthItem = { warn: boolean; title: string | null; text: string };

export type HomeData = {
  now: string;
  header: {
    date: string;
    day: number;
    days_in_month: number;
    /** Day the live platform numbers run to; null when the platform could not be read. */
    platform_to: string | null;
    funnel: Freshness;
    targets: { label: string; source: string }[];
  };
  marketplace: {
    paid: number;
    pace: Pace;
    last_paid_at: string | null;
    last_paid_days: number | null;
    /** Paid over sent across the funnel chart's weeks. */
    fill: (WindowRate & { since: string }) | null;
  } | null;
  bulk_goal: { closed: number; pace: Pace; closing: ClosingLot[]; lost: number; month_label: string } | null;
  fees: {
    ytd_gbp: number;
    month_gbp: number;
    month_label: string;
    top_share: number | null;
    top_label: string | null;
    paid_deals_ytd: number;
    goal_label: string;
    goal_source: string;
  } | null;
  reply: (ReplyBuckets & { since: string; target_label: string }) | null;
  since_deal: SinceDeal | null;
  overview: (PlatformHome["overview"] & { reading: Segment[]; no_deal_since: string | null }) | null;
  funnel: {
    weeks: string[];
    steps: (FunnelStepStat & { reading: Segment[] })[];
    biggest_drop: FunnelStepKey | null;
  } | null;
  bulk: (BulkHome & { teaser_note: string | null }) | null;
  health: HealthItem[];
  errors: { platform: string | null; crm: string | null };
};

/** Days without a new deal before the overview chart calls it out. */
export const NO_DEAL_CALLOUT_DAYS = 14;

const list = (values: number[]) => values.join(", ");

/** "Enquiries went 5, 5, 24 ... Deals opened went 1, 6, 1. Demand is arriving; it is not turning into deals." */
export function overviewReading(enquiryBlocks: number[], openedBlocks: number[]): Segment[] {
  const [ePrev, eLast] = enquiryBlocks.slice(-2);
  const [oPrev, oLast] = openedBlocks.slice(-2);
  let verdict = "";
  if (eLast > ePrev && oLast <= oPrev) {verdict = " Demand is arriving; it is not turning into deals.";}
  else if (eLast > ePrev && oLast > oPrev) {verdict = " Both are rising.";}
  else if (eLast < ePrev) {verdict = " Fewer buyers enquired than in the 30 days before.";}
  return [
    "Enquiries went ", { strong: list(enquiryBlocks) }, " across the last three 30-day blocks. Deals opened went ",
    { strong: list(openedBlocks) }, `.${verdict}`,
  ];
}

/** One line under a funnel step's chart. */
export function stepReading(step: FunnelStepStat, isBiggestDrop: boolean, fill: (WindowRate & { since: string }) | null): Segment[] {
  const { current: cur, previous: prev } = step;
  if (cur.rate === null && prev.rate === null) {return ["No data yet for this step."];}
  switch (step.key) {
    case "visit_view": {
      if (cur.rate !== null && prev.rate !== null && Math.abs(step.delta_pts!) < 5) {
        return [`About ${Math.round(cur.rate * 10)} in 10 visitors open a listing in both periods. Reach is not the constraint.`];
      }
      return [{ strong: percent(cur.rate) }, " of visitors opened a listing in the last 4 weeks, against ", { strong: percent(prev.rate) }, " before."];
    }
    case "view_start": {
      const doubled = prev.num > 0 && cur.num >= 2 * prev.num ? " More than double." : "";
      return ["Starts went from ", { strong: String(prev.num) }, " to ", { strong: String(cur.num) }, ` in the last 4 weeks.${doubled}`];
    }
    case "start_send": {
      const out: Segment[] = [`Starts went from ${prev.den} to ${cur.den}, sends from ${prev.num} to ${cur.num}.`];
      // The week in the last four where the most starts went unsent.
      const unsent = (w: FunnelStepStat["weekly"][number]) => (w.den ?? 0) - (w.num ?? 0);
      const worst = step.weekly.slice(-4).filter((w) => unsent(w) >= 5).toSorted((a, b) => unsent(b) - unsent(a))[0];
      if (worst) {out.push(` Week of ${dayLabel(worst.week_start)}: `, { strong: `${worst.den} started, ${worst.num ?? 0} sent` }, ".");}
      if (isBiggestDrop) {out.push(" Fix the send step before buying traffic.");}
      return out;
    }
    case "send_paid": {
      if (!fill || fill.den === 0) {return ["No sent messages, offers or buys yet."];}
      const out: Segment[] = [{ strong: `${fill.num} paid of ${fill.den} sent` }, ` since ${dayLabel(fill.since)}.`];
      if (fill.num > 0) {out.push(` One more paid deal needs about ${Math.round(fill.den / fill.num)} more sent at this rate.`);}
      else {out.push(" None has turned into a paid deal in that time.");}
      return out;
    }
  }
}

/** "7 of 49 buyers who got a teaser moved past it (14%). Teaser to NDA is the leak." */
export function teaserNote(passed: number, total: number): string | null {
  if (total === 0) {return null;}
  const share = passed / total;
  const leak = share < 0.25 ? " Teaser to NDA is the leak." : "";
  return `${passed} of ${total} buyers who got a teaser moved past it (${Math.round(share * 100)}%).${leak}`;
}

export function healthItems(input: {
  funnel: Freshness;
  reply: ReplyBuckets | null;
  weeks: PulseWeek[];
  platformError: string | null;
  crmError: string | null;
  skippedFees: number;
}): HealthItem[] {
  const items: HealthItem[] = [];
  if (input.platformError) {items.push({ warn: true, title: "Platform numbers missing:", text: input.platformError });}
  if (input.crmError) {items.push({ warn: true, title: "CRM numbers missing:", text: input.crmError });}
  if (input.funnel.stale) {
    items.push(input.funnel.collected_at
      ? { warn: true, title: "Weekly funnel stale", text: `since ${dayLabel(input.funnel.collected_at)} (collector stopped)` }
      : { warn: true, title: "Weekly funnel", text: "has no data yet" });
  }
  items.push({ warn: true, title: "Visitors about half", text: `of real traffic since the ${dayLabel(POSTHOG_UNDERCOUNT_SINCE)} consent change` });
  const fromWeek = mondayOf(new Date(`${REPLY_SINCE}T00:00:00Z`));
  const snapAnswered = snapshotSum(input.weeks, "reply_24h", fromWeek);
  const snapAsked = snapshotSum(input.weeks, "reply_intents", fromWeek);
  if (input.reply && snapAsked !== null) {
    const liveAsked = input.reply.within + input.reply.later + input.reply.never;
    const snap = snapAnswered ?? 0;
    if (liveAsked !== snapAsked || input.reply.within !== snap) {
      items.push({ warn: true, title: "Reply counts differ:", text: `live ${input.reply.within} of ${liveAsked}, snapshots ${snap} of ${snapAsked}` });
    }
  }
  if (input.skippedFees > 0) {
    items.push({ warn: true, title: "Fees left out:", text: `${input.skippedFees} in a currency without a set rate` });
  }
  items.push({
    warn: false,
    title: null,
    text: `Paid deals counted by payment date, not by week as in Pulse. Euro fees at ${EUR_GBP} to the pound. Open lots leave out On hold.`,
  });
  return items;
}

export function buildHome(input: {
  now: Date;
  weeks: PulseWeek[];
  collectedAt: string | null;
  platform: PlatformHome | null;
  platformError: string | null;
  bulk: BulkHome | null;
  crmError: string | null;
}): HomeData {
  const { now, weeks, platform, bulk } = input;
  const position = monthPosition(now);
  const month_label = monthName(position.month);
  const funnelFresh = freshness(input.collectedAt, now);

  const end = funnelEnd(weeks, now);
  const chartWeeks = end ? funnelWeeks(weeks, end) : [];
  const fill = chartWeeks.length ? { ...fillRate(weeks, chartWeeks), since: chartWeeks[0] } : null;
  const steps = end ? funnelSteps(weeks, end, chartWeeks) : [];
  const drop = biggestDrop(steps);

  const marketTarget = TARGETS.marketplace_paid;
  const bulkTarget = TARGETS.bulk_closed;
  const feeGoal = TARGETS.fees_long_term;

  return {
    now: now.toISOString(),
    header: {
      date: longDayLabel(now),
      day: position.day,
      days_in_month: position.days_in_month,
      platform_to: platform ? now.toISOString() : null,
      funnel: funnelFresh,
      targets: Object.values(TARGETS).filter((t) => t.header).map((t) => ({ label: t.label, source: t.source })),
    },
    marketplace: platform
      ? {
        paid: platform.paid_this_month,
        pace: pace(platform.paid_this_month, marketTarget.value, now),
        last_paid_at: platform.last_paid_at,
        last_paid_days: platform.last_paid_at ? daysBetween(platform.last_paid_at, now) : null,
        fill,
      }
      : null,
    bulk_goal: bulk
      ? { closed: bulk.closed_this_month, pace: pace(bulk.closed_this_month, bulkTarget.value, now), closing: bulk.closing, lost: bulk.lost_this_month, month_label }
      : null,
    fees: platform
      ? {
        ytd_gbp: platform.fees.ytd_gbp,
        month_gbp: platform.fees.month_gbp,
        month_label,
        top_share: platform.fees.top_share,
        top_label: platform.fees.top_label,
        paid_deals_ytd: platform.fees.paid_deals_ytd,
        goal_label: feeGoal.label,
        goal_source: feeGoal.source,
      }
      : null,
    reply: platform ? { ...platform.reply, since: REPLY_SINCE, target_label: TARGETS.seller_reply.label } : null,
    since_deal: platform?.since_deal ?? null,
    overview: platform
      ? {
        ...platform.overview,
        reading: overviewReading(platform.overview.enquiry_blocks, platform.overview.opened_blocks),
        no_deal_since: platform.since_deal && platform.since_deal.days >= NO_DEAL_CALLOUT_DAYS ? platform.since_deal.last_at : null,
      }
      : null,
    funnel: steps.length
      ? { weeks: chartWeeks, steps: steps.map((s) => ({ ...s, reading: stepReading(s, s.key === drop, fill) })), biggest_drop: drop }
      : null,
    bulk: bulk ? { ...bulk, teaser_note: teaserNote(bulk.buyers.teaser_passed, bulk.buyers.teaser_total) } : null,
    health: healthItems({
      funnel: funnelFresh,
      reply: platform?.reply ?? null,
      weeks,
      platformError: input.platformError,
      crmError: input.crmError,
      skippedFees: platform?.fees.skipped ?? 0,
    }),
    errors: { platform: input.platformError, crm: input.crmError },
  };
}
