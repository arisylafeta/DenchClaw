import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readCampaignEngagement } from "./campaign-engagement";
import { getCampaignDetail } from "./campaigns";
import { mailCampaignCounts, readMailCampaign } from "./mail";

const queryPg = vi.hoisted(() => vi.fn());
vi.mock("../postgres", () => ({ queryPg }));
const testUrl = process.env.CAMPAIGN_ENGAGEMENT_TEST_DATABASE_URL;
let pool: Pool;

describe.skipIf(!testUrl)("campaign engagement against disposable Postgres", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/campaign_engagement_test") {
      throw new Error("Requires a disposable loopback campaign_engagement_test database");
    }
    pool = new Pool({ connectionString: testUrl });
    queryPg.mockImplementation(async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows);
    await pool.query(`
      create table campaigns (id text primary key, campaign_name text, status text, source_system text,
        identity_key text, purpose text, mail_state text, created_at timestamptz, launched_at timestamptz);
      create table mail_identity (address text);
      create table crm_companies (id text primary key, name text);
      create table crm_people (id text primary key, full_name text, company_id text, email text);
      create table crm_dismantlers (id text, company_id text, stage text);
      create table mail_message (id text primary key, campaign_id text, direction text, person_id text,
        company_id text, recipient_email text, from_email text, from_person_id text,
        to_emails text[], cc_emails text[], bcc_emails text[], identity_key text, thread_id text,
        transport text, purpose text, state text, subject text, body_text text, body_preview text,
        sent_at timestamptz, accepted_at timestamptz, delivered_at timestamptz, replied_at timestamptz,
        opened_at timestamptz, clicked_at timestamptz, bounced_at timestamptz, last_synced_at timestamptz,
        created_at timestamptz, provider_message_id text, listing_id text, auction_url text,
        crm_visible boolean, has_attachments boolean, gmail_message_id text);
      create table mail_message_link (id text, message_id text, destination_url text, cta_key text,
        listing_id text, first_clicked_at timestamptz);
      create table mail_event (id bigint generated always as identity, message_id text, type text,
        source text, provider_event_id text, occurred_at timestamptz, detail jsonb);
      insert into campaigns values ('campaign', 'Fixture', 'sent', 'dench-campaign', null, null, 'sent', now(), now());
      insert into crm_companies values ('company', 'Buyer');
      insert into crm_people values ('reader', 'Reader', 'company', 'reader@example.test'),
        ('colleague', 'Colleague', 'company', 'colleague@example.test'), ('other', 'Other', null, 'other@example.test');
      insert into mail_message(id,campaign_id,direction,person_id,recipient_email,identity_key,accepted_at,sent_at,state,created_at)
        values ('m1','campaign','outbound','reader','reader@example.test','supply','2026-10-08 10:00Z','2026-10-08 10:00Z','accepted',now()),
          ('m2','campaign','outbound','other','other@example.test','sales','2026-10-08 10:00Z','2026-10-08 10:00Z','accepted',now());
      insert into mail_message(id,direction,from_person_id,from_email,sent_at)
        values ('reply','inbound','colleague','colleague@example.test','2026-10-08 13:00Z');
      insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values
        ('m1','opened','postmark','api-first','2026-10-08 11:00Z','{"Details":{"Summary":"Safari"}}'),
        ('m1','opened','postmark-webhook','webhook-first','2026-10-08 11:00:00.8Z','{"RecordType":"Open","FirstOpen":true}'),
        ('m1','opened','postmark-webhook','webhook-repeat','2026-10-08 11:11Z','{"RecordType":"Open","FirstOpen":false}'),
        ('m2','opened','postmark-webhook','other-open','2026-10-08 11:00Z','{}');
    `);
  });
  afterAll(async () => {
    if (pool) {
      await pool.query("drop table mail_event, mail_message_link, mail_message, crm_dismantlers, crm_people, crm_companies, mail_identity, campaigns");
      await pool.end();
    }
  });

  it("projects repeat opens once and infers a company reply without a timestamp or reply event", async () => {
    const rows = await readCampaignEngagement("campaign");
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.person_id === "reader")).toMatchObject({ total_opens: 2, return_sessions: 1, replied: true });
    expect(rows.find((row) => row.person_id === "other")).toMatchObject({ total_opens: 1, replied: false });
    const detail = await getCampaignDetail("campaign");
    expect(detail?.recipients.find((row) => row.person_id === "reader")?.replied_at).toBe("2026-10-08T13:00:00.000Z");
    expect(detail?.campaign.metrics.replied).toBe(1);
    expect((await mailCampaignCounts("campaign"))[0].replied).toBe(1);
  });

  it("infers direct email replies but excludes earlier and internal mail", async () => {
    try {
      await pool.query("update mail_message set from_person_id = null, from_email = 'reader@example.test' where id = 'reply'");
      expect((await readCampaignEngagement("campaign")).find((row) => row.person_id === "reader")?.replied).toBe(true);
      await pool.query("update mail_message set sent_at = '2026-10-08 09:00Z' where id = 'reply'");
      expect((await readCampaignEngagement("campaign")).some((row) => row.replied)).toBe(false);
      await pool.query("update mail_message set sent_at = '2026-10-08 13:00Z', from_person_id = 'colleague', from_email = 'internal@rebattery.io' where id = 'reply'");
      expect((await readCampaignEngagement("campaign")).some((row) => row.replied)).toBe(false);
    } finally {
      await pool.query("update mail_message set from_person_id = 'colleague', from_email = 'colleague@example.test', sent_at = '2026-10-08 13:00Z' where id = 'reply'");
    }
  });

  it("uses the recipient predicate for a mixed-identity filtered cohort", async () => {
    const filters = { identity: "supply", event: "opened", to: "reader@example.test" };
    const rows = await readCampaignEngagement("campaign", filters);
    const detail = await readMailCampaign("campaign", filters);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ person_id: "reader", total_opens: 2, return_sessions: 1, replied: true });
    expect(rows.map((row) => row.person_id)).toEqual(detail?.recipients.map((row) => row.person_id));
    expect(detail?.counts.total).toBe(1);
    expect(detail?.counts.replied).toBe(1);
    expect(await readCampaignEngagement("campaign", { ...filters, identity: "sales" })).toEqual([]);
    const other = await readCampaignEngagement("campaign", { identity: "sales" });
    expect(other.map((row) => row.person_id)).toEqual(["other"]);
    expect(other[0].return_sessions).toBe(0);
  });
});
