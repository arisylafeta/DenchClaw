"""Thread ownership: permissions, routing and dispatch, against a disposable Postgres (synthetic data only).

Needs a mail_test_* database on localhost:55470 that has the mail tables and migration 114, for example the
crm-test-mail container from mail-test-db.sh with the mail schema loaded. Skips otherwise.
"""
import json
import os
from argparse import Namespace
from datetime import datetime, timedelta, timezone

import psycopg2
import pytest
from psycopg2.extensions import parse_dsn

DSN = os.environ.get('DENCH_MAIL_OWNER_TEST_DSN', 'dbname=mail_test_owner host=127.0.0.1 port=55470 user=postgres password=test')
params = parse_dsn(DSN)
if params.get('host') not in ('127.0.0.1', 'localhost') or params.get('port') == '5432' or not params['dbname'].startswith('mail_test_'):
    pytest.skip('owner tests need a mail_test_* database on localhost, not port 5432', allow_module_level=True)
try:
    psycopg2.connect(DSN).close()
except psycopg2.OperationalError:
    pytest.skip('disposable mail test Postgres unavailable', allow_module_level=True)
os.environ['DENCH_MAIL_DSN'] = DSN

from rebattery_mail import owner  # noqa: E402
from rebattery_mail.core import Refused  # noqa: E402


@pytest.fixture(autouse=True)
def seed(monkeypatch):
    monkeypatch.delenv('HERMES_SESSION_PROFILE', raising=False)
    monkeypatch.delenv('HERMES_HOME', raising=False)
    with psycopg2.connect(DSN) as db, db.cursor() as cur:
        cur.execute('truncate mail_agent_event, mail_owner_rule, mail_thread_owner_event, mail_thread_owner, mail_message, mail_thread, mail_identity cascade')
        cur.execute("insert into mail_identity (key, address, display_name, gmail_account) values ('alex','alex@rebattery.io','Alex','alex@rebattery.io'), ('supply','supply@rebattery.io','Supply','alex@rebattery.io')")
        cur.execute("insert into mail_thread (id, subject) values ('t1','Pack offer'), ('t2','New stock'), ('t3','Other')")
    yield


def as_agent(monkeypatch, profile, session='s-' + 'main'):
    monkeypatch.setenv('HERMES_SESSION_PROFILE', profile)
    monkeypatch.setenv('HERMES_SESSION_ID', session)


def inbound(message_id, thread, sender, minutes_ago=10, to=('supply@rebattery.io',), identity='supply', labels=(), sent_days_ago=0):
    created = datetime.now(timezone.utc) - timedelta(minutes=minutes_ago)
    with psycopg2.connect(DSN) as db, db.cursor() as cur:
        cur.execute('''insert into mail_message (id, direction, transport, state, thread_id, subject, from_email, to_emails, identity_key, labels, sent_at, created_at)
                       values (%s,'inbound','gmail','received',%s,'Re: offer',%s,%s,%s,%s,%s,%s)''',
                    (message_id, thread, sender, list(to), identity, list(labels), created - timedelta(days=sent_days_ago), created))


def run_dispatch(**kw):
    base = dict(lookback_minutes=60, max_age_hours=24, debounce_seconds=90, max_per_hour=20, log='/dev/null', apply=True)
    base.update(kw)
    return owner.dispatch(Namespace(**base))


def args(**kw):
    base = dict(profile=None, session=None, to=None, reason='pilot', apply=True)
    base.update(kw)
    return Namespace(**base)


def test_claim_handoff_and_permissions(monkeypatch):
    as_agent(monkeypatch, 'papajules', 'jules-main')
    claimed = owner.change(args(thread='t1'), 'set')
    assert claimed['to'] == {'profile': 'papajules', 'session_id': 'jules-main'}
    as_agent(monkeypatch, 'sorcerer')
    with pytest.raises(Refused) as exc:
        owner.change(args(thread='t1'), 'set')
    assert exc.value.rule == 'owned_by_other'
    with pytest.raises(Refused) as exc:
        owner.change(args(thread='t1', to='sorcerer'), 'handoff')
    assert exc.value.rule == 'not_owner'
    as_agent(monkeypatch, 'papajules', 'jules-main')
    owner.change(args(thread='t1', to='sorcerer', reason='sourcing ask'), 'handoff')
    shown = owner.show(Namespace(thread='t1'))
    assert shown['owner']['profile'] == 'sorcerer' and shown['owner']['session_id'] is None
    assert [h['action'] for h in shown['history']] == ['handoff', 'set']
    assert shown['history'][0]['actor'] == 'agent:papajules'


def test_dry_run_writes_nothing_and_reason_is_required(monkeypatch):
    as_agent(monkeypatch, 'papajules')
    owner.change(args(thread='t2', apply=False), 'set')
    assert owner.show(Namespace(thread='t2'))['owner'] is None
    with pytest.raises(owner.UsageError) as exc:
        owner.change(args(thread='t2', reason='  '), 'set')
    assert exc.value.rule == 'reason_required'
    with pytest.raises(owner.UsageError) as exc:
        owner.change(args(thread='t2', profile='no-such-bot'), 'set')
    assert exc.value.rule == 'unknown_profile'
    with psycopg2.connect(DSN) as db, db.cursor() as cur:
        cur.execute('select count(*) from mail_thread_owner_event')
        assert cur.fetchone()[0] == 0


def test_router_assigns_anyone_and_bots_cannot_edit_rules(monkeypatch):
    as_agent(monkeypatch, 'mailvin')
    owner.change(args(thread='t2', profile='sorcerer'), 'set')
    assert owner.show(Namespace(thread='t2'))['owner']['profile'] == 'sorcerer'
    as_agent(monkeypatch, 'papajules')
    with pytest.raises(Refused):
        owner.rules(Namespace(action='add', kind='sender', value='x@y.com', profile='papajules', session=None, priority=100, note=None, apply=True))


def test_routing_order_and_dispatch(monkeypatch):
    calls = []
    monkeypatch.setattr(owner, 'deliver', lambda profile, session, text, log: calls.append((profile, session, text)))
    monkeypatch.setattr(owner, 'ensure_session', lambda cur, o, subject, apply: (o['session_id'] or 'new-session', not o['session_id']))
    # operator rules: mailbox default and a more specific sender rule
    owner.rules(Namespace(action='add', kind='mailbox', value='supply', profile='sorcerer', session=None, priority=100, note=None, apply=True))
    owner.rules(Namespace(action='add', kind='sender', value='seller@pack.co', profile='papajules', session='jules-main', priority=100, note=None, apply=True))
    as_agent(monkeypatch, 'papajules', 'jules-main')
    owner.change(args(thread='t3'), 'set')
    monkeypatch.delenv('HERMES_SESSION_PROFILE')
    inbound('m1', 't1', 'seller@pack.co')           # sender rule
    inbound('m2', 't2', 'someone@else.co')          # mailbox default
    inbound('m3', 't3', 'someone@else.co')          # existing owner wins over rules
    inbound('m4', 't3', 'alex@rebattery.io')        # our own mail is skipped
    inbound('m5', None, 'someone@else.co')          # no thread: unassigned
    inbound('m6', 't1', 'seller@pack.co', minutes_ago=0)  # newest on t1: debounces t1
    result = run_dispatch()
    assert result['skipped'] == 1 and result['unassigned'] == 1
    woken = {c[0]: c for c in calls}
    assert set(woken) == {'sorcerer', 'papajules'} and len(calls) == 2  # t2 -> sorcerer, t3 -> papajules; t1 waits
    assert {'thread_id': 't1', 'reason': 'debounce'} in result['deferred']
    assert owner.show(Namespace(thread='t2'))['owner']['assigned_by'] == 'router'
    # Second run: nothing new to queue, t1 still debounced; each message woke its owner at most once.
    again = run_dispatch()
    assert again['queued'] == 0 and len(calls) == 2
    with psycopg2.connect(DSN) as db, db.cursor() as cur:
        cur.execute("update mail_message set created_at = now() - interval '5 minutes' where id='m6'")
    run_dispatch()
    assert len(calls) == 3 and calls[-1][0] == 'papajules' and '2 new emails' in calls[-1][2]


def test_sender_with_one_owned_thread_routes_new_threads(monkeypatch):
    as_agent(monkeypatch, 'papajules', 'jules-main')
    owner.change(args(thread='t1'), 'set')
    inbound('m1', 't1', 'seller@pack.co', minutes_ago=30)
    inbound('m2', 't2', 'seller@pack.co')
    with psycopg2.connect(DSN) as db, db.cursor(cursor_factory=__import__('psycopg2.extras').extras.RealDictCursor) as cur:
        cur.execute("select * from mail_message where id='m2'")
        hit = owner.route(cur, cur.fetchone())
    assert hit[:3] == ('papajules', 'jules-main', 'sender has one owned thread')


def test_rate_limit_defers(monkeypatch):
    calls = []
    monkeypatch.setattr(owner, 'deliver', lambda *a: calls.append(a))
    monkeypatch.setattr(owner, 'ensure_session', lambda cur, o, subject, apply: ('s', False))
    as_agent(monkeypatch, 'papajules', 'jules-main')
    for t in ('t1', 't2'):
        owner.change(args(thread=t), 'set')
    monkeypatch.delenv('HERMES_SESSION_PROFILE')
    inbound('m1', 't1', 'a@b.co'); inbound('m2', 't2', 'c@d.co')
    result = run_dispatch(max_per_hour=1)
    assert len(calls) == 1 and any(d['reason'] == 'rate_limited' for d in result['deferred'])


def test_plus_tags():
    assert owner.plus_tags(['supply+trade-123@rebattery.io', 'x+y@other.com']) == ['trade-123']


def test_wake_request_carries_key_and_message_off_the_command_line(monkeypatch):
    monkeypatch.setenv('API_SERVER_KEY', 'test-key-123')
    config = owner.curl_config('hello "there"')
    assert 'header = "Authorization: Bearer test-key-123"' in config
    body = config.split('data-binary = ', 1)[1].strip()
    assert json.loads(json.loads(body)) == {'message': 'hello "there"'}


def test_automated_old_and_owned_by_nobody_never_wake(monkeypatch):
    calls = []
    monkeypatch.setattr(owner, 'deliver', lambda *a: calls.append(a))
    monkeypatch.setattr(owner, 'ensure_session', lambda cur, o, subject, apply: ('s', False))
    owner.rules(Namespace(action='add', kind='mailbox', value='supply', profile='sorcerer', session=None, priority=100, note=None, apply=True))
    inbound('m1', 't1', 'no-reply@shop.com')
    inbound('m2', 't2', 'deals@shop.com', labels=('CATEGORY_PROMOTIONS', 'INBOX'))
    inbound('m3', 't3', 'buyer@real.co', sent_days_ago=30)
    result = run_dispatch()
    assert result['skipped'] == 3 and result['queued'] == 0 and calls == []


def test_one_failing_owner_does_not_block_the_queue(monkeypatch):
    calls = []
    monkeypatch.setattr(owner, 'deliver', lambda profile, session, text, log: calls.append(profile))
    def flaky(cur, o, subject, apply):
        if o['profile'] == 'sorcerer':
            raise RuntimeError('gateway down')
        return 's', False
    monkeypatch.setattr(owner, 'ensure_session', flaky)
    as_agent(monkeypatch, 'mailvin')
    owner.change(args(thread='t1', profile='sorcerer'), 'set')
    owner.change(args(thread='t2', profile='papajules'), 'set')
    monkeypatch.delenv('HERMES_SESSION_PROFILE')
    inbound('m1', 't1', 'a@b.co', minutes_ago=20)
    inbound('m2', 't2', 'c@d.co')
    result = run_dispatch()
    assert calls == ['papajules'] and result['failed'][0]['profile'] == 'sorcerer'
    for _ in range(4):
        run_dispatch()
    with psycopg2.connect(DSN) as db, db.cursor() as cur:
        cur.execute("select state, attempts from mail_agent_event where message_id='m1'")
        assert cur.fetchone() == ('failed', 5)


def test_plus_tag_in_raw_headers_routes_even_when_sync_strips_it(monkeypatch):
    owner.rules(Namespace(action='add', kind='tag', value='dismantlers', profile='dismantlercampaigns', session='dc-main', priority=100, note=None, apply=True))
    created = datetime.now(timezone.utc) - timedelta(minutes=10)
    with psycopg2.connect(DSN) as db, db.cursor() as cur:
        cur.execute('''insert into mail_message (id, direction, transport, state, thread_id, subject, from_email, to_emails, identity_key, labels, sent_at, created_at, personalization)
                       values ('m1','inbound','gmail','received','t1','Re: packs','yard@example.test',%s,'supply','{}',%s,%s,%s)''',
                    (['supply@rebattery.io'], created, created, json.dumps({'provider_headers': {'to': 'ReBattery <supply+dismantlers@rebattery.io>'}})))
    with psycopg2.connect(DSN) as db, db.cursor(cursor_factory=__import__('psycopg2.extras').extras.RealDictCursor) as cur:
        cur.execute("select * from mail_message where id='m1'")
        assert owner.route(cur, cur.fetchone())[:3] == ('dismantlercampaigns', 'dc-main', 'rule tag=dismantlers')


def test_header_addresses_tolerate_missing_headers_and_dedupe_tags():
    assert owner.header_addresses({'personalization': None}) == []
    assert owner.header_addresses({}) == []
    message = {'to_emails': ['supply+dismantlers@rebattery.io'],
               'personalization': {'provider_headers': {'to': '"Supply" <supply+dismantlers@rebattery.io>', 'cc': None}}}
    tags = owner.plus_tags(message['to_emails'] + owner.header_addresses(message))
    assert list(dict.fromkeys(tags)) == ['dismantlers']


def test_dismantler_rule_routes_dismantler_mail_by_mailbox(monkeypatch):
    with psycopg2.connect(DSN) as db, db.cursor() as cur:
        cur.execute("insert into mail_identity (key, address, display_name, gmail_account) values ('ari','ari@rebattery.io','Ari','ari@rebattery.io') on conflict do nothing")
        cur.execute("insert into crm_companies (id, name, domain) values ('dm-co','Yard','yard.example'), ('other-co','Buyer','buyer.example') on conflict do nothing")
        cur.execute("insert into crm_people (id, company_id, email) values ('dm-p','dm-co','pat@yard.example'), ('other-p','other-co','kim@buyer.example') on conflict do nothing")
        cur.execute("insert into crm_dismantlers (company_id) values ('dm-co') on conflict do nothing")
    owner.rules(Namespace(action='add', kind='dismantler', value='ari', profile='dismantlercampaigns', session='dc-main', priority=100, note=None, apply=True))
    inbound('m1', 't1', 'PAT@yard.example', to=('ari@rebattery.io',), identity='ari')     # known person
    inbound('m2', 't2', 'nico@yard.example', to=('ari@rebattery.io',), identity='ari')    # unknown person, company domain
    inbound('m3', 't3', 'pat@yard.example')                                                # dismantler, but reached supply@
    with psycopg2.connect(DSN) as db, db.cursor() as cur:
        cur.execute("insert into mail_thread (id, subject) values ('t4','x') on conflict do nothing")
    inbound('m4', 't4', 'kim@buyer.example', to=('ari@rebattery.io',), identity='ari')    # not a dismantler
    with psycopg2.connect(DSN) as db, db.cursor(cursor_factory=__import__('psycopg2.extras').extras.RealDictCursor) as cur:
        hits = {}
        for m in ('m1', 'm2', 'm3', 'm4'):
            cur.execute("select * from mail_message where id=%s", (m,))
            hits[m] = owner.route(cur, cur.fetchone())
    assert hits['m1'][:3] == ('dismantlercampaigns', 'dc-main', 'rule dismantler=ari')
    assert hits['m2'][:3] == ('dismantlercampaigns', 'dc-main', 'rule dismantler=ari')
    assert hits['m3'] is None and hits['m4'] is None


def test_free_mail_domain_never_resolves_a_company():
    with psycopg2.connect(DSN) as db, db.cursor(cursor_factory=__import__('psycopg2.extras').extras.RealDictCursor) as cur:
        cur.execute("insert into crm_companies (id, name, domain) values ('gm-co','Gmail yard','gmail.com') on conflict do nothing")
        assert owner.sender_company(cur, None, 'someone@gmail.com') is None
