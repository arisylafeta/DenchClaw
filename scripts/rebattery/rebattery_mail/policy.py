"""Named, fail-closed policy shared by preparation and execution."""
import re
from datetime import datetime, timezone
from .core import Refused, dict_cursor

UNSUBSCRIBE = '{{{ pm:unsubscribe }}}'


def identity(db, key, purpose, transport=None):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_identity where key=%s', (key,))
        row = cur.fetchone()
    if not row or not row['active']:
        raise Refused('identity_unavailable', identity=key)
    if purpose not in row['allowed_purposes']:
        raise Refused('purpose_not_allowed_for_identity')
    if transport is None:
        transport = ('postmark-broadcast' if purpose == 'marketing' else 'postmark-transactional') if row['postmark_stream'] else 'gmail'
    if (transport == 'gmail' and not row['gmail_account']) or (transport.startswith('postmark') and not row['postmark_stream']):
        raise Refused('identity_transport_unavailable')
    if purpose == 'marketing' and transport.startswith('postmark') and row['postmark_stream'] == 'outbound':
        raise Refused('postmark_broadcast_stream_required')
    return dict(row), transport


def content(message):
    text, html = message.get('body_text') or '', message.get('body_html') or ''
    combined = '\n'.join((message.get('subject') or '', text, html))
    if re.search(r'\{\{|\}\}|\{%|\*\|[^|]+\|\*', combined.replace(UNSUBSCRIBE, '')):
        raise Refused('literal_merge_token')
    if message['purpose'] == 'marketing':
        if message['transport'].startswith('postmark'):
            valid = UNSUBSCRIBE in text and UNSUBSCRIBE in html
        else:
            valid = bool(re.search(r'(?i)unsubscribe.{0,150}(https://\S+|mailto:\S+)', text))
        if not valid:
            raise Refused('marketing_requires_unsubscribe')


def recipient(db, email, verification, suppressions=None):
    email = email.strip().lower()
    if email in (suppressions or {}):
        raise Refused('recipient_suppressed', email=email)
    with dict_cursor(db) as cur:
        cur.execute("""select p.id,p.email_opted_out,
            exists(select 1 from crm_subscriptions s where s.person_id=p.id and s.status='Opted out') as opted_out
            from crm_people p where lower(trim(p.email))=%s""", (email,))
        people = cur.fetchall()
        if any(p['email_opted_out'] or p['opted_out'] for p in people):
            raise Refused('recipient_opted_out', email=email)
        cur.execute("""select e.type from mail_event e join mail_message m on m.id=e.message_id
            where %s=any(m.to_emails) and e.type in ('bounced','suppressed','unsubscribed')
            union select 'bounced' from mail_message where %s=any(to_emails) and bounced_at is not null""", (email,email))
        events = {r['type'] for r in cur.fetchall()}
    for event, rule in [('bounced','recipient_bounced'),('suppressed','recipient_suppressed'),('unsubscribed','recipient_opted_out')]:
        if event in events:
            raise Refused(rule, email=email)
    evidence = verification.get(email, {}) if isinstance(verification, dict) else {}
    if isinstance(evidence, str):
        evidence = {'status': evidence}
    # ZeroBounce's role_based flag is deliberately not an exclusion.
    if evidence.get('status') != 'valid':
        raise Refused('recipient_unverified', email=email, verification_status=evidence.get('status','missing'), verification_reason=evidence.get('sub_status'))
    return email


def thread_reply(db, message):
    if not message.get('thread_id'):
        return False
    with dict_cursor(db) as cur:
        cur.execute("""select 1 from mail_message where thread_id=%s and direction='inbound'
            and coalesce(sent_at,created_at)>%s limit 1""", (message['thread_id'],message['created_at']))
        return bool(cur.fetchone())


def approval(row, sha, count, identity_key, frozen_at=None):
    if not row:
        raise Refused('approval_missing')
    if row.get('revoked_at'):
        raise Refused('approval_revoked')
    if row.get('expires_at') and row['expires_at'] <= datetime.now(timezone.utc):
        raise Refused('approval_expired')
    if frozen_at and row['approved_at'] < frozen_at:
        raise Refused('approval_stale')
    if row['sha256'] != sha:
        raise Refused('approval_digest_mismatch')
    if row['recipient_count'] != count:
        raise Refused('approval_count_mismatch')
    if row['identity_key'] != identity_key:
        raise Refused('approval_identity_mismatch')


def human(name):
    if not name or not name.strip():
        raise Refused('approval_missing', 'A named human approver is required')
    if re.search(r'\b(agent|claude|mailvin|hermes|auto|self|chatgpt|assistant)\b',name,re.I):
        raise Refused('approval_invalid_approver')
    return name.strip()
