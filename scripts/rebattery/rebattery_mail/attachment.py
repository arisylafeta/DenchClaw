"""Attachment metadata and download, built on gog's Gmail attachment support.

Reads are live (Gmail is the source of bytes); sync keeps filename metadata in
personalization.attachments for inbound rows so search can filter by filename.
Downloads go to a private store and never overwrite an existing file.
"""
import hashlib
import json
import mimetypes
import os
import re
import subprocess
from email.message import Message
from pathlib import Path
from .core import connection, dict_cursor, Refused, ProviderError, gog_env
from .gmail_driver import GmailDriver

STORE = Path(os.environ.get('REBATTERY_MAIL_ATTACHMENT_STORE', '/srv/rebattery-data/mail-attachments'))
GMAIL_LIMIT_BYTES = 25 * 1024 * 1024


def safe_name(name):
    base = re.sub(r'[\x00-\x1f/\\]', '_', os.path.basename(name or '')).strip().strip('.')
    return base or 'attachment'


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    return digest.hexdigest()


def inline_ids(full):
    """Attachment ids of MIME parts that are inline/embedded rather than attached files."""
    inline, pending = set(), [((full.get('message') or {}).get('payload'))]
    while pending:
        part = pending.pop()
        if not isinstance(part, dict):
            continue
        headers = Message()
        for header in part.get('headers') or []:
            if isinstance(header, dict) and isinstance(header.get('name'), str) and isinstance(header.get('value'), str):
                headers[header['name']] = header['value']
        attachment_id = (part.get('body') or {}).get('attachmentId')
        if attachment_id and (headers.get_content_disposition() == 'inline' or (headers.get('Content-ID') and headers.get_content_disposition() != 'attachment')):
            inline.add(attachment_id)
        pending.extend(part.get('parts') or [])
    return inline


def describe(full):
    inline = inline_ids(full)
    return [{'filename': a.get('filename'), 'mediaType': a.get('mimeType'), 'sizeBytes': a.get('size'),
             'attachmentId': a.get('attachmentId'), 'inline': a.get('attachmentId') in inline}
            for a in full.get('attachments') or []]


def account_for(db, row):
    with dict_cursor(db) as cur:
        if row.get('mailbox_owner_id'):
            cur.execute('select email from crm_users where id=%s', (row['mailbox_owner_id'],))
            owner = cur.fetchone()
            if owner:
                return owner['email']
        if row.get('identity_key'):
            cur.execute('select gmail_account from mail_identity where key=%s', (row['identity_key'],))
            identity = cur.fetchone()
            if identity and identity['gmail_account']:
                return identity['gmail_account']
    raise Refused('mailbox_account_unknown', message_id=row['id'])


def live_attachments(db, row, driver=None):
    """Attachment list for one stored message, fetched from Gmail. Never raises for provider trouble."""
    if not row.get('has_attachments'):
        return []
    if row.get('transport') != 'gmail' or not row.get('gmail_message_id'):
        return {'unavailable': 'not_a_gmail_message'}
    try:
        return describe((driver or GmailDriver()).fetch(account_for(db, row), row['gmail_message_id']))
    except (ProviderError, Refused) as exc:
        return {'unavailable': exc.rule}


def load_message(db, message_id):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_message where id=%s', (message_id,))
        row = cur.fetchone()
    if not row:
        raise Refused('message_not_found', message_id=message_id)
    return dict(row)


def list_attachments(args, driver=None):
    with connection(read_only=True) as db:
        row = load_message(db, args.message)
        return {'message_id': row['id'], 'gmail_message_id': row['gmail_message_id'], 'subject': row['subject'],
                'attachments': live_attachments(db, row, driver)}


def pick(attachments, selector):
    exact = [a for a in attachments if selector in (a['attachmentId'], a['filename'])]
    matches = exact or [a for a in attachments if selector.lower() in (a['filename'] or '').lower()]
    if not matches:
        raise Refused('attachment_not_found', selector=selector, available=[a['filename'] for a in attachments])
    if len(matches) > 1:
        raise Refused('attachment_ambiguous', selector=selector, matches=[{'filename': a['filename'], 'attachmentId': a['attachmentId'][:24]} for a in matches])
    return matches[0]


def get(args, driver=None, runner=None):
    runner = runner or subprocess.run
    with connection(read_only=True) as db:
        row = load_message(db, args.message)
        if row['transport'] != 'gmail' or not row['gmail_message_id']:
            raise Refused('attachment_unavailable_for_transport', transport=row['transport'])
        account = account_for(db, row)
    full = (driver or GmailDriver()).fetch(account, row['gmail_message_id'])
    chosen = pick(describe(full), args.attachment)
    destination = Path(args.out) if args.out else STORE / row['id'] / safe_name(chosen['filename'])
    if destination.exists():
        raise Refused('output_exists', path=str(destination))
    destination.parent.mkdir(parents=True, exist_ok=True)
    if not args.out:
        os.chmod(destination.parent, 0o700)
    try:
        result = runner(['/usr/local/bin/gog', '--account', account, '--json', '--no-input', 'gmail', 'attachment', row['gmail_message_id'], chosen['attachmentId'], '--out', str(destination)],
                        capture_output=True, text=True, timeout=300, env=gog_env())
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise ProviderError('attachment_download_failed', cause=type(exc).__name__) from exc
    if result.returncode or not destination.exists():
        destination.unlink(missing_ok=True)
        raise ProviderError('attachment_download_failed', returncode=result.returncode)
    os.chmod(destination, 0o600)
    size = destination.stat().st_size
    if chosen['sizeBytes'] and size != chosen['sizeBytes']:
        destination.unlink(missing_ok=True)
        raise ProviderError('attachment_size_mismatch', expected=chosen['sizeBytes'], actual=size)
    return {'message_id': row['id'], 'filename': chosen['filename'], 'mediaType': chosen['mediaType'], 'sizeBytes': size,
            'sha256': sha256_file(destination), 'path': str(destination)}


def backfill(args, driver=None):
    """Store attachment metadata on inbound rows that predate it. Touches personalization.attachments only."""
    driver = driver or GmailDriver()
    done, failed = 0, []
    with connection(read_only=not args.apply) as db:
        with dict_cursor(db) as cur:
            cur.execute("""select * from mail_message where direction='inbound' and transport='gmail' and has_attachments
                and gmail_message_id is not null and not (personalization ? 'attachments')
                and (%s::timestamptz is null or sent_at>=%s::timestamptz) order by sent_at desc nulls last limit %s""", (args.since, args.since, args.limit))
            rows = [dict(r) for r in cur.fetchall()]
        for row in rows:
            attachments = live_attachments(db, row, driver)
            if not isinstance(attachments, list):
                failed.append({'id': row['id'], 'reason': attachments.get('unavailable')})
                continue
            done += 1
            if args.apply:
                with db.cursor() as cur:
                    cur.execute("update mail_message set personalization=jsonb_set(personalization,'{attachments}',%s::jsonb,true) where id=%s", (json.dumps(attachments), row['id']))
    return {'candidates': len(rows), 'updated' if args.apply else 'would_update': done, 'failed': failed, 'dry_run': not args.apply}


def prepare_outbound(paths):
    """Hash and copy files into the private store so an approved send is byte-exact."""
    items, total = [], 0
    for raw in paths:
        source = Path(raw).expanduser()
        if not source.is_file():
            raise Refused('attachment_file_missing', path=raw)
        name = safe_name(source.name)
        size = source.stat().st_size
        if size == 0:
            raise Refused('attachment_empty', path=raw)
        total += size
        digest = sha256_file(source)
        stored = STORE / 'outbound' / digest / name
        stored.parent.mkdir(parents=True, exist_ok=True)
        os.chmod(stored.parent, 0o700)
        if not stored.exists():
            tmp = stored.with_name(stored.name + '.part')
            tmp.write_bytes(source.read_bytes())
            os.chmod(tmp, 0o600)
            os.replace(tmp, stored)
        if sha256_file(stored) != digest:
            raise Refused('attachment_copy_mismatch', path=raw)
        items.append({'filename': name, 'sha256': digest, 'sizeBytes': size,
                      'mediaType': mimetypes.guess_type(name)[0] or 'application/octet-stream', 'storedPath': str(stored)})
    if total > GMAIL_LIMIT_BYTES:
        raise Refused('attachments_too_large', totalBytes=total, limitBytes=GMAIL_LIMIT_BYTES)
    return items


def verify_outbound(items):
    """Refuse to send if any stored file changed since approval."""
    paths = []
    for item in items:
        path = Path(item['storedPath'])
        if not path.is_file() or sha256_file(path) != item['sha256']:
            raise Refused('attachment_changed_since_approval', filename=item['filename'])
        paths.append(str(path))
    return paths


def register(subparsers):
    parser = subparsers.add_parser('attachment')
    sub = parser.add_subparsers(dest='attachment_command', required=True)
    p = sub.add_parser('list')
    p.add_argument('message')
    p.set_defaults(handler=list_attachments)
    p = sub.add_parser('get')
    p.add_argument('message')
    p.add_argument('attachment', help='attachmentId, exact filename, or a unique filename fragment')
    p.add_argument('--out', help='New file path; never overwritten. Default: private mail-attachments store')
    p.set_defaults(handler=get)
    p = sub.add_parser('backfill')
    p.add_argument('--since')
    p.add_argument('--limit', type=int, default=200)
    p.add_argument('--apply', action='store_true')
    p.set_defaults(handler=backfill)
