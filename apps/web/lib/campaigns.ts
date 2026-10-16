export type CampaignMetrics = {
  sent: number | null;
  delivered: number | null;
  opened: number | null;
  clicked: number | null;
  bounced: number | null;
  opted_out: number | null;
  /** Recipients who emailed us back after the send (any synced mailbox). Ledger campaigns only. */
  replied: number | null;
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
  /** False for emails sent by hand from Gmail, which have no delivery, open or click events. */
  tracked: boolean;
  /** First email back from the recipient or their company after the send. */
  replied_at: string | null;
  subject: string | null;
  dismantler_id: string | null;
  dismantler_stage: string | null;
  listing_clicks: Array<{
    listing_id: string;
    label: string;
    first_clicked_at: string;
  }>;
  other_clicks: Array<{
    cta_key: string;
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
};

export type CampaignDetail = {
  campaign: CampaignSummary;
  recipients: CampaignRecipient[];
  listings: CampaignListing[];
  other_destinations: Array<{ cta_key: string; label: string }>;
  /** Where the emailed dismantlers are now, for dismantler outreach campaigns. */
  dismantler_funnel: { emailed: number; replied: number; stages: Record<string, number> } | null;
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
