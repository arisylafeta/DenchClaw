export type CampaignMetrics = {
  sent: number | null;
  delivered: number | null;
  opened: number | null;
  clicked: number | null;
  bounced: number | null;
  opted_out: number | null;
};

export type CampaignSummary = {
  id: string;
  name: string;
  status: string;
  type: string | null;
  channel: string | null;
  audience: string | null;
  launched_at: string | null;
  last_invite_at: string | null;
  audience_size: number | null;
  metrics: CampaignMetrics;
  metrics_basis: "snapshot" | "ledger";
  metrics_observed_at: string | null;
  recipient_count: number;
  tracking_pending: number;
};

export type CampaignRecipient = {
  send_id: string;
  person_id: string;
  person_name: string | null;
  company_id: string | null;
  company_name: string | null;
  recipient_email: string;
  state: string;
  accepted_at: string | null;
  delivered_at: string | null;
  bounced_at: string | null;
  opened_at: string | null;
  clicked_at: string | null;
  last_synced_at: string | null;
  tracking_pending: boolean;
  listing_clicks: Array<{
    listing_id: string;
    label: string;
    first_clicked_at: string;
  }>;
};

export type CampaignListing = {
  listing_id: string;
  label: string;
  url: string | null;
  recipients: number;
  clicked_recipients: number;
  clicked_people: Array<{
    person_id: string;
    name: string;
    company_name: string | null;
  }>;
};

export type CampaignDetail = {
  campaign: CampaignSummary;
  recipients: CampaignRecipient[];
  listings: CampaignListing[];
  details: {
    auction_slug: string | null;
    source_system: string | null;
    audience_raw: string | null;
    notes: string | null;
    created_at: string | null;
    updated_at: string | null;
    objective: string | null;
    success_measure: string | null;
    message_version: string | null;
    stock_snapshot_ref: string | null;
    sender_identity: string | null;
    reply_owner: string | null;
    reply_mailbox: string | null;
    approved_manifest_sha256: string | null;
    approved_by: string | null;
    approved_at: string | null;
    reviewed_at: string | null;
  };
};
