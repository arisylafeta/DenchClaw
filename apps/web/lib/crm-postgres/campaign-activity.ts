import { queryPg } from "../postgres";

export type CampaignActivityLedgerLink = {
  person_id: string;
  recipient_email: string;
  cta_key: string;
  listing_id: string | null;
  label: string | null;
  first_clicked_at: string | Date | null;
};

export type CampaignActivityLedger = {
  campaign_id: string;
  sent_at: string | Date | null;
  links: CampaignActivityLedgerLink[];
};

/** Private attribution inputs only. This reader never calls an analytics provider. */
export async function readCampaignActivityLedger(id: string): Promise<CampaignActivityLedger | null> {
  const [campaign] = await queryPg<{ id: string; launched_at: string | Date | null }>(
    "select id, launched_at from campaigns where id = $1", [id],
  );
  if (!campaign) { return null; }
  const [tables] = await queryPg<{ sends: boolean; links: boolean; listings: boolean }>(`
    select to_regclass('crm_campaign_sends') is not null as sends,
           to_regclass('crm_campaign_send_links') is not null as links,
           to_regclass('crm_bulk_trade_lots') is not null as listings
  `);
  if (!tables?.sends) { return { campaign_id: id, sent_at: campaign.launched_at, links: [] }; }
  const [send] = await queryPg<{ sent_at: string | Date | null }>(`
    select min(accepted_at) as sent_at from crm_campaign_sends
     where campaign_id = $1 and (accepted_at is not null or state = 'accepted')
  `, [id]);
  const links = tables.links ? await queryPg<CampaignActivityLedgerLink>(`
    select s.person_id, s.recipient_email, l.cta_key, l.listing_id,
           ${tables.listings ? `(select lot.title from crm_bulk_trade_lots lot
               where lot.listing_id = l.listing_id
               order by lot.updated_at desc nulls last, lot.id limit 1)` : "null::text"} as label,
           l.first_clicked_at
      from crm_campaign_sends s
      join crm_people p on p.id = s.person_id
      join crm_campaign_send_links l on l.send_id = s.id
     where s.campaign_id = $1 and (s.accepted_at is not null or s.state = 'accepted')
     order by l.cta_key, s.person_id
  `, [id]) : [];
  return { campaign_id: id, sent_at: send?.sent_at ?? campaign.launched_at, links };
}
