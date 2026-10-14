export const SCORING = {
  version: 1,
  halfLifeDays: 14,
  weights: {
    listing_offer_submitted: 40, listing_buy_now_submitted: 40, auction_bid_submitted: 40,
    sourcing_request_submitted: 25, listing_message_submitted: 25,
    saved_search_created: 12, quote_capture_started: 12,
    listing_buying_guide_documentation_clicked: 12, marketplace_listing_saved: 12,
    marketplace_listing_clicked: 2,
  } as Record<string, number>,
};
export const SEGMENTS = ['new', 'active', 'rising', 'cooling', 'dormant', 'never_active'] as const;
export type Segment = typeof SEGMENTS[number];
export type Activity = {
  authUserId: string; role: string | null; accountStatus: string | null;
  totalEvents: number; lastSeen: string | null; sessions: number; activeDays: number;
  engagementScore: number; recentEvents: number; previousEvents: number;
  actions: {event: string; count: number}[]; hasOffer: boolean;
};
export function scoreActivity(activity: Activity, now: number) {
  const intentScore = activity.actions.reduce((sum, action) => sum + (SCORING.weights[action.event] ?? 0) * action.count, 0);
  const age = activity.lastSeen ? Math.max(0, (now - Date.parse(activity.lastSeen)) / 86400000) : Infinity;
  return { intentScore, engagementScore: activity.engagementScore, score: Math.round(intentScore * Math.pow(0.5, age / SCORING.halfLifeDays) * 100) / 100 };
}
export function assignSegment(activity: Activity | undefined, createdAt: string | null, now: number): Segment {
  if (!activity || activity.totalEvents === 0 || !activity.lastSeen) return 'never_active';
  const age = (now - Date.parse(activity.lastSeen)) / 86400000;
  if (age >= 30) return 'dormant';
  if (createdAt && now - Date.parse(createdAt) < 7 * 86400000) return 'new';
  if (age >= 7) return 'cooling';
  if (activity.recentEvents >= 3 && activity.recentEvents > activity.previousEvents * 1.5) return 'rising';
  return 'active';
}
