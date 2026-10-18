"""Provider reconciliation must preserve approval and recipient safety."""
import json
import os

import psycopg2
from psycopg2.extras import RealDictCursor
import pytest

from rebattery_mail.gmail_sync import sync_gmail
from rebattery_mail.ingest import ingest_postmark_event
from rebattery_mail.sync import sync_postmark
from test_read_sync import FakeGmail, gmail


@pytest.fixture
def db(db_after_cutover):
    conn = psycopg2.connect(db_after_cutover)
    with conn.cursor() as cur:
        cur.execute("insert into crm_users(email,password_hash) values('alex@rebattery.io','synthetic') returning id")
    yield conn
    conn.rollback()
    conn.close()


def row(db, sql, params=()):
    with db.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute(sql,params)
        return dict(cur.fetchone())


def outbound(db, id='safe-out', **fields):
    values = dict(id=id,direction='outbound',transport='postmark-transactional',purpose='personal',state='accepted',identity_key='hello',subject='Approved subject',body_text='Approved text',body_html='<p>Approved</p>',from_email='hello@rebattery.io',to_emails=['buyer@example.test'],recipient_email='buyer@example.test',sent_at='2026-10-16T09:00:00Z',personalization=json.dumps({'identity_snapshot':{'address':'hello@rebattery.io'}}))
    values.update(fields)
    with db.cursor() as cur:
        cur.execute('insert into mail_message('+','.join(values)+') values('+','.join(['%s']*len(values))+')',tuple(values.values()))
        cur.execute("insert into mail_followup(id,message_id,due_at,origin) values(%s,%s,now(),'commitment')",('follow-'+id,id))


def test_gmail_receipt_preserves_approved_snapshot(db):
    outbound(db,transport='gmail',identity_key='alex',gmail_message_id='receipt',from_email='alex@rebattery.io',rfc_references='<approved-root@test>',in_reply_to='<approved-parent@test>')
    before = row(db,"select * from mail_message where id='safe-out'")
    full = gmail('receipt',sender='alex@rebattery.io',to='different@example.test',labels=['SENT'],rfc='<actual@test>')
    full['headers'].update(subject='Provider encoded subject',references='<provider-root@test>')
    full['body']='Provider normalised text'
    sync_gmail(db,'alex@rebattery.io',apply=True,driver=FakeGmail({'receipt':full}))
    after = row(db,"select * from mail_message where id='safe-out'")
    for field in ('subject','body_text','body_html','from_email','to_emails','cc_emails','bcc_emails','identity_key','purpose','personalization','in_reply_to','rfc_references'):
        assert after[field] == before[field], field
    assert after['rfc_message_id']=='<actual@test>' and after['thread_id']


def test_postmark_rfc_identity_links_gmail_reply(db):
    outbound(db,provider_message_id='postmark-provider')
    class Client:
        def details(self,id):
            return {'Headers':[{'Name':'Message-ID','Value':'<actual-postmark@test>'}],'MessageEvents':[]}
        def suppressions(self,stream):
            return {}
    sync_postmark(db,apply=True,client=Client())
    assert row(db,"select rfc_message_id from mail_message where id='safe-out'")['rfc_message_id']=='<actual-postmark@test>'
    reply=gmail('reply',sender='buyer@example.test',to='alex@rebattery.io',reply='<actual-postmark@test>')
    sync_gmail(db,'alex@rebattery.io',apply=True,driver=FakeGmail({'reply':reply}))
    assert row(db,"select state from mail_followup where message_id='safe-out'")['state']=='paused'


def test_address_suppression_survives_without_person_or_message(db):
    payload={'RecordType':'SubscriptionChange','Recipient':' Stranger@Unknown.test ','ChangedAt':'2026-10-16T10:00:00Z','SuppressSending':True}
    ingest_postmark_event(db,payload)
    stored=row(db,"select * from mail_suppression where email='stranger@unknown.test'")
    assert stored['source']=='postmark'
    from rebattery_mail.suppression import is_suppressed
    assert is_suppressed(db,'STRANGER@UNKNOWN.TEST')
    ingest_postmark_event(db,{**payload,'SuppressSending':False})
    assert is_suppressed(db,'stranger@unknown.test')
    assert row(db,'select count(*) n from crm_people')['n']==0


def test_references_match_only_intended_counterparty_and_mailbox(db):
    outbound(db,rfc_message_id='<ancestor@test>')
    full=gmail('reference-reply',sender='buyer@example.test',to='alex@rebattery.io',reply='<uncaptured@test>',thread_id='different-gmail-thread')
    with db.cursor() as cur:
        cur.execute("insert into crm_users(email,password_hash) values('ari@rebattery.io','synthetic') returning id")
        other_owner = cur.fetchone()[0]
    outbound(db,id='other-mailbox',rfc_message_id='<ancestor@test>',mailbox_owner_id=other_owner)
    full['headers']['references']=' <ancestor@test>\r\n\t<uncaptured@test> '
    wrong=gmail('unrelated',sender='unrelated@example.test',to='alex@rebattery.io',reply='<ancestor@test>',thread_id='wrong-thread')
    sync_gmail(db,'alex@rebattery.io',apply=True,driver=FakeGmail({'reference-reply':full,'unrelated':wrong}))
    assert row(db,"select count(*) n from mail_event where type='replied'")['n']==1
    event=row(db,"select detail from mail_event where type='replied'")
    reply_id=event['detail']['reply_message_id']
    assert row(db,'select gmail_message_id from mail_message where id=%s',(reply_id,))['gmail_message_id']=='reference-reply'
    assert row(db,"select state from mail_followup where message_id='safe-out'")['state']=='paused'


@pytest.mark.parametrize('header,value',[('x-pm-message-id','provider-header-id'),('in-reply-to','<provider-header-id@mtasv.net>'),('references','<provider-header-id@mtasv.net>')])
def test_postmark_header_correlation_without_rfc_identity(db,header,value):
    outbound(db,provider_message_id='provider-header-id')
    full=gmail('provider-header-reply',sender='buyer@example.test',to='alex@rebattery.io',reply='<unavailable@test>')
    full['headers'][header]=value
    sync_gmail(db,'alex@rebattery.io',apply=True,driver=FakeGmail({'provider-header-reply':full}))
    assert row(db,"select state from mail_followup where message_id='safe-out'")['state']=='paused'


def test_suppression_dump_retains_unmatched_addresses_after_they_disappear(db):
    from rebattery_mail.suppression import is_suppressed
    class Client:
        dump = {'unmatched@example.test':{'EmailAddress':'unmatched@example.test','SuppressionReason':'ManualSuppression','Origin':'Recipient','CreatedAt':'2026-10-16T10:00:00Z','since':'2026-10-16'}}
        def suppressions(self,stream):
            return self.dump
        def details(self,id):
            return {'MessageEvents':[]}
    client = Client()
    sync_postmark(db,apply=True,client=client)
    assert is_suppressed(db,'unmatched@example.test')
    client.dump = {}
    sync_postmark(db,apply=True,client=client)
    assert is_suppressed(db,'unmatched@example.test')
    assert row(db,'select count(*) n from crm_people')['n']==0


def test_postmark_client_reads_actual_rfc_message_id_from_dump():
    from rebattery_mail.sync import PostmarkClient, postmark_rfc_identity
    client = PostmarkClient()
    calls = []
    def request(path):
        calls.append(path)
        return {'MessageEvents':[]} if path.endswith('/details') else {'Body':'Message-ID: <actual-message@test>\r\nSubject: Synthetic\r\n\r\nBody'}
    client.request = request
    assert postmark_rfc_identity(client.details('provider-id'))=='<actual-message@test>'
    assert calls==['/messages/outbound/provider-id/details','/messages/outbound/provider-id/dump']


def test_gmail_driver_never_wraps_ingested_content(monkeypatch):
    """--wrap-untrusted rewrites subject/body with markers; ingestion must store the real text."""
    import subprocess
    from rebattery_mail import gmail_driver

    seen = {}

    def fake_run(command, **kwargs):
        seen['command'] = command
        return subprocess.CompletedProcess(command, 0, stdout='{"messages": []}', stderr='')

    monkeypatch.setattr(gmail_driver.subprocess, 'run', fake_run)
    monkeypatch.setattr(gmail_driver.Path, 'read_text', lambda self: 'unused')
    gmail_driver.GmailDriver().call('ari@rebattery.io', 'gmail', 'messages', 'search', 'in:anywhere')
    assert '--wrap-untrusted' not in seen['command']
    assert '--json' in seen['command']


class _FakeCursor:
    def __init__(self, first):
        self.first = first

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def execute(self, *args):
        pass

    def fetchone(self):
        return (self.first,)


class _FakeDb:
    def __init__(self, first):
        self.first = first

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def cursor(self):
        return _FakeCursor(self.first)


def test_pre_send_mailbox_refresh_is_always_bounded(monkeypatch):
    """An unbounded in:anywhere sync inside a send preflight hung the first live send for minutes."""
    from datetime import datetime, timezone
    from rebattery_mail import sync

    seen = []
    monkeypatch.setattr(sync, 'sync_gmail', lambda db, account, since=None, apply=False, driver=None: seen.append(since) or {'counts': {'replies': 0}})
    # The query itself subtracts one day from the thread's first message (2026-10-01), so it returns 09-30.
    monkeypatch.setattr(sync, 'connection', lambda *a, **k: _FakeDb(datetime(2026, 9, 30, 9, 0, tzinfo=timezone.utc)))
    sync.recheck_thread('thread-1', 'alex@rebattery.io')
    assert seen[-1] == '2026/09/30'  # the window starts the day before the thread's first message
    monkeypatch.setattr(sync, 'connection', lambda *a, **k: _FakeDb(None))
    sync.recheck_thread(None, 'alex@rebattery.io')
    assert seen[-1] is not None and len(seen[-1]) == 10  # never None: fallback window, not the whole mailbox


def test_first_message_skips_reply_refresh(monkeypatch):
    """A first-contact draft has no thread and no earlier outbound mail, so there is nothing to refresh."""
    from rebattery_mail import send, sync

    class _Cur:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def execute(self, *a):
            pass
        def fetchone(self):
            return None
        def fetchall(self):
            return []

    class _Db:
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def cursor(self, *a, **k):
            return _Cur()

    monkeypatch.setattr(send, 'connection', lambda *a, **k: _Db())
    monkeypatch.setattr(send, 'dict_cursor', lambda db: _Cur())
    called = []
    monkeypatch.setattr(sync, 'recheck_thread', lambda *a, **k: called.append(a))
    send.refresh_replies({'id': 'new', 'personalization': {}, 'thread_id': None}, {'address': 'supply@rebattery.io', 'gmail_account': 'alex@rebattery.io'}, None)
    assert called == []


def test_hermes_secret_runs_in_a_subprocess_and_returns_only_the_value(monkeypatch):
    """Importing the Hermes loader in-process re-executes into a Python without psycopg2 and broke the first live Postmark send."""
    import subprocess
    from rebattery_mail import drivers

    seen = {}

    def fake_run(command, **kwargs):
        seen['command'] = command
        out = '  Bitwarden Secrets Manager: applied 58 secrets\n' + drivers._SECRET_MARKER + 'synthetic-token\n'
        return subprocess.CompletedProcess(command, 0, stdout=out, stderr='')

    monkeypatch.setattr(drivers.subprocess, 'run', fake_run)
    assert drivers.hermes_secret('POSTMARK_SERVER_TOKEN') == 'synthetic-token'
    assert seen['command'][0] == drivers.HERMES_PYTHON
    monkeypatch.setattr(drivers.subprocess, 'run', lambda *a, **k: subprocess.CompletedProcess(a[0], 1, stdout='noise only', stderr=''))
    assert drivers.hermes_secret('POSTMARK_SERVER_TOKEN') is None

    def boom(*a, **k):
        raise OSError('missing interpreter')

    monkeypatch.setattr(drivers.subprocess, 'run', boom)
    assert drivers.hermes_secret('POSTMARK_SERVER_TOKEN') is None
