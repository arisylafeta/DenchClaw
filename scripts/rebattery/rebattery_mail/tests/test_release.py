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
