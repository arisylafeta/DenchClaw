"""Content-only retention with replay markers, never provider operations.

Overwrite complete expired JSONL lines in place, preserving inode, length and
append offsets. The capture writer only appends, so concurrent new lines survive.
Database logical keys remain as erasure markers; restored backups must replay the
private deletion manifest before readers/importers are enabled.
"""
import hashlib
import json
import os
from datetime import datetime, timedelta, timezone
from pathlib import Path

from .core import Refused, account_jid, connection, cursor, instant, lock_account
from .ingest import read_lines


def expired_lines(path, cutoff, account=None):
    for file in sorted(Path(path).glob('*.jsonl')):
        for start, finish, line in read_lines(file):
            try:
                record = json.loads(line)
                if record.get('retentionErased'):
                    continue
                if account and account_jid(record.get('account')) != account:
                    raise Refused('unexpected_account')
                expired = instant(record['capturedAt']) < cutoff
                flags = record.get('flags') or {}
                expired = expired or flags.get('viewOnce') or bool(
                    flags.get('expiresAt') and instant(flags['expiresAt']) <= datetime.now(timezone.utc))
            except (ValueError, TypeError, KeyError, AttributeError):
                expired = datetime.fromtimestamp(file.stat().st_mtime, timezone.utc) < cutoff
            if expired:
                yield file, start, finish, hashlib.sha256(line).hexdigest()


def erase_line(file, start, finish, digest):
    marker = b'{"retentionErased":true}'
    size = finish - start
    if size < len(marker) + 1:
        marker = b'{}'
    if size < len(marker) + 1:
        marker = b''
    with file.open('r+b', buffering=0) as handle:
        handle.seek(start)
        original = handle.read(size)
        if hashlib.sha256(original).hexdigest() != digest:
            raise Refused('retention_source_changed')
        handle.seek(start)
        handle.write(marker + b' ' * (size - len(marker) - 1) + b'\n')
        os.fsync(handle.fileno())


def retain(path, account, apply=False):
    account = account_jid(account)
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=30)
    raw = list(expired_lines(path, cutoff, account))
    with connection() as db, cursor(db) as cur:
        lock_account(cur, account)
        cur.execute("select count(*) as n from whatsapp_message where account_id=%s and metadata->>'legal_hold'='true'", (account,))
        if cur.fetchone()['n']:
            raise Refused('retention_legal_hold_requires_operator')
        cur.execute('''select m.id from whatsapp_message m join whatsapp_thread t on t.id=m.thread_id
          where m.account_id=%s and coalesce(m.metadata->>'content_redacted','false') <> 'true'
          and ((m.metadata->'flags'->>'expiresAt' is not null and
            (m.metadata->'flags'->>'expiresAt')::timestamptz <= now()) or
            (m.captured_at < %s and (m.metadata->>'personal'='true' or not exists (
              select 1 from whatsapp_thread_member tm join whatsapp_identity_link l
              on l.identity_id=tm.identity_id and l.valid_to is null where tm.thread_id=t.id))))''',
          (account, cutoff))
        ids = [row['id'] for row in cur.fetchall()]
        cur.execute("select count(*) as n from whatsapp_event where account_id=%s and kind='quarantine' and captured_at < %s and payload <> '{}'::jsonb", (account, cutoff))
        quarantine = cur.fetchone()['n']
        result = {'apply': apply, 'raw_lines': len(raw), 'messages': len(ids), 'quarantine_events': quarantine}
        if not apply:
            db.rollback()
            return result
        # Persist content-free restore instructions before any irreversible purge.
        manifest = Path(path) / 'retention-manifest.ndjson'
        fd = os.open(manifest, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, 'a') as handle:
            handle.write(json.dumps({'at': now.isoformat(), 'account': account, 'message_ids': ids,
                'raw': [{'file': f.name, 'start': s, 'finish': e, 'sha256': h} for f, s, e, h in raw]}) + '\n')
            handle.flush()
            os.fsync(handle.fileno())
        cur.execute('''update whatsapp_message set body=null,attachment=null,
          metadata=jsonb_build_object('content_redacted',true,'retention_erased',true)
          where id=any(%s)''', (ids,))
        cur.execute("update whatsapp_event set payload='{}'::jsonb where message_id=any(%s)", (ids,))
        cur.execute("update whatsapp_event set payload='{}'::jsonb where account_id=%s and kind='quarantine' and captured_at < %s", (account, cutoff))
        for file, start, finish, digest in raw:
            erase_line(file, start, finish, digest)
        return result
