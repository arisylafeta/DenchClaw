import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { POST } from "./route";
import { postmarkOpenEventId, canonicalPostmarkTime } from "@/lib/postmark-mail-webhook";
import { rankCampaignEngagement, type EngagementEvent } from "@/lib/crm-postgres/campaign-engagement";

const sendOpen = (MessageID: string, metadata: Record<string, unknown> = {}) => POST(new Request("https://example.com/api/webhooks/postmark-mail", {
  method: "POST", headers: { authorization: "Basic " + Buffer.from("synthetic:synthetic").toString("base64") },
  body: JSON.stringify({ RecordType: "Open", MessageID, ReceivedAt: "2026-10-08T12:00:00.123456Z", FirstOpen: true, ...metadata }),
}));

const queryPg = vi.hoisted(() => vi.fn());
vi.mock("@/lib/postgres", () => ({ queryPg }));
const testUrl = process.env.POSTMARK_WEBHOOK_TEST_DATABASE_URL;
let pool: Pool | undefined;

describe.skipIf(!testUrl)("Postmark opens against isolated Postgres", () => {
  beforeAll(async () => {
    const url = new URL(testUrl!);
    if (url.hostname !== "127.0.0.1" || url.pathname !== "/postmark_webhook_test") {
      throw new Error("Requires a disposable loopback postmark_webhook_test database");
    }
    pool = new Pool({ connectionString: testUrl });
    queryPg.mockImplementation(async (sql: string, params: unknown[]) => (await pool!.query(sql, params)).rows);
    await pool.query(`
      create table mail_message (id text primary key, provider_message_id text, opened_at timestamptz, updated_at timestamptz);
      create table mail_event (id bigint generated always as identity primary key,
        message_id text references mail_message(id), type text, source text, provider_event_id text,
        occurred_at timestamptz, detail jsonb);
      create unique index on mail_event(source, provider_event_id) where provider_event_id is not null;
      insert into mail_message(id, provider_message_id) values ('m1', 'provider-1');
    `);
    vi.stubEnv("POSTMARK_MAIL_WEBHOOK_USER", "synthetic");
    vi.stubEnv("POSTMARK_MAIL_WEBHOOK_PASSWORD", "synthetic");
  });
  afterAll(async () => {
    if (pool) {
      await pool.query("drop table mail_event; drop table mail_message");
      await pool.end();
    }
    vi.unstubAllEnvs();
  });

  it.each(["API-first", "webhook-first"])("enriches %s same-time opens without adding observations or rewriting redeliveries", async (order) => {
    const id = order;
    const provider = `provider-${order}`;
    const at = "2026-10-08T12:00:00.123456Z";
    await pool!.query("insert into mail_message(id,provider_message_id) values ($1,$2)", [id, provider]);
    const apiDetail = { Type: "Opened", Details: { Summary: "Rich API summary" }, Client: { Name: "Existing client", Version: "123" } };
    const importApi = () => pool!.query(`insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail)
      values ($1,'opened','postmark',$2,$3,$4) on conflict do nothing returning id`,
    [id, postmarkOpenEventId(id, canonicalPostmarkTime(at)!), at, JSON.stringify(apiDetail)]);
    const metadata = { UserAgent: "GoogleImageProxy", Client: { Name: "Webhook client", Family: "Proxy" }, OS: { Name: "Linux" }, Platform: "Web", Geo: { Country: "GB" } };
    if (order === "API-first") {expect((await importApi()).rowCount).toBe(1);}
    const first = await sendOpen(provider, metadata);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ inserted: order === "API-first" ? 0 : 1 });
    if (order === "webhook-first") {expect((await importApi()).rowCount).toBe(0);}
    const readEvents = () => pool!.query("select id, xmin::text, ctid::text, type, source, provider_event_id, occurred_at::text, detail from mail_event where message_id=$1", [id]);
    const before = await readEvents();
    expect(before.rows).toHaveLength(1);
    expect(before.rows[0].detail).toMatchObject({ RecordType: "Open", FirstOpen: true, UserAgent: "GoogleImageProxy", OS: { Name: "Linux" }, Platform: "Web", Geo: { Country: "GB" } });
    if (order === "API-first") {
      expect(before.rows[0].detail).toMatchObject({ ...apiDetail, Client: { ...apiDetail.Client, Family: "Proxy" } });
    }
    expect(await (await sendOpen(provider, metadata)).json()).toEqual({ status: "duplicate", inserted: 0 });
    expect((await readEvents()).rows).toEqual(before.rows);
    const [ranked] = rankCampaignEngagement([{
      id, person_id: null, person_name: null, company_name: null, recipient_email: "qa@example.com",
      sent_at: null, delivered_at: null, replied: false, links: [], events: before.rows as EngagementEvent[],
    }]);
    expect(ranked).toMatchObject({ total_opens: 1, flagged_opens: 1, likely_bot: true });
  });

  it("retries an open before acceptance, then inserts it once the message exists", async () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const early = await sendOpen("provider-late");
      expect(early.status).toBe(503);
      expect(await early.json()).toEqual({ error: "Message not yet available" });
      expect(log).toHaveBeenCalledExactlyOnceWith("Postmark mail webhook awaiting messages", { count: 1 });
      await pool!.query("insert into mail_message(id,provider_message_id) values ('late','provider-late')");
      const accepted = await sendOpen("provider-late");
      expect(accepted.status).toBe(200);
      expect(await accepted.json()).toEqual({ status: "recorded", inserted: 1 });
      expect(await (await sendOpen("provider-late")).json()).toEqual({ status: "duplicate", inserted: 0 });
      expect((await pool!.query("select id from mail_event where message_id='late'")).rows).toHaveLength(1);
    } finally {
      log.mockRestore();
    }
  });

  it("records concurrent redeliveries once, preserves repeat opens and dedupes later API sync", async () => {
    const send = (ReceivedAt: string, FirstOpen: boolean) => POST(new Request("https://example.com/api/webhooks/postmark-mail", {
      method: "POST", headers: { authorization: "Basic " + Buffer.from("synthetic:synthetic").toString("base64") },
      body: JSON.stringify({ RecordType: "Open", MessageID: "provider-1", Recipient: "qa@example.com", ReceivedAt, FirstOpen }),
    }));
    const responses = await Promise.all(Array.from({ length: 5 }, () => send("2026-10-08T12:00:00.123456Z", true)));
    const results = await Promise.all(responses.map((response) => response.json()));
    expect(results.filter((result) => result.status === "recorded")).toHaveLength(1);
    expect(results.filter((result) => result.status === "duplicate")).toHaveLength(4);
    expect((await send("2026-10-08T12:11:00Z", false)).status).toBe(200);
    // The first-open key below is from the real Python ingest.py algorithm.
    const api = await pool!.query(`insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail)
      values ('m1','opened','postmark',$1,'2026-10-08T12:00:00.123456Z','{}') on conflict do nothing returning id`,
    ["4ad7da4cc6dc45fff9ecfbbe4d5f19ba1c373f202757e626e3ba94eedd214e77"]);
    expect(api.rowCount).toBe(0);
    const events = await pool!.query("select type, source, detail, occurred_at::text from mail_event where message_id='m1' order by occurred_at");
    expect(events.rows).toHaveLength(2);
    expect(events.rows[0]).toMatchObject({ type: "opened", source: "postmark", detail: { FirstOpen: true } });
    expect(events.rows[0].occurred_at).toContain("12:00:00.123456");
    expect(events.rows[1].detail.FirstOpen).toBe(false);
    const message = await pool!.query("select opened_at::text from mail_message where id='m1'");
    expect(message.rows[0].opened_at).toContain("12:00:00.123456");
  });
});
