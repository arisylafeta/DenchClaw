/** Buyer profile on a company (migration 019): who the buyer is and how we deal with them. */

/** How well the buyer knows us, furthest first last. Set by hand; crm_buyer_engagement suggests one. */
export const BUYER_STAGES = ["Identified", "Contacted", "Responded", "In conversation", "Qualified", "Bidding", "Customer"] as const;
export type BuyerStage = (typeof BUYER_STAGES)[number];
export const BUYER_TIERS = ["A", "B", "C"] as const;
export const BUYER_OWNERS = ["Alex", "Ari"] as const;
export const STANDARD_TERMS = ["Yes", "No", "Not asked"] as const;
export const BUYER_CAPABILITIES = [
  "Dismantle packs", "Test and grade", "BMS repair", "Cell rebuild", "Recycle", "Integrate systems", "HV workshop",
  "Dangerous-goods shipping",
] as const;

export type BuyerProfile = {
  stage: BuyerStage | null;
  stage_changed_on: string | null;
  tier: string | null;
  owner: string | null;
  capabilities: string[];
  can_receive_waste: boolean | null;
  accepts_standard_terms: string | null;
  collection: string | null;
  past_issues: string | null;
  outreach_notes: string | null;
  main_contact_id: string | null;
  next_step: string | null;
  next_step_on: string | null;
  category: string | null;
  workstream_status: string | null;
  evidence: string | null;
  last_reviewed_at: string | null;
};

/** What the company has done with us, from crm_buyer_engagement. Email covers both mailboxes; not WhatsApp. */
export type BuyerEngagement = {
  last_in_at: string | null;
  last_out_at: string | null;
  waiting_since: string | null;
  last_heard_at: string | null;
  emails_in_90d: number;
  emails_out_90d: number;
  meetings: number;
  last_meeting_at: string | null;
  campaign_clicks: number;
  auction_views: number;
  auction_offers: number;
  trades_offered: number;
  trades_won: number;
  bids: number;
  last_bid_at: string | null;
  open_requests: number;
  open_buy_boxes: number;
  agreed_buy_boxes: number;
  surveys: number;
  suggested_stage: BuyerStage;
};

export type BuyerProfileChange = { field: string; old_value: unknown; new_value: unknown; changed_at: string };

/** The field-registry names used to save each profile value through the company entry API. */
export const BUYER_FIELD_NAMES = {
  stage: "Buyer Stage",
  tier: "Buyer Tier",
  owner: "Buyer Owner",
  capabilities: "Buyer Capabilities",
  can_receive_waste: "Buyer Can Receive Waste",
  accepts_standard_terms: "Buyer Accepts Standard Terms",
  collection: "Buyer Collection",
  past_issues: "Buyer Past Issues",
  outreach_notes: "Buyer Outreach Notes",
  main_contact_id: "Buyer Main Contact",
  next_step: "Buyer Next Step",
  next_step_on: "Buyer Next Step On",
} as const satisfies Partial<Record<keyof BuyerProfile, string>>;

export function stageRank(stage: string | null | undefined): number {
  return stage ? BUYER_STAGES.indexOf(stage as BuyerStage) : -1;
}

/**
 * The engagement data's stage when it is further along than the one set by hand, else null. Qualified is
 * never suggested (it needs a confirmed buy-box), and Qualified set by hand is only passed by Bidding or Customer.
 */
export function stageToSuggest(set: string | null, suggested: BuyerStage): BuyerStage | null {
  return stageRank(suggested) > stageRank(set) ? suggested : null;
}

/** "Buyer Stage: Contacted → Responded" style label for a logged change. */
export function changeLabel(change: BuyerProfileChange): string {
  const name = change.field.replace(/^buyer_/, "").replace(/_id$/, "").replaceAll("_", " ");
  const show = (value: unknown) => (value === null || value === undefined ? "empty" : Array.isArray(value) ? value.join(", ") || "empty" : String(value));
  return `${name[0].toUpperCase()}${name.slice(1)}: ${show(change.old_value)} → ${show(change.new_value)}`;
}
