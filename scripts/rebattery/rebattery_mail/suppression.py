"""Address-level suppression truth, independent of CRM enrolment or delivery."""
import json
from .core import dict_cursor, Refused


def is_suppressed(db, email):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_suppression where email=%s', ((email or '').strip().lower(),))
        row = cur.fetchone()
    return dict(row) if row else None


def record_suppression(db, email, reason, source, stream, since, detail):
    email = (email or '').strip().lower()
    if '@' not in email:
        raise Refused('suppression_missing_address')
    with db.cursor() as cur:
        # Absence/reactivation never deletes consent evidence.
        cur.execute('''insert into mail_suppression(email,reason,source,stream,since,detail)
            values(%s,%s,%s,%s,%s,%s::jsonb) on conflict(email) do update set
            reason=excluded.reason, source=excluded.source, stream=excluded.stream,
            since=least(mail_suppression.since,excluded.since),
            detail=mail_suppression.detail || excluded.detail
            where (mail_suppression.reason,mail_suppression.source,mail_suppression.stream,mail_suppression.since,mail_suppression.detail)
              is distinct from (excluded.reason,excluded.source,excluded.stream,least(mail_suppression.since,excluded.since),mail_suppression.detail || excluded.detail)''',
            (email,reason,source,stream,since,json.dumps(detail,default=str)))
