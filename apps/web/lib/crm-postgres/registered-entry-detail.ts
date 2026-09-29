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
  mailbox_owner_email?: string | null;
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

export type CampaignRecipient = {
  person_id: string;
  person_name: string | null;
  recipient_email: string;
  state: string;
  provider_message_id: string | null;
  accepted_at: string | Date | null;
  delivered_at: string | Date | null;
  bounced_at: string | Date | null;
  provider_opened_at: string | Date | null;
  provider_link_clicked_at: string | Date | null;
  clicked_ctas?: Array<{ cta_key: string; destination_url: string; first_clicked_at: string | Date | null }>;
};

export type BulkTradeEntryDetail = {
  kind: "bulk_trade";
  parties: BulkTradeParty[];
  whatsappMessages: BulkTradeWhatsAppEvidence[];
  gmailThreads: BulkTradeGmailEvidence[];
  opportunities: BulkTradeOpportunityEvidence[];
};

export type RegisteredEntryDetail = BulkTradeEntryDetail | {
  kind: "campaign";
  recipients: CampaignRecipient[];
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
            (viewer.id is not null) as accessible,
            owner.email as mailbox_owner_email,
            case when viewer.id is not null then thread.subject end as subject,
            case when viewer.id is not null then thread.last_message_at end as last_message_at,
            case when viewer.id is not null then thread.message_count end as message_count,
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
       join crm_email_threads thread on thread.id = link.evidence_id
       left join crm_users owner on owner.id = thread.mailbox_owner_id
       left join crm_users viewer
         on viewer.id = $2::uuid
        and lower(viewer.email) in ('ari@rebattery.io', 'alex@rebattery.io')
       left join crm_email_messages message
         on message.thread_id = thread.id and viewer.id is not null
      where link.lot_id = $1 and link.evidence_kind = 'gmail_thread'
      group by link.evidence_id, link.relationship, link.note, thread.id, owner.email, viewer.id
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

async function readCampaignDetail(entryId: string): Promise<RegisteredEntryDetail> {
  const [ledger] = await queryPg<{ available: boolean }>(
    "select to_regclass('crm_campaign_sends') is not null as available",
  );
  if (!ledger?.available) return { kind: "campaign", recipients: [] };
  const [links] = await queryPg<{ available: boolean }>(
    "select to_regclass('crm_campaign_send_links') is not null as available",
  );
  const recipients = await queryPg<CampaignRecipient>(
    `select s.person_id, p.full_name as person_name, s.recipient_email, s.state,
            s.provider_message_id, s.accepted_at, s.delivered_at, s.bounced_at,
            s.provider_opened_at, s.provider_link_clicked_at
       from crm_campaign_sends s
       join crm_people p on p.id = s.person_id
      where s.campaign_id = $1
      order by s.recipient_email, s.person_id`,
    [entryId],
  );
  if (links?.available) {
    const clicks = await queryPg<{ send_id: string; cta_key: string; destination_url: string; first_clicked_at: string | Date | null }>(
      `select l.send_id, l.cta_key, l.destination_url, l.first_clicked_at
         from crm_campaign_send_links l
         join crm_campaign_sends s on s.id = l.send_id
        where s.campaign_id = $1 and l.first_clicked_at is not null`,
      [entryId],
    );
    const personBySend = new Map(
      (await queryPg<{ id: string; person_id: string }>(
        "select id, person_id from crm_campaign_sends where campaign_id = $1",
        [entryId],
      )).map((row) => [row.id, row.person_id]),
    );
    const byPerson = new Map<string, CampaignRecipient["clicked_ctas"]>();
    for (const row of clicks) {
      const personId = personBySend.get(row.send_id);
      if (!personId) continue;
      const list = byPerson.get(personId) ?? [];
      list.push({ cta_key: row.cta_key, destination_url: row.destination_url, first_clicked_at: row.first_clicked_at });
      byPerson.set(personId, list);
    }
    for (const recipient of recipients) {
      const list = byPerson.get(recipient.person_id);
      if (list) recipient.clicked_ctas = list;
    }
  }
  return { kind: "campaign", recipients };
}

const detailReaders: Record<string, DetailReader> = {
  bulk_trade: readBulkTradeDetail,
  campaign: readCampaignDetail,
  campaigns: readCampaignDetail,
};

export async function getRegisteredEntryDetail(
  objectName: string,
  entryId: string,
  userId: string,
): Promise<RegisteredEntryDetail | undefined> {
  const reader = detailReaders[objectName];
  return reader ? reader(entryId, userId) : undefined;
}
