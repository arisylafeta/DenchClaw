"""Settle a Gmail send left in 'sending', 'unknown' or 'failed' by an interrupted or refused attempt.

Looks in the sending mailbox's Sent folder for the message (same recipients, subject and sender, after the claim).
Found: the row becomes accepted with that Gmail id. Not found, and the attempt is old enough that a late
delivery is not plausible: the row goes back to an unsent draft (claim and idempotency key cleared) so a person
can send it again. A found message gets a 'sent' event; a release is recorded in personalization.send_failure. Never sends anything.
"""
import json
from datetime import datetime, timedelta, timezone
from email.utils import getaddresses
from .core import connection, dict_cursor, Refused
from .gmail_driver import GmailDriver

SETTLE_AFTER = timedelta(minutes=5)


def _addresses(values):
    return {a.lower() for _, a in getaddresses([v for v in values if v]) if a}


def find_in_sent(driver, account, row):
    since = (row['claimed_at'] or row['updated_at']) - timedelta(days=1)
    expected = {a.strip().lower() for key in ('to_emails', 'cc_emails') for a in (row.get(key) or [])}
    query = f"in:sent after:{since.strftime('%Y/%m/%d')} " + " ".join(f"to:{a}" for a in sorted({a.strip().lower() for a in row['to_emails']}))
    for hit in driver.search(account, query):
        full = driver.fetch(account, hit['id'])
        headers = {k.lower().replace('_', '-'): v for k, v in (full.get('headers') or {}).items()}
        recipients = _addresses([headers.get('to'), headers.get('cc')])
        subject = (headers.get('subject') or '').strip()
        if recipients == expected and subject == (row['subject'] or '').strip() and row['from_email'].lower() in _addresses([headers.get('from')]):
            return {'gmail_message_id': hit['id'], 'rfc_message_id': headers.get('message-id')}
    return None


def release(args, driver=None):
    with connection(read_only=True) as db, dict_cursor(db) as cur:
        cur.execute("select m.*, i.gmail_account from mail_message m join mail_identity i on i.key = m.identity_key where m.id = %s", (args.target,))
        row = cur.fetchone()
    if not row:
        raise Refused('message_not_found', message_id=args.target)
    row = dict(row)
    if row['state'] not in ('sending', 'unknown', 'failed'):
        raise Refused('nothing_to_release', state=row['state'])
    if row['transport'] != 'gmail' or not row['gmail_account']:
        raise Refused('release_requires_gmail_transport')
    found = find_in_sent(driver or GmailDriver(), row['gmail_account'], row)
    age = datetime.now(timezone.utc) - (row['claimed_at'] or row['updated_at'])
    if not found and row['state'] != 'failed' and age < SETTLE_AFTER:
        return {'message_id': row['id'], 'outcome': 'wait', 'retry_after_seconds': int((SETTLE_AFTER - age).total_seconds()), 'dry_run': not args.apply}
    outcome = 'sent' if found else 'released'
    if args.apply:
        with connection() as db, db.cursor() as cur:
            if found:
                cur.execute("""update mail_message set state='accepted', gmail_message_id=%s, rfc_message_id=coalesce(%s, rfc_message_id),
                    accepted_at=coalesce(accepted_at, now()), sent_at=coalesce(sent_at, now()), updated_at=now()
                    where id=%s and state in ('sending','unknown','failed')""", (found['gmail_message_id'], found['rfc_message_id'], row['id']))
                cur.execute("insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values (%s,'sent','gmail',%s,now(),%s::jsonb) on conflict do nothing",
                            (row['id'], 'sent:' + row['id'], json.dumps({'recovered_from': row['state'], **found})))
            else:
                cur.execute("""update mail_message set state='draft', claimed_at=null, idempotency_key=null, updated_at=now(),
                    personalization=jsonb_set(coalesce(personalization,'{}'::jsonb),'{send_failure}',%s::jsonb,true)
                    where id=%s and state in ('sending','unknown','failed')""",
                            (json.dumps({'reason': 'not_sent_released', 'detail': {'was': row['state'], 'previous': (row.get('personalization') or {}).get('send_failure')}}), row['id']))
    return {'message_id': row['id'], 'outcome': outcome, **(found or {}), 'dry_run': not args.apply}


def register(subparsers):
    parser = subparsers.add_parser('release', help='Settle a stuck or failed Gmail send: mark it sent if Gmail has it, else back to draft')
    parser.add_argument('target')
    parser.add_argument('--apply', action='store_true')
    parser.set_defaults(handler=release)
