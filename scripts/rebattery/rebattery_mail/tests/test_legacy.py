"""Synthetic integration gate over a fresh pre-cutover database."""
import json
import os
from pathlib import Path
import subprocess
from types import SimpleNamespace

import psycopg2
from psycopg2.extras import RealDictCursor
import pytest

from rebattery_mail.core import Refused
from rebattery_mail.legacy import SOURCES, import_legacy

ROOT = Path(__file__).resolve().parents[4]
SQL = ROOT / 'apps/web/lib/crm-postgres'
VIEWS = ('crm_relation_links', 'crm_bulk_trade_buyer_waiting',
         'crm_buyer_engagement', 'crm_person_campaign_activity', 'crm_bulk_trade_seller_candidates')


@pytest.fixture(scope='module')
def db(db_pre_cutover):
    conn = psycopg2.connect(db_pre_cutover)
    conn.autocommit = True
    yield conn
    conn.close()


def rows(db, sql, params=None):
    with db.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql, params)
        return [dict(row) for row in cur.fetchall()]


def snapshot(db):
    return {view: sorted(json.dumps(r, default=str, sort_keys=True) for r in rows(db, 'select * from ' + view))
            for view in VIEWS}


def test_import_reconciliation_and_clean_cutover(db):
    with db.cursor() as cur:
        cur.execute("""
          insert into crm_users (email,display_name,password_hash) values ('owner@example.test','Owner','x');
          insert into crm_objects (id,name,entity_table,display_field) values
            ('seed_obj_email_message_00000000','email_message','crm_email_messages','Subject'),
            ('seed_obj_email_thread_000000000','email_thread','crm_email_threads','Subject');
          insert into crm_fields (id,object_id,name,type,canonical_column)
            values ('legacy_body_field','seed_obj_email_message_00000000','Body','text','body');
          insert into crm_companies (id,name,purpose) values ('legacy_co','Synthetic Buyer',array['Buyer']);
          insert into crm_bulk_demand (id,buyer,company_id,wants)
            values ('legacy_demand','Synthetic Buyer','legacy_co','Used traction packs');
          insert into campaigns (id,campaign_name,sender_identity) values
            ('legacy_campaign','Historical cohort','Supply @ ReBattery <SUPPLY@rebattery.io>'), ('legacy_pending','No receipt','unmapped');
          insert into crm_people (id,full_name,email,company_id)
            select 'legacy_'||s, s, s||'@example.test','legacy_co'
            from unnest(array['frozen','sending','unknown','accepted','failed']) s;
          insert into crm_campaign_sends
            (id,campaign_id,person_id,company_id,listing_id,auction_url,recipient_email,state,
             provider_message_id,claimed_at,accepted_at,delivered_at,bounced_at,provider_opened_at,
             provider_link_clicked_at,last_synced_at,personalization,rendered_subject,rendered_html,rendered_text)
            select 'legacy_send_'||s,'legacy_campaign','legacy_'||s,'legacy_co','listing-'||s,
              'https://example.test/'||s,s||'@example.test',s,
              case when s='accepted' then 'provider-legacy' end,
              '2026-10-01T08:00:00Z',
              case when s='accepted' then '2026-10-01T09:00:00Z'::timestamptz end,
              case when s='accepted' then '2026-10-01T09:01:00Z'::timestamptz end,
              case when s='failed' then '2026-10-01T09:02:00Z'::timestamptz end,
              case when s='accepted' then '2026-10-01T09:03:00Z'::timestamptz end,
              case when s='accepted' then '2026-10-01T09:04:00Z'::timestamptz end,
              '2026-10-02T09:00:00Z','{"name":"Synthetic"}', 'Frozen subject', '<p>Frozen</p>', 'Frozen text'
            from unnest(array['frozen','sending','unknown','accepted','failed']) s;
          insert into crm_campaign_sends (id,campaign_id,person_id,listing_id,auction_url,recipient_email)
            values ('legacy_pending_send','legacy_pending','legacy_frozen','pending','https://example.test/pending','pending@example.test');
          insert into crm_campaign_send_links (id,send_id,cta_key,destination_url,listing_id,first_clicked_at)
            values ('legacy_link','legacy_send_accepted','auction','https://example.test/accepted','listing-accepted','2026-10-01T09:04:00Z');
          insert into crm_email_threads (id,subject,gmail_thread_id,mailbox_owner_id,last_message_at,message_count)
            select 'legacy_thread','Synthetic conversation','gmail-legacy',id,'2026-10-02T12:00:00Z',4 from crm_users where email='owner@example.test';
          insert into crm_email_thread_participants (thread_id,person_id,position) values ('legacy_thread','legacy_accepted',1);
          insert into crm_email_messages (id,thread_id,subject,sent_at,from_person_id,from_email,body,body_preview,gmail_message_id,mailbox_owner_id)
            select 'legacy_in','legacy_thread','A question','2026-10-02T12:00:00Z','legacy_accepted','accepted@example.test','Message body','Preview','gmail-in',id
            from crm_users where email='owner@example.test';
          insert into crm_email_messages (id,thread_id,subject,sent_at,from_email,body,gmail_message_id,mailbox_owner_id)
            select 'legacy_'||v.kind,'legacy_thread','Our reply','2026-10-01T12:00:00Z',v.email,'Reply body',v.kind,id
            from crm_users, (values ('owner','owner@example.test'), ('identity','supply@rebattery.io'), ('alias','alex@rebattery.io')) v(kind,email)
            where crm_users.email='owner@example.test';
          insert into crm_email_message_recipients (message_id,person_id,recipient_type,position)
            values ('legacy_identity','legacy_accepted','to',2), ('legacy_owner','legacy_accepted','cc',1);
          insert into crm_interactions (id,email_message_id) values ('legacy_interaction','legacy_in');
        """)
        cur.execute("""
          insert into crm_companies(id,name,purpose) values ('legacy_seller','Synthetic Yard',array['Dismantler']);
          insert into crm_people(id,company_id,email) values ('legacy_supplier','legacy_seller','supplier@example.test');
          insert into crm_bulk_trade_lots(id,title,lot_kind,summary,observed_outcome,confidence)
            values ('legacy_lot','Synthetic stock','supply','','','confirmed');
          insert into crm_bulk_trade_contacts(id,lot_id,name,email)
            values ('legacy_contact','legacy_lot','Supplier','supplier@example.test');
          insert into crm_bulk_trade_threads(thread_key,lot_id,verdict)
            values ('gmail:gmail-legacy','legacy_lot','trade');
          insert into crm_email_messages(id,thread_id,subject,sent_at,from_person_id,from_email,body_preview)
            values ('legacy_stock','legacy_thread','Stock available','2026-10-02T13:00:00Z',
                    'legacy_supplier','supplier@example.test','We have packs available');
        """)
    before = snapshot(db)
    assert before['crm_bulk_trade_buyer_waiting']
    assert before['crm_person_campaign_activity']
    assert before['crm_bulk_trade_seller_candidates']

    # Missing history prevents a destructive cutover and the transaction rolls back.
    with pytest.raises(psycopg2.Error, match='unloaded rows'):
        with db.cursor() as cur:
            cur.execute((SQL / 'migrations/051_mail_cutover.sql').read_text())
    db.rollback()
    with db.cursor() as cur:
        cur.execute('rollback')
    assert rows(db, "select to_regclass('crm_email_messages') as name")[0]['name']

    dry = import_legacy(SimpleNamespace(apply=False))
    assert dry['reconciled'] and not dry['applied']
    assert rows(db, 'select count(*) as n from mail_message')[0]['n'] == 0
    applied = import_legacy(SimpleNamespace(apply=True))
    assert applied['counts'] == dry['counts']
    assert applied['events_inserted'] == dry['events_inserted'] == 5
    assert all(v['loaded'] == v['source'] and not v['orphans'] and not v['mismatches'] for v in applied['counts'].values())
    again = import_legacy(SimpleNamespace(apply=True))
    assert again['reconciled'] and again['events_inserted'] == 0
    assert all(v['inserted'] == 0 for v in again['counts'].values())

    sends = rows(db, "select * from mail_message where campaign_id='legacy_campaign' order by state")
    assert {s['state'] for s in sends} == {'frozen','sending','unknown','accepted','failed'}
    accepted = next(s for s in sends if s['state'] == 'accepted')
    assert (accepted['id'], accepted['transport'], accepted['direction'], accepted['purpose'], accepted['identity_key']) == (
        'legacy_send_accepted', 'postmark-broadcast', 'outbound', 'marketing', 'supply')
    assert all(s['from_email'] == 'supply@rebattery.io' for s in sends)
    assert (accepted['subject'], accepted['body_html'], accepted['body_text'], accepted['personalization']) == (
        'Frozen subject', '<p>Frozen</p>', 'Frozen text', {'name': 'Synthetic'})
    assert (accepted['person_id'], accepted['company_id'], accepted['listing_id'], accepted['auction_url'], accepted['recipient_email'], accepted['provider_message_id']) == (
        'legacy_accepted','legacy_co','listing-accepted','https://example.test/accepted','accepted@example.test','provider-legacy')
    assert accepted['opened_at'].isoformat() == '2026-10-01T09:03:00+00:00'
    assert accepted['clicked_at'].isoformat() == '2026-10-01T09:04:00+00:00'
    assert {r['mail_state'] for r in rows(db, 'select mail_state from campaigns')} == {'launched', 'legacy'}
    assert rows(db, "select identity_key from mail_message where id='legacy_pending_send'")[0]['identity_key'] is None
    assert rows(db, "select * from mail_message_link where id='legacy_link'")[0]['message_id'] == accepted['id']
    events = rows(db, 'select * from mail_event')
    assert {r['type'] for r in events} == {'sent','delivered','bounced','opened','clicked'}
    assert all(r['source'] == 'postmark' and r['provider_event_id'] == f"legacy:{r['message_id']}:{r['type']}" for r in events)
    gmail = {r['id']: r for r in rows(db, "select * from mail_message where transport='gmail'")}
    assert gmail['legacy_in']['state'] == 'received' and gmail['legacy_in']['direction'] == 'inbound'
    for key in ('legacy_owner','legacy_identity','legacy_alias'):
        assert (gmail[key]['direction'],gmail[key]['state'],gmail[key]['purpose']) == ('outbound','accepted','personal')
    assert gmail['legacy_identity']['to_emails'] == ['accepted@example.test']
    assert gmail['legacy_owner']['cc_emails'] == ['accepted@example.test']
    assert all(r['crm_visible'] and r['crm_visible_reason']=='legacy' for r in gmail.values())

    # RFC display-name authors keep unknown rows recoverable with the fake driver.
    from rebattery_mail.send import recover
    class Recovery:
        def __init__(self):
            self.seen = []

        def recover(self, author, message):
            self.seen.append((author['key'], message['id']))
            return None

    with db.cursor() as cur:
        cur.execute("update mail_identity set postmark_stream='broadcast' where key='supply'")
    fake = Recovery()
    recover(SimpleNamespace(target='legacy_campaign', apply=False), driver=fake)
    assert ('supply', 'legacy_send_unknown') in fake.seen

    # The exact review reproduction: receipts and rendered content arrive after
    # the initial import. The locked cutover must refuse until a fresh import.
    def refused_cutover():
        with pytest.raises(psycopg2.Error, match='mismatched'):
            with db.cursor() as cur:
                cur.execute((SQL / 'migrations/051_mail_cutover.sql').read_text())
        with db.cursor() as cur:
            cur.execute('rollback')
        assert rows(db, "select to_regclass('crm_campaign_sends') as name")[0]['name']

    with db.cursor() as cur:
        cur.execute("""update crm_campaign_sends set state='accepted',
          provider_message_id='late-receipt',accepted_at='2026-10-03T09:00:00Z',
          delivered_at='2026-10-03T09:01:00Z',provider_opened_at='2026-10-03T09:02:00Z',
          provider_link_clicked_at='2026-10-03T09:03:00Z',
          rendered_subject='Updated subject',rendered_html='<p>Updated</p>',rendered_text='Updated text'
          where id='legacy_send_sending';
          update crm_email_messages set body='Late synced body' where id='legacy_in';
          update crm_campaign_send_links set first_clicked_at='2026-10-03T09:03:00Z' where id='legacy_link';
        """)
    refused_cutover()
    refreshed = import_legacy(SimpleNamespace(apply=True))
    assert refreshed['counts']['crm_campaign_sends']['updated'] == 1
    assert refreshed['counts']['crm_email_messages']['updated'] == 1
    assert refreshed['counts']['crm_campaign_send_links']['updated'] == 1
    late = rows(db, "select * from mail_message where id='legacy_send_sending'")[0]
    assert (late['state'],late['provider_message_id'],late['subject'],late['body_text']) == (
        'accepted','late-receipt','Updated subject','Updated text')
    assert rows(db, "select body_text from mail_message where id='legacy_in'")[0]['body_text'] == 'Late synced body'
    assert rows(db, "select first_clicked_at from mail_message_link where id='legacy_link'")[0]['first_clicked_at'].isoformat() == '2026-10-03T09:03:00+00:00'
    assert rows(db, "select count(*) as n from mail_event where message_id='legacy_send_sending'")[0]['n'] == 4
    assert import_legacy(SimpleNamespace(apply=True))['counts']['crm_campaign_sends']['updated'] == 0

    # Independently guard each previously unchecked projection, not just state.
    for mutation in (
        "update crm_campaign_sends set rendered_text='Changed again' where id='legacy_send_sending'",
        "update crm_email_messages set body='Another body' where id='legacy_in'",
        "update crm_campaign_send_links set first_clicked_at='2026-10-04T09:03:00Z' where id='legacy_link'",
        "update crm_email_thread_participants set position=9 where thread_id='legacy_thread'",
    ):
        with db.cursor() as cur:
            cur.execute(mutation)
        refused_cutover()
        assert import_legacy(SimpleNamespace(apply=True))['reconciled']

    # A stale source never rolls a newer log state or receipt back.
    with db.cursor() as cur:
        cur.execute("update crm_campaign_sends set state='sending',provider_message_id=null where id='legacy_send_sending'")
    with pytest.raises(Refused, match='legacy_reconciliation_failed'):
        import_legacy(SimpleNamespace(apply=True))
    assert rows(db, "select state,provider_message_id from mail_message where id='legacy_send_sending'")[0] == {
        'state':'accepted','provider_message_id':'late-receipt'}
    with db.cursor() as cur:
        cur.execute("update crm_campaign_sends set state='accepted',provider_message_id='late-receipt' where id='legacy_send_sending'")
        cur.execute("update mail_event set occurred_at=occurred_at+interval '1 second' where provider_event_id='legacy:legacy_send_sending:sent'")
    refused_cutover()
    assert import_legacy(SimpleNamespace(apply=True))['reconciled']

    # Same-state content is refreshed as well; unchanged reruns update nothing.
    with db.cursor() as cur:
        cur.execute("update mail_message set subject='Corrupted' where id='legacy_in'")
    assert import_legacy(SimpleNamespace(apply=True))['counts']['crm_email_messages']['updated'] == 1
    assert rows(db, "select subject from mail_message where id='legacy_in'")[0]['subject'] == 'A question'
    cli = subprocess.run(['python3', str(ROOT/'scripts/rebattery/rebattery-mail.py'), 'legacy','import'], capture_output=True, text=True)
    assert cli.returncode == 0, cli.stderr
    assert json.loads(cli.stdout)['reconciled']
    before = snapshot(db)

    # Apply to this module's throwaway database using the deployment command.
    cutover = subprocess.run(['psql', os.environ['DENCH_MAIL_DSN'], '-X', '-v', 'ON_ERROR_STOP=1', '-f', str(SQL/'migrations/051_mail_cutover.sql')], capture_output=True, text=True)
    assert cutover.returncode == 0, cutover.stderr
    assert snapshot(db) == before
    for source, *_ in SOURCES:
        assert rows(db, 'select to_regclass(%s) as name', (source,))[0]['name'] is None
    assert rows(db, "select to_regprocedure('crm_mark_campaign_send()') as name")[0]['name'] is None
    assert len(rows(db, "select viewname from pg_views where schemaname='public' and viewname=any(%s)", (list(VIEWS),))) == len(VIEWS)
    assert rows(db, "select confrelid::regclass::text as target from pg_constraint where conrelid='crm_interactions'::regclass and conname='crm_interactions_email_message_id_fkey'")[0]['target'] == 'mail_message'
    with db.cursor() as cur:
        cur.execute("update crm_interactions set email_message_id='legacy_in' where id='legacy_interaction'")
    with pytest.raises(psycopg2.errors.ForeignKeyViolation):
        with db.cursor() as cur:
            cur.execute("insert into crm_interactions (id,email_message_id) values ('legacy_bad','not-a-message')")
    # Wide capture is not CRM mail, even if a known person participates.
    with db.cursor() as cur:
        cur.execute("""insert into mail_message (id,direction,transport,state,from_person_id,from_email,sent_at)
          values ('legacy_private','inbound','gmail','received','legacy_accepted','accepted@example.test',now());
          insert into mail_message_recipient (message_id,person_id,recipient_type) values ('legacy_private','legacy_accepted','to');
        """)
    assert snapshot(db) == before
    assert rows(db, "select canonical_column from crm_fields where id='legacy_body_field'")[0]['canonical_column'] == 'body_text'
    assert {r['entity_table'] for r in rows(db, "select entity_table from crm_objects where name in ('email_message','email_thread')")} == {'mail_message','mail_thread'}
    assert len(rows(db, "select id from crm_objects where name in ('mail_message','mail_campaign') and immutable")) == 2
    with db.cursor() as cur:
        cur.execute("""update campaigns set type='intro' where id='legacy_pending';
          insert into mail_message (id,direction,transport,purpose,state,campaign_id,person_id,recipient_email)
          values ('legacy_trigger','outbound','postmark-broadcast','marketing','accepted','legacy_pending','legacy_failed','trigger@example.test')""")
    assert rows(db, "select buyer_stage from crm_companies where id='legacy_co'")[0]['buyer_stage'] == 'Contacted'
    assert rows(db, "select status from crm_subscriptions where person_id='legacy_failed' and list='Supply update'")[0]['status'] == 'Subscribed'
    with pytest.raises(Refused, match='already removed'):
        import_legacy(SimpleNamespace(apply=True))


def test_campaign_deliveries_do_not_answer_buyers_but_campaign_replies_do(db):
    queries = {
        'waiting': "select * from crm_bulk_trade_buyer_waiting where person_id='legacy_accepted'",
        'engagement': "select * from crm_buyer_engagement where company_id='legacy_co'",
    }
    before = {key: rows(db, sql) for key, sql in queries.items()}
    assert before['waiting'][0]['waiting_since'] is not None
    with db.cursor() as cur:
        cur.execute("""insert into campaigns (id,campaign_name) values ('queue_campaign','Synthetic Gmail marketing');
          insert into mail_message (id,direction,transport,purpose,state,campaign_id,person_id,
            from_email,to_emails,sent_at,crm_visible)
          values ('queue_delivery','outbound','gmail','marketing','accepted','queue_campaign','legacy_accepted',
            'supply@rebattery.io',array['accepted@example.test'],'2026-10-05T12:00:00Z',true);
          insert into mail_message_recipient (message_id,person_id,recipient_type)
          values ('queue_delivery','legacy_accepted','to');
        """)
    assert {key: rows(db, sql) for key, sql in queries.items()} == before
    with db.cursor() as cur:
        cur.execute("""insert into mail_message (id,direction,transport,state,campaign_id,from_person_id,
            from_email,sent_at,crm_visible)
          values ('queue_reply','inbound','gmail','received','queue_campaign','legacy_accepted',
            'accepted@example.test','2026-10-06T12:00:00Z',true)""")
    after = {key: rows(db, sql) for key, sql in queries.items()}
    assert after['waiting'][0]['waiting_since'].isoformat() == '2026-10-06T12:00:00+00:00'
    assert after['waiting'][0]['last_out_at'] == before['waiting'][0]['last_out_at']
    assert after['engagement'][0]['emails_in_90d'] == before['engagement'][0]['emails_in_90d']+1
    assert after['engagement'][0]['emails_out_90d'] == before['engagement'][0]['emails_out_90d']


def test_operational_bootstraps_never_replay_the_retired_mail_schema(db):
    scripts = ROOT / 'scripts/rebattery'
    setup = scripts / 'setup-loop-monitor.mjs'
    fixture = scripts / 'run-projects-mvp-fixture.mjs'
    assert 'crm-postgres/schema.sql' not in setup.read_text()
    assert 'crm-postgres/schema.sql' not in fixture.read_text()
    assert 'for (const file of [fixture])' in fixture.read_text()
    bootstrap = (ROOT / 'apps/web/scripts/apply-postgres-schema.ts').read_text()
    assert bootstrap.index("to_regclass('public.crm_objects')") < bootstrap.index('await queryPg(sql)')
    assert 'if (state?.existing)' in bootstrap
    before = snapshot(db)
    definitions = rows(db, "select viewname,definition from pg_views where schemaname='public' and viewname=any(%s) order by viewname", (list(VIEWS),))
    env = dict(os.environ, LOOP_MONITOR_DATABASE_URL=os.environ['DENCH_MAIL_DSN'])
    # The executable expects a URL, whereas DENCH_MAIL_DSN is a libpq DSN.
    from psycopg2.extensions import parse_dsn
    from urllib.parse import quote
    params = parse_dsn(os.environ['DENCH_MAIL_DSN'])
    env['LOOP_MONITOR_DATABASE_URL'] = f"postgresql://{quote(params['user'])}:{quote(params['password'])}@{params['host']}:{params['port']}/{params['dbname']}"
    run = subprocess.run(['node', str(setup)], env=env, capture_output=True, text=True)
    assert run.returncode == 0, run.stderr
    assert snapshot(db) == before
    assert rows(db, "select viewname,definition from pg_views where schemaname='public' and viewname=any(%s) order by viewname", (list(VIEWS),)) == definitions
    for source, *_ in SOURCES:
        assert rows(db, 'select to_regclass(%s) as name', (source,))[0]['name'] is None
