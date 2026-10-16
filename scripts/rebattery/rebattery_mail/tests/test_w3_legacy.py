"""Synthetic integration gate, deliberately restricted to W3's disposable database."""
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
         'crm_buyer_engagement', 'crm_person_campaign_activity')


@pytest.fixture(scope='module')
def db():
    dsn = os.environ.get('DENCH_MAIL_DSN')
    if not dsn:
        pytest.skip('DENCH_MAIL_DSN must identify the disposable W3 database')
    conn = psycopg2.connect(dsn)
    params = conn.get_dsn_parameters()
    if (params['dbname'], params.get('host'), params['port']) != ('mail_w3', '127.0.0.1', '55470'):
        conn.close()
        pytest.skip('This destructive fixture is restricted to mail_w3 on 127.0.0.1:55470')
    conn.autocommit = True
    with conn.cursor() as cur:
        cur.execute('drop schema public cascade; create schema public')
        cur.execute((SQL / 'schema.sql').read_text())
        for path in sorted((SQL / 'migrations').glob('*.sql')):
            if path.name >= '038':
                break
            if path.name.startswith('034_'):
                cur.execute("insert into crm_objects (id,name,entity_table,display_field) values ('obj_people','people','crm_people','name') on conflict do nothing")
            cur.execute(path.read_text())
    yield conn
    # Leave the migrated schema, not fixture mail, for the existing script tests.
    with conn.cursor() as cur:
        cur.execute('truncate campaigns, crm_users, crm_companies, crm_people, crm_interactions, crm_bulk_trade_demand cascade')
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
            values ('w3_body_field','seed_obj_email_message_00000000','Body','text','body');
          insert into crm_companies (id,name,purpose) values ('w3_co','Synthetic Buyer',array['Buyer']);
          insert into crm_bulk_trade_demand (id,buyer,company_id,wants)
            values ('w3_demand','Synthetic Buyer','w3_co','Used traction packs');
          insert into campaigns (id,campaign_name,sender_identity) values
            ('w3_campaign','Historical cohort','supply'), ('w3_pending','No receipt','unmapped');
          insert into crm_people (id,full_name,email,company_id)
            select 'w3_'||s, s, s||'@example.test','w3_co'
            from unnest(array['frozen','sending','unknown','accepted','failed']) s;
          insert into crm_campaign_sends
            (id,campaign_id,person_id,company_id,listing_id,auction_url,recipient_email,state,
             provider_message_id,claimed_at,accepted_at,delivered_at,bounced_at,provider_opened_at,
             provider_link_clicked_at,last_synced_at,personalization,rendered_subject,rendered_html,rendered_text)
            select 'w3_send_'||s,'w3_campaign','w3_'||s,'w3_co','listing-'||s,
              'https://example.test/'||s,s||'@example.test',s,
              case when s='accepted' then 'provider-w3' end,
              '2026-10-01T08:00:00Z',
              case when s='accepted' then '2026-10-01T09:00:00Z'::timestamptz end,
              case when s='accepted' then '2026-10-01T09:01:00Z'::timestamptz end,
              case when s='failed' then '2026-10-01T09:02:00Z'::timestamptz end,
              case when s='accepted' then '2026-10-01T09:03:00Z'::timestamptz end,
              case when s='accepted' then '2026-10-01T09:04:00Z'::timestamptz end,
              '2026-10-02T09:00:00Z','{"name":"Synthetic"}', 'Frozen subject', '<p>Frozen</p>', 'Frozen text'
            from unnest(array['frozen','sending','unknown','accepted','failed']) s;
          insert into crm_campaign_sends (id,campaign_id,person_id,listing_id,auction_url,recipient_email)
            values ('w3_pending_send','w3_pending','w3_frozen','pending','https://example.test/pending','pending@example.test');
          insert into crm_campaign_send_links (id,send_id,cta_key,destination_url,listing_id,first_clicked_at)
            values ('w3_link','w3_send_accepted','auction','https://example.test/accepted','listing-accepted','2026-10-01T09:04:00Z');
          insert into crm_email_threads (id,subject,gmail_thread_id,mailbox_owner_id,last_message_at,message_count)
            select 'w3_thread','Synthetic conversation','gmail-w3',id,'2026-10-02T12:00:00Z',4 from crm_users where email='owner@example.test';
          insert into crm_email_thread_participants (thread_id,person_id,position) values ('w3_thread','w3_accepted',1);
          insert into crm_email_messages (id,thread_id,subject,sent_at,from_person_id,from_email,body,body_preview,gmail_message_id,mailbox_owner_id)
            select 'w3_in','w3_thread','A question','2026-10-02T12:00:00Z','w3_accepted','accepted@example.test','Message body','Preview','gmail-in',id
            from crm_users where email='owner@example.test';
          insert into crm_email_messages (id,thread_id,subject,sent_at,from_email,body,gmail_message_id,mailbox_owner_id)
            select 'w3_'||v.kind,'w3_thread','Our reply','2026-10-01T12:00:00Z',v.email,'Reply body',v.kind,id
            from crm_users, (values ('owner','owner@example.test'), ('identity','supply@rebattery.io'), ('alias','alex@rebattery.io')) v(kind,email)
            where crm_users.email='owner@example.test';
          insert into crm_email_message_recipients (message_id,person_id,recipient_type,position)
            values ('w3_identity','w3_accepted','to',2), ('w3_owner','w3_accepted','cc',1);
          insert into crm_interactions (id,email_message_id) values ('w3_interaction','w3_in');
        """)
    before = snapshot(db)
    assert before['crm_bulk_trade_buyer_waiting']
    assert before['crm_person_campaign_activity']

    # Missing history prevents a destructive cutover and the transaction rolls back.
    with pytest.raises(psycopg2.Error, match='unloaded rows'):
        with db.cursor() as cur:
            cur.execute((SQL / 'migrations/038_mail_cutover.sql').read_text())
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

    sends = rows(db, "select * from mail_message where campaign_id='w3_campaign' order by state")
    assert {s['state'] for s in sends} == {'frozen','sending','unknown','accepted','failed'}
    accepted = next(s for s in sends if s['state'] == 'accepted')
    assert (accepted['id'], accepted['transport'], accepted['direction'], accepted['purpose'], accepted['identity_key']) == (
        'w3_send_accepted', 'postmark-broadcast', 'outbound', 'marketing', 'supply')
    assert (accepted['subject'], accepted['body_html'], accepted['body_text'], accepted['personalization']) == (
        'Frozen subject', '<p>Frozen</p>', 'Frozen text', {'name': 'Synthetic'})
    assert (accepted['person_id'], accepted['company_id'], accepted['listing_id'], accepted['auction_url'], accepted['recipient_email'], accepted['provider_message_id']) == (
        'w3_accepted','w3_co','listing-accepted','https://example.test/accepted','accepted@example.test','provider-w3')
    assert accepted['opened_at'].isoformat() == '2026-10-01T09:03:00+00:00'
    assert accepted['clicked_at'].isoformat() == '2026-10-01T09:04:00+00:00'
    assert {r['mail_state'] for r in rows(db, 'select mail_state from campaigns')} == {'launched', 'legacy'}
    assert rows(db, "select identity_key from mail_message where id='w3_pending_send'")[0]['identity_key'] is None
    assert rows(db, "select * from mail_message_link where id='w3_link'")[0]['message_id'] == accepted['id']
    events = rows(db, 'select * from mail_event')
    assert {r['type'] for r in events} == {'sent','delivered','bounced','opened','clicked'}
    assert all(r['source'] == 'postmark' and r['provider_event_id'] == f"legacy:{r['message_id']}:{r['type']}" for r in events)
    gmail = {r['id']: r for r in rows(db, "select * from mail_message where transport='gmail'")}
    assert gmail['w3_in']['state'] == 'received' and gmail['w3_in']['direction'] == 'inbound'
    for key in ('w3_owner','w3_identity','w3_alias'):
        assert (gmail[key]['direction'],gmail[key]['state'],gmail[key]['purpose']) == ('outbound','accepted','personal')
    assert gmail['w3_identity']['to_emails'] == ['accepted@example.test']
    assert gmail['w3_owner']['cc_emails'] == ['accepted@example.test']
    assert all(r['crm_visible'] and r['crm_visible_reason']=='legacy' for r in gmail.values())

    # A collision with different content must refuse, rather than silently skip.
    with db.cursor() as cur:
        cur.execute("update mail_message set subject='Corrupted' where id='w3_in'")
    with pytest.raises(Refused, match='legacy_reconciliation_failed') as error:
        import_legacy(SimpleNamespace(apply=True))
    assert error.value.detail['counts']['crm_email_messages']['mismatches'] == 1
    with db.cursor() as cur:
        cur.execute("update mail_message set subject='A question' where id='w3_in'")
    cli = subprocess.run(['python3', str(ROOT/'scripts/rebattery/rebattery-mail.py'), 'legacy','import'], capture_output=True, text=True)
    assert cli.returncode == 0, cli.stderr
    assert json.loads(cli.stdout)['reconciled']

    # Apply to W3 only, using psql as the production deployment would.
    cutover = subprocess.run(['psql', os.environ['DENCH_MAIL_DSN'], '-X', '-v', 'ON_ERROR_STOP=1', '-f', str(SQL/'migrations/038_mail_cutover.sql')], capture_output=True, text=True)
    assert cutover.returncode == 0, cutover.stderr
    assert snapshot(db) == before
    for source, *_ in SOURCES:
        assert rows(db, 'select to_regclass(%s) as name', (source,))[0]['name'] is None
    assert rows(db, "select to_regprocedure('crm_mark_campaign_send()') as name")[0]['name'] is None
    assert len(rows(db, "select viewname from pg_views where schemaname='public' and viewname=any(%s)", (list(VIEWS),))) == 4
    assert rows(db, "select confrelid::regclass::text as target from pg_constraint where conrelid='crm_interactions'::regclass and conname='crm_interactions_email_message_id_fkey'")[0]['target'] == 'mail_message'
    with db.cursor() as cur:
        cur.execute("update crm_interactions set email_message_id='w3_in' where id='w3_interaction'")
    with pytest.raises(psycopg2.errors.ForeignKeyViolation):
        with db.cursor() as cur:
            cur.execute("insert into crm_interactions (id,email_message_id) values ('w3_bad','not-a-message')")
    # Wide capture is not CRM mail, even if a known person participates.
    with db.cursor() as cur:
        cur.execute("""insert into mail_message (id,direction,transport,state,from_person_id,from_email,sent_at)
          values ('w3_private','inbound','gmail','received','w3_accepted','accepted@example.test',now());
          insert into mail_message_recipient (message_id,person_id,recipient_type) values ('w3_private','w3_accepted','to');
        """)
    assert snapshot(db) == before
    assert rows(db, "select canonical_column from crm_fields where id='w3_body_field'")[0]['canonical_column'] == 'body_text'
    assert {r['entity_table'] for r in rows(db, "select entity_table from crm_objects where name in ('email_message','email_thread')")} == {'mail_message','mail_thread'}
    assert len(rows(db, "select id from crm_objects where name in ('mail_message','mail_campaign') and immutable")) == 2
    with db.cursor() as cur:
        cur.execute("""update campaigns set type='intro' where id='w3_pending';
          insert into mail_message (id,direction,transport,purpose,state,campaign_id,person_id,recipient_email)
          values ('w3_trigger','outbound','postmark-broadcast','marketing','accepted','w3_pending','w3_failed','trigger@example.test')""")
    assert rows(db, "select buyer_stage from crm_companies where id='w3_co'")[0]['buyer_stage'] == 'Contacted'
    assert rows(db, "select status from crm_subscriptions where person_id='w3_failed' and list='Supply update'")[0]['status'] == 'Subscribed'
    with pytest.raises(Refused, match='already removed'):
        import_legacy(SimpleNamespace(apply=True))
