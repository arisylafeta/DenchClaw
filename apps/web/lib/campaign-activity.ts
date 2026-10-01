export type CampaignActivityCounts = {
  redirect_events: number;
  page_views: number;
  sessions: number;
  offer_events: number;
  message_events: number;
  buy_now_events: number;
};

export type CampaignActivityTotals = CampaignActivityCounts & {
  redirect_recipients: number;
  visited_recipients: number;
  offer_recipients: number;
  message_recipients: number;
  buy_now_recipients: number;
};

export type CampaignActivityPerson = CampaignActivityCounts & {
  person_id: string;
  email_clicked_at: string | null;
  first_browser_at: string | null;
  last_browser_at: string | null;
  last_offer_at: string | null;
  last_message_at: string | null;
  last_buy_now_at: string | null;
};

export type CampaignActivityDestination = CampaignActivityTotals & {
  cta_key: string;
  listing_id: string | null;
  label: string;
  recipient_count: number;
  email_clicked_recipients: number;
  people: CampaignActivityPerson[];
};

export type CampaignActivity = {
  campaign_id: string;
  status: "available" | "unmapped" | "unavailable";
  unavailable_reason: "credentials_missing" | "manifest_missing" | "manifest_invalid" | "provider_unavailable" | "provider_incomplete" | "campaign_not_tracked" | null;
  observed_at: string | null;
  period_start: string | null;
  period_end: string | null;
  totals: CampaignActivityTotals | null;
  destinations: CampaignActivityDestination[];
};
