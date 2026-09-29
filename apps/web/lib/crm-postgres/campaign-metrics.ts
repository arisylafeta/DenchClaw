import { queryPg } from "../postgres";

type CampaignMetricRow = {
  id: string;
  invites_sent: string | number;
  emails_delivered: string | number;
  emails_opened: string | number;
  emails_clicked: string | number;
  emails_bounced: string | number;
};

/** Project provider-backed counts for Dench campaigns without changing legacy snapshots. */
export async function projectCampaignMetrics(
  entries: Record<string, unknown>[],
): Promise<Record<string, unknown>[]> {
  const ids = entries.map((entry) => entry.entry_id).filter((id): id is string => typeof id === "string");
  if (!ids.length) return entries;
  const [ledger] = await queryPg<{ available: boolean }>(
    "select to_regclass('crm_campaign_sends') is not null as available",
  );
  if (!ledger?.available) return entries;

  const metrics = await queryPg<CampaignMetricRow>(`
    select c.id,
           count(s.id) filter (where s.accepted_at is not null) as invites_sent,
           count(s.id) filter (where s.delivered_at is not null) as emails_delivered,
           count(s.id) filter (where s.provider_opened_at is not null) as emails_opened,
           count(s.id) filter (where s.provider_link_clicked_at is not null) as emails_clicked,
           count(s.id) filter (where s.bounced_at is not null) as emails_bounced
      from campaigns c left join crm_campaign_sends s on s.campaign_id = c.id
     where c.id = any($1::text[]) and c.source_system = 'dench-campaign'
     group by c.id
  `, [ids]);
  const byId = new Map(metrics.map((row) => [row.id, row]));
  return entries.map((entry) => {
    const metric = byId.get(String(entry.entry_id));
    if (!metric) return entry;
    return {
      ...entry,
      "Invites Sent": Number(metric.invites_sent),
      "Emails Delivered": Number(metric.emails_delivered),
      "Emails Opened": Number(metric.emails_opened),
      "Emails Clicked": Number(metric.emails_clicked),
      "Emails Bounced": Number(metric.emails_bounced),
    };
  });
}
