"""Local Postgres plumbing. No WhatsApp provider, auth or sending dependencies."""
import hashlib
import json
import os
from datetime import datetime, timezone

import psycopg2
from psycopg2.extras import RealDictCursor


class Refused(Exception):
    exit_code = 1

    def __init__(self, rule, message=None):
        super().__init__(message or rule)
        self.rule = rule


class ProviderError(Refused):
    exit_code = 3


def stable_id(*parts):
    return hashlib.sha256(json.dumps(parts, sort_keys=True, default=str, separators=(',', ':')).encode()).hexdigest()


def connection(read_only=False):
    if not read_only and not os.environ.get('DENCH_WHATSAPP_DSN'):
        raise Refused('explicit_database_required', 'Set DENCH_WHATSAPP_DSN for transactional mutations')
    dsn = os.environ.get('DENCH_WHATSAPP_DSN', os.environ.get('DENCH_CAMPAIGN_DSN', 'dbname=denchclaw'))
    db = psycopg2.connect(dsn)
    db.set_session(readonly=read_only)
    return db


def cursor(db):
    return db.cursor(cursor_factory=RealDictCursor)


def instant(value):
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value / 1000 if value > 1e11 else value, timezone.utc)
    if isinstance(value, str):
        parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if parsed.tzinfo is None:
            raise ValueError('timezone required')
        return parsed.astimezone(timezone.utc)
    raise ValueError('timestamp required')


def account_jid(raw):
    if not isinstance(raw, str) or '@' not in raw:
        raise Refused('invalid_account')
    local, domain = raw.split('@', 1)
    if domain != 's.whatsapp.net' or not local.split(':')[0].isdigit():
        raise Refused('invalid_account')
    return local.split(':')[0] + '@' + domain


def lock_account(cur, account):
    cur.execute('select pg_try_advisory_xact_lock(hashtextextended(%s, 0)) as acquired', ('whatsapp:' + account,))
    if not cur.fetchone()['acquired']:
        raise Refused('import_in_progress')
