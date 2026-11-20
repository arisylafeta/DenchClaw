"""Settle a Gmail or Postmark send left in 'sending', 'unknown' or 'failed' by an interrupted or refused attempt.

Looks in the sending mailbox's Sent folder for the message (same recipients, subject and sender, after the claim).
Found: the row becomes accepted with that Gmail id. Not found, and the attempt is old enough that a late
delivery is not plausible: the row goes back to an unsent draft (claim and idempotency key cleared) so a person
can send it again. A found message gets a 'sent' event; a release is recorded in personalization.send_failure. Never sends anything.

Postmark rows: the same, but the provider is searched read-only (outbound messages by metadata recipient_id and by
recipient address, filtered to this message id) and the settle window is longer to allow for search lag. A released
campaign member goes back to 'frozen' (its approved state), anything else to 'draft'.
"""
import urllib.parse
import json
from datetime import datetime, timedelta, timezone
from email.utils import getaddresses
from .core import connection, dict_cursor, Refused
from .gmail_driver import GmailDriver
from . import drivers

SETTLE_AFTER = timedelta(minutes=5)
POSTMARK_SETTLE_AFTER = timedelta(minutes=15)


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


def find_in_postmark(client, stream, row):
    """Exactly one outbound message carrying this row's recipient_id and the same recipients; two is ambiguous."""
    expected = {a.strip().lower() for key in ('to_emails', 'cc_emails', 'bcc_emails') for a in (row.get(key) or [])}
    params = urllib.parse.urlencode({'count': 100, 'offset': 0, 'messagestream': stream, 'metadata_recipient_id': row['id']})
    matches = [m for m in client('/messages/outbound?' + params).get('Messages', [])
               if m.get('MessageID') and (m.get('Metadata') or {}).get('recipient_id') == row['id']
               and {a.strip().lower() for a in m.get('Recipients', [])} == expected]
    if len(matches) > 1:
        raise Refused('postmark_match_ambiguous', message_id=row['id'], matches=[m['MessageID'] for m in matches])
    return {'provider_message_id': matches[0]['MessageID']} if matches else None


def release(args, driver=None):
    with connection(read_only=True) as db, dict_cursor(db) as cur:
        cur.execute("select m.*, i.gmail_account, i.postmark_stream from mail_message m join mail_identity i on i.key = m.identity_key where m.id = %s", (args.target,))
        row = cur.fetchone()
    if not row:
        raise Refused('message_not_found', message_id=args.target)
    row = dict(row)
    if row['state'] not in ('sending', 'unknown', 'failed'):
        raise Refused('nothing_to_release', state=row['state'])
    postmark = str(row['transport'] or '').startswith('postmark')
    if postmark:
        if not row['postmark_stream']:
            raise Refused('release_requires_postmark_stream')
        # A recorded provider id is direct evidence of acceptance; never release over it.
        found = {'provider_message_id': row['provider_message_id']} if row.get('provider_message_id') else \
            find_in_postmark(driver or drivers.postmark, row['postmark_stream'], row)
        settle = POSTMARK_SETTLE_AFTER
    elif row['transport'] != 'gmail' or not row['gmail_account']:
        raise Refused('release_requires_gmail_or_postmark_transport')
    else:
        found = find_in_sent(driver or GmailDriver(), row['gmail_account'], row)
        settle = SETTLE_AFTER
    age = datetime.now(timezone.utc) - (row['claimed_at'] or row['updated_at'])
    if not found and row['state'] != 'failed' and age < settle:
        return {'message_id': row['id'], 'outcome': 'wait', 'retry_after_seconds': int((settle - age).total_seconds()), 'dry_run': not args.apply}
    outcome = 'sent' if found else 'released'
    if args.apply:
        with connection() as db, db.cursor() as cur:
            if found:
                cur.execute("""update mail_message set state='accepted', provider_message_id=coalesce(%s, provider_message_id), gmail_message_id=coalesce(%s, gmail_message_id),
                    rfc_message_id=coalesce(%s, rfc_message_id),
                    accepted_at=coalesce(accepted_at, now()), sent_at=coalesce(sent_at, now()), updated_at=now()
                    where id=%s and state in ('sending','unknown','failed')""", (found.get('provider_message_id'), found.get('gmail_message_id'), found.get('rfc_message_id'), row['id']))
                if cur.rowcount != 1:
                    raise Refused('state_changed', message_id=row['id'])
                cur.execute("insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values (%s,'sent',%s,%s,now(),%s::jsonb) on conflict do nothing",
                            (row['id'], 'postmark' if postmark else 'gmail', 'sent:' + row['id'], json.dumps({'recovered_from': row['state'], **found})))
            else:
                cur.execute("""update mail_message set state=%s, claimed_at=null, idempotency_key=null, updated_at=now(),
                    personalization=jsonb_set(coalesce(personalization,'{}'::jsonb),'{send_failure}',%s::jsonb,true)
                    where id=%s and state in ('sending','unknown','failed')""",
                            ('frozen' if postmark and row['campaign_id'] else 'draft',
                             json.dumps({'reason': 'not_sent_released', 'detail': {'was': row['state'], 'previous': (row.get('personalization') or {}).get('send_failure')}}), row['id']))
                if cur.rowcount != 1:
                    raise Refused('state_changed', message_id=row['id'])
    return {'message_id': row['id'], 'outcome': outcome, **(found or {}), 'dry_run': not args.apply}


def register(subparsers):
    parser = subparsers.add_parser('release', help='Settle a stuck or failed Gmail or Postmark send: mark it sent if the provider has it, else back to draft (frozen for campaign members)')
    parser.add_argument('target')
    parser.add_argument('--apply', action='store_true')
    parser.set_defaults(handler=release)
