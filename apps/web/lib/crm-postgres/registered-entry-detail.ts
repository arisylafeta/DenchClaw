import { queryPg } from "../postgres";

export type BulkTradeParty = {
  id: string;
  role: string;
  display_name: string;
  company_id?: string | null;
  channel?: string | null;
  observed_outcome?: string | null;
  first_evidence_at?: string | Date | null;
  latest_evidence_at?: string | Date | null;
  notes?: string | null;
};

export type BulkTradeWhatsAppEvidence = {
  id: string;
  relationship: string;
  evidence_note?: string | null;
  conversation: string;
  occurred_at?: string | Date | null;
  sender?: string | null;
  body: string;
};

export type BulkTradeGmailMessage = {
  id: string;
  sent_at?: string | Date | null;
  from_email?: string | null;
  body_preview?: string | null;
};

export type BulkTradeGmailEvidence = {
  id: string;
  relationship: string;
  evidence_note?: string | null;
  accessible: boolean;
  subject?: string | null;
  last_message_at?: string | Date | null;
  message_count?: number | null;
  messages: BulkTradeGmailMessage[];
};

export type BulkTradeOpportunityEvidence = {
  id: string;
  relationship: string;
  evidence_note?: string | null;
  title?: string | null;
  opportunity_type?: string | null;
  status?: string | null;
  quantity?: number | null;
  battery_type?: string | null;
  location_country?: string | null;
  updated_at?: string | Date | null;
};

export type RegisteredEntryDetail = {
  kind: "bulk_trade";
  parties: BulkTradeParty[];
  whatsappMessages: BulkTradeWhatsAppEvidence[];
  gmailThreads: BulkTradeGmailEvidence[];
  opportunities: BulkTradeOpportunityEvidence[];
};

type DetailReader = (entryId: string, userId: string) => Promise<RegisteredEntryDetail>;

async function readBulkTradeDetail(entryId: string, userId: string): Promise<RegisteredEntryDetail> {
  const parties = await queryPg<BulkTradeParty>(
    `select id, role, display_name, company_id, channel, observed_outcome,
            first_evidence_at, latest_evidence_at, notes
       from crm_bulk_trade_parties
      where lot_id = $1
      order by case role when 'buyer' then 1 when 'supplier' then 2 else 3 end,
               latest_evidence_at desc nulls last, display_name`,
    [entryId],
  );

  const whatsappMessages = await queryPg<BulkTradeWhatsAppEvidence>(
    `select message.id, link.relationship, link.note as evidence_note,
            message.conversation, message.occurred_at, message.sender, message.body
       from crm_bulk_trade_evidence_links link
       join crm_trade_evidence_messages message on message.id = link.evidence_id
      where link.lot_id = $1 and link.evidence_kind = 'whatsapp_message'
      order by message.occurred_at desc nulls last, message.id`,
    [entryId],
  );

  const gmailThreads = await queryPg<BulkTradeGmailEvidence>(
    `select link.evidence_id as id, link.relationship, link.note as evidence_note,
            (thread.id is not null) as accessible,
            thread.subject, thread.last_message_at, thread.message_count,
            coalesce(
              jsonb_agg(jsonb_build_object(
                'id', message.id,
                'sent_at', message.sent_at,
                'from_email', message.from_email,
                'body_preview', message.body_preview
              ) order by message.sent_at)
              filter (where message.id is not null),
              '[]'::jsonb
            ) as messages
       from crm_bulk_trade_evidence_links link
       left join crm_email_threads thread
         on thread.id = link.evidence_id and thread.mailbox_owner_id = $2::uuid
       left join crm_email_messages message
         on message.thread_id = thread.id and message.mailbox_owner_id = $2::uuid
      where link.lot_id = $1 and link.evidence_kind = 'gmail_thread'
      group by link.evidence_id, link.relationship, link.note, thread.id
      order by thread.last_message_at desc nulls last, link.evidence_id`,
    [entryId, userId],
  );

  const opportunities = await queryPg<BulkTradeOpportunityEvidence>(
    `select opportunity.id, link.relationship, link.note as evidence_note,
            opportunity.title, opportunity.opportunity_type, opportunity.status,
            opportunity.quantity, opportunity.battery_type,
            opportunity.location_country, opportunity.updated_at
       from crm_bulk_trade_evidence_links link
       join crm_commercial_opportunities opportunity on opportunity.id = link.evidence_id
      where link.lot_id = $1 and link.evidence_kind = 'crm_opportunity'
      order by opportunity.updated_at desc nulls last, opportunity.id`,
    [entryId],
  );

  return { kind: "bulk_trade", parties, whatsappMessages, gmailThreads, opportunities };
}

const detailReaders: Record<string, DetailReader> = {
  bulk_trade: readBulkTradeDetail,
};

export async function getRegisteredEntryDetail(
  objectName: string,
  entryId: string,
  userId: string,
): Promise<RegisteredEntryDetail | undefined> {
  const reader = detailReaders[objectName];
  return reader ? reader(entryId, userId) : undefined;
}
