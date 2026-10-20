import type { CampaignDetail } from './campaigns';

export type MailPurpose = 'personal' | 'marketing' | 'transactional';
export type MailTransport = 'gmail' | 'postmark-broadcast' | 'postmark-transactional';
export type MailEvent = { id: number; message_id: string; type: string; source: string; occurred_at: string; detail: Record<string, unknown> };
export type MailMessageRow = {
  id: string; thread_id: string | null; campaign_id: string | null; identity_key: string | null;
  direction: 'inbound' | 'outbound'; transport: MailTransport; purpose: MailPurpose | null; state: string;
  subject: string | null; from_email: string | null; from_person_id: string | null;
  is_self: boolean;
  counterparty?: { email: string; name: string | null } | null;
  to_emails: string[]; cc_emails: string[]; recipient_email: string | null; person_id: string | null;
  body_text: string | null; body_html: string | null; body_preview: string | null;
  sent_at: string | null; created_at: string; accepted_at: string | null; delivered_at: string | null;
  bounced_at: string | null; opened_at: string | null; clicked_at: string | null; replied_at: string | null;
  crm_visible: boolean; has_attachments: boolean; gmail_message_id: string | null;
  events?: MailEvent[];
};
export type MailParticipant = { id: string; name: string | null; email: string | null; avatar_url: string | null; is_self: boolean };
export type MailMessageListRow = Omit<MailMessageRow, 'body_text' | 'body_html'> & { message_count?: number; participants?: MailParticipant[] };
export type MailThread = { id: string; subject: string | null; last_message_at: string | null; message_count: number; gmail_thread_id: string | null; messages: MailMessageRow[] };
export type MailCounts = { sent: number; delivered: number; bounced: number; opened: number; clicked: number; unsubscribed: number; replied: number };
export type MailCampaignSummary = MailCounts & { id: string; campaign_name: string; identity_key: string | null; purpose: MailPurpose | null; mail_state: string; total: number };
export type MailLink = { id: string; message_id: string; cta_key: string; destination_url: string; first_clicked_at: string | null };
export type MailCampaignDetail = CampaignDetail & MailCampaignSummary & { counts: MailCounts; delivery_rows: MailMessageListRow[]; links: MailLink[]; scanner_evidence: boolean; proxy_evidence: boolean };
export type MailFollowup = { id: string; message_id: string | null; thread_id: string | null; person_id: string | null; identity_key: string | null; due_at: string; origin: string; state: string; note: string | null; paused_reason: string | null };
export type MailFilters = { view?: 'conversations' | 'campaigns' | 'sent' | 'followups'; q?: string; from?: string; to?: string; identity?: string; campaign?: string; thread?: string; person?: string; direction?: string; transport?: string; purpose?: string; state?: string; event?: string; crmOnly?: boolean; since?: string; until?: string; cursor?: string; limit?: number; mailboxOwnerId?: string };
export type MailPage<T> = { items: T[]; nextCursor: string | null };

export type MailApproval = { id: string; sha256: string; scope: 'pilot' | 'full'; approved_by: string; approved_at: string; expires_at: string | null; revoked_at: string | null; recipient_count: number };
export type MailDraft = {
  id: string; state: string; identity_key: string | null; transport: MailTransport; purpose: MailPurpose | null;
  from_email: string | null; to_emails: string[]; cc_emails: string[]; bcc_emails: string[]; subject: string | null;
  body_text: string | null; body_html: string | null; thread_id: string | null; campaign_id: string | null;
  created_at: string; links: { cta_key: string; destination_url: string }[]; warnings: string[];
  approval: MailApproval | null;
};
export type MailDraftListRow = Pick<MailDraft, 'id' | 'state' | 'identity_key' | 'from_email' | 'to_emails' | 'subject' | 'created_at'> & { body_preview: string | null };
