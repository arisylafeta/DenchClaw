"""Fill missing Gmail HTML without changing stored copy or routing."""
import argparse
import time
from datetime import datetime, timezone

from .core import connection, dict_cursor, Refused, ProviderError
from .gmail_body import extract_bodies
from .gmail_driver import GmailDriver


def since_date(value):
    try:
        return datetime.strptime(value, '%Y/%m/%d').replace(tzinfo=timezone.utc)
    except ValueError as exc:
        raise argparse.ArgumentTypeError('expected YYYY/MM/DD') from exc


def nonnegative(value):
    number = float(value)
    if not 0 <= number < float('inf'):
        raise argparse.ArgumentTypeError('must be finite and nonnegative')
    return number


def positive(value):
    number = int(value)
    if number < 1:
        raise argparse.ArgumentTypeError('must be positive')
    return number


def backfill_html(db, account, since=None, limit=None, crm_only=False, apply=False, sleep=0.2, driver=None):
    driver = driver or GmailDriver()
    with db.cursor() as cur:
        cur.execute('select id from crm_users where lower(email)=lower(%s) and is_active', (account,))
        owners = cur.fetchall()
        if len(owners) != 1:
            raise Refused('mailbox_owner_not_unique', account=account)
    clauses = ["mailbox_owner_id=%s", "gmail_message_id is not null", "coalesce(body_html,'')=''"]
    params = [owners[0][0]]
    if since:
        clauses.append('sent_at >= %s')
        params.append(since)
    if crm_only:
        clauses.append('crm_visible')
    query = 'select id,gmail_message_id from mail_message where ' + ' and '.join(clauses) + ' order by crm_visible desc,sent_at desc nulls last,id'
    if limit is not None:
        query += ' limit %s'
        params.append(limit)
    with dict_cursor(db) as cur:
        cur.execute(query, params)
        rows = cur.fetchall()
    result = dict(account=account, dry_run=not apply, selected=len(rows), first_ids=[r['id'] for r in rows[:5]], fetched=0, updated=0, would_update=0, no_html=0, no_html_ids=[], errors=0, error_ids=[], aborted=False)
    consecutive_errors = 0
    for index, row in enumerate(rows):
        if index and sleep:
            time.sleep(sleep)
        try:
            full = driver.fetch(account, row['gmail_message_id'])
            _, html, attachments = extract_bodies(full)
        except Exception:
            # Provider diagnostics can include private content. Report identifiers only.
            result['errors'] += 1
            result['error_ids'].append(row['id'])
            consecutive_errors += 1
            if consecutive_errors >= 5:
                result['aborted'] = True
                break
            continue
        consecutive_errors = 0
        result['fetched'] += 1
        if not html:
            result['no_html'] += 1
            result['no_html_ids'].append(row['id'])
            continue
        if not apply:
            result['would_update'] += 1
            continue
        with db.cursor() as cur:
            cur.execute("update mail_message set body_html=%s,has_attachments=has_attachments or %s,updated_at=now() where id=%s and mailbox_owner_id=%s and coalesce(body_html,'')=''", (html, attachments, row['id'], owners[0][0]))
            result['updated'] += cur.rowcount
    return result


def handle(args):
    with connection(read_only=not args.apply) as db:
        result = backfill_html(db, args.account, args.since, args.limit, args.crm_only, args.apply, args.sleep)
    # Leave the transaction normally first so completed updates survive an abort.
    if result['aborted']:
        raise ProviderError('gmail_backfill_consecutive_errors', **result)
    return result


def register(subparsers):
    parser = subparsers.add_parser('backfill-html', description=__doc__)
    parser.add_argument('--account', required=True)
    parser.add_argument('--since', type=since_date)
    parser.add_argument('--limit', type=positive)
    parser.add_argument('--crm-only', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--sleep', type=nonnegative, default=0.2)
    parser.set_defaults(handler=handle)
