"""release: settle stuck or failed Gmail sends. Fake Gmail only; nothing is sent."""
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace as NS
import pytest
from rebattery_mail import release
from rebattery_mail.core import connection, Refused
from rebattery_mail.tests.test_send import env, one, fake_execution_gate  # noqa: F401


class Sent:
    def __init__(self, found=None):
        self.found = found or []
    def search(self, account, query):
        assert query.startswith('in:sent ')
        return [{'id': f['id']} for f in self.found]
    def fetch(self, account, id):
        return next(f['full'] for f in self.found if f['id'] == id)


def stuck(prefix, state='sending', minutes=10):
    row = one(prefix)
    with connection() as db, db.cursor() as cur:
        cur.execute("update mail_message set state=%s, claimed_at=now()-%s::interval, idempotency_key=%s where id=%s",
                    (state, f'{minutes} minutes', 'mail:' + row['id'], row['id']))
    return row


def state(id):
    with connection(read_only=True) as db, db.cursor() as cur:
        cur.execute("select state, idempotency_key, personalization->'send_failure' from mail_message where id=%s", (id,))
        return cur.fetchone()


def test_not_in_sent_goes_back_to_draft(env):
    row = stuck(env)
    out = release.release(NS(target=row['id'], apply=True), Sent())
    assert out['outcome'] == 'released'
    s, key, failure = state(row['id'])
    assert s == 'draft' and key is None and failure['reason'] == 'not_sent_released'


def test_found_in_sent_becomes_accepted(env):
    row = stuck(env)
    full = {'headers': {'to': row['to_emails'][0], 'from': 'Alex <alex@rebattery.io>', 'subject': row['subject'], 'message-id': '<x@mail>'}}
    out = release.release(NS(target=row['id'], apply=True), Sent([{'id': 'g1', 'full': full}]))
    assert out['outcome'] == 'sent' and state(row['id'])[0] == 'accepted'


def test_recent_attempt_waits_and_drafts_are_refused(env):
    row = stuck(env, minutes=1)
    assert release.release(NS(target=row['id'], apply=True), Sent())['outcome'] == 'wait'
    assert state(row['id'])[0] == 'sending'
    fresh = one(env + 'b')
    with pytest.raises(Refused, match='nothing_to_release'):
        release.release(NS(target=fresh['id'], apply=True), Sent())


class Postmark:
    def __init__(self, messages=None):
        self.messages, self.calls = messages or [], []
    def __call__(self, path, method='GET', payload=None):
        assert method == 'GET'
        self.calls.append(path)
        return {'Messages': self.messages}


def postmark_stuck(prefix, minutes=30, campaign=None):
    row = stuck(prefix, minutes=minutes)
    with connection() as db, db.cursor() as cur:
        if campaign:
            cur.execute("insert into campaigns(id,campaign_name,audience_size) values (%s,%s,1)", (campaign, campaign))
        cur.execute("update mail_message set transport='postmark-broadcast', campaign_id=%s where id=%s", (campaign, row['id']))
        cur.execute("update mail_identity set postmark_stream='broadcast' where key=%s and postmark_stream is null", (row['identity_key'],))
    return row


def test_postmark_found_becomes_accepted(env):
    row = postmark_stuck(env)
    hit = {'MessageID': 'pm-1', 'Recipients': row['to_emails'], 'Metadata': {'recipient_id': row['id']}}
    out = release.release(NS(target=row['id'], apply=True), Postmark([hit]))
    assert out['outcome'] == 'sent' and out['provider_message_id'] == 'pm-1'
    with connection(read_only=True) as db, db.cursor() as cur:
        cur.execute("select state, provider_message_id from mail_message where id=%s", (row['id'],))
        assert cur.fetchone() == ('accepted', 'pm-1')
        cur.execute("select count(*) from mail_event where message_id=%s and type='sent' and source='postmark'", (row['id'],))
        assert cur.fetchone()[0] == 1


def test_postmark_ignores_other_recipient_ids(env):
    row = postmark_stuck(env)
    other = {'MessageID': 'pm-2', 'Recipients': row['to_emails'], 'Metadata': {'recipient_id': 'someone-else'}}
    out = release.release(NS(target=row['id'], apply=True), Postmark([other]))
    assert out['outcome'] == 'released'


def test_postmark_not_found_after_settle_returns_campaign_member_to_frozen(env):
    row = postmark_stuck(env, campaign=env + 'c')
    client = Postmark()
    out = release.release(NS(target=row['id'], apply=True), client)
    assert out['outcome'] == 'released' and len(client.calls) == 1
    s, key, failure = state(row['id'])
    assert s == 'frozen' and key is None and failure['reason'] == 'not_sent_released'


def test_postmark_recent_attempt_waits_and_dry_run_changes_nothing(env):
    row = postmark_stuck(env, minutes=5)
    assert release.release(NS(target=row['id'], apply=True), Postmark())['outcome'] == 'wait'
    old = postmark_stuck(env + 'b', minutes=30)
    assert release.release(NS(target=old['id'], apply=False), Postmark())['dry_run'] is True
    assert state(old['id'])[0] == 'sending'


def test_postmark_bcc_counts_as_recipient(env):
    row = postmark_stuck(env)
    with connection() as db, db.cursor() as cur:
        cur.execute("update mail_message set bcc_emails=%s where id=%s", (['audit@example.test'], row['id']))
    hit = {'MessageID': 'pm-b', 'Recipients': row['to_emails'] + ['audit@example.test'], 'Metadata': {'recipient_id': row['id']}}
    assert release.release(NS(target=row['id'], apply=True), Postmark([hit]))['outcome'] == 'sent'


def test_postmark_two_matches_is_refused_and_row_untouched(env):
    row = postmark_stuck(env)
    hit = {'MessageID': 'pm-1', 'Recipients': row['to_emails'], 'Metadata': {'recipient_id': row['id']}}
    with pytest.raises(Refused, match='postmark_match_ambiguous'):
        release.release(NS(target=row['id'], apply=True), Postmark([hit, {**hit, 'MessageID': 'pm-2'}]))
    assert state(row['id'])[0] == 'sending'


def test_postmark_recorded_provider_id_is_never_released(env):
    row = postmark_stuck(env)
    with connection() as db, db.cursor() as cur:
        cur.execute("update mail_message set provider_message_id='pm-known' where id=%s", (row['id'],))
    out = release.release(NS(target=row['id'], apply=True), Postmark())
    assert out['outcome'] == 'sent' and out['provider_message_id'] == 'pm-known'


def test_accepted_row_is_refused(env):
    row = postmark_stuck(env)
    with connection() as db, db.cursor() as cur:
        cur.execute("update mail_message set state='accepted' where id=%s", (row['id'],))
    with pytest.raises(Refused, match='nothing_to_release'):
        release.release(NS(target=row['id'], apply=True), Postmark())
