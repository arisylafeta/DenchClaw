"""Named, fail-closed policy shared by preparation and execution."""
import re
from datetime import datetime, timezone
from .core import Refused, dict_cursor

UNSUBSCRIBE = '{{{ pm:unsubscribe }}}'


def unsubscribe(author, purpose, transport):
    """Return the policy-owned footer, never caller-supplied merge content."""
    if purpose != 'marketing':
        return '', ''
    if transport == 'postmark-broadcast':
        return UNSUBSCRIBE, UNSUBSCRIBE
    if transport != 'gmail':
        raise Refused('postmark_broadcast_stream_required')
    import html
    url = 'mailto:' + author['address'] + '?subject=unsubscribe'
    return ('<p><a href="' + html.escape(url, quote=True) + '">Unsubscribe</a></p>',
            'Unsubscribe: ' + url)


def identity(db, key, purpose, transport=None):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_identity where key=%s', (key,))
        row = cur.fetchone()
    if not row or not row['active']:
        raise Refused('identity_unavailable', identity=key)
    if purpose not in row['allowed_purposes']:
        raise Refused('purpose_not_allowed_for_identity')
    row = dict(row)
    # An identity can keep Gmail for personal mail yet send transactional mail through Postmark (REB-562).
    tstream = row.get('transactional_postmark_stream')
    if transport is None and purpose == 'transactional' and tstream:
        transport = 'postmark-transactional'
    if transport == 'postmark-transactional' and tstream and not row['postmark_stream']:
        row['postmark_stream'] = tstream
    if transport is None:
        transport = ('postmark-broadcast' if purpose == 'marketing' else 'postmark-transactional') if row['postmark_stream'] else 'gmail'
    if (transport == 'gmail' and not row['gmail_account']) or (transport.startswith('postmark') and not row['postmark_stream']):
        raise Refused('identity_transport_unavailable')
    if purpose == 'marketing' and transport.startswith('postmark') and row['postmark_stream'] == 'outbound':
        raise Refused('postmark_broadcast_stream_required')
    return row, transport


def content(message):
    text, html = message.get('body_text') or '', message.get('body_html') or ''
    combined = '\n'.join((message.get('subject') or '', text, html))
    unchecked = combined.replace(UNSUBSCRIBE, '') if message['transport'].startswith('postmark') else combined
    if re.search(r'\{\{|\}\}|\{%|\*\|[^|]+\|\*', unchecked):
        raise Refused('literal_merge_token')
    if message['purpose'] == 'marketing':
        if message['transport'].startswith('postmark'):
            valid = UNSUBSCRIBE in text and UNSUBSCRIBE in html
        else:
            valid = bool(re.search(r'(?i)unsubscribe.{0,150}(https://\S+|mailto:\S+)', text))
            if html:
                valid = valid and bool(re.search(r'(?is)<a\b[^>]*href=["\'](?:https://|mailto:)[^"\']+["\'][^>]*>[^<]*unsubscribe',html))
        if not valid:
            raise Refused('marketing_requires_unsubscribe')


def catch_all(evidence):
    status = str(evidence.get('status') or '').lower().replace('-', '_')
    sub = str(evidence.get('sub_status') or '').lower().replace('-', '_')
    return status == 'catch_all' or (status in ('valid', 'do_not_mail') and sub in ('catch_all', 'role_based_catch_all'))


def verification_note(evidence):
    """Plain-language caveat shown with a send; None when the address is plainly valid."""
    evidence = evidence if isinstance(evidence, dict) else {'status': evidence}
    if str(evidence.get('override_by') or '').strip() and evidence.get('status') != 'valid' and not catch_all(evidence):
        return 'unverified (%s), sent on %s override' % (evidence.get('status') or 'missing', evidence['override_by'])
    if catch_all(evidence):
        return 'catch-all domain: deliverability cannot be confirmed'
    return None


def recipient(db, email, verification, suppressions=None, campaign=True):
    email = email.strip().lower()
    if email in (suppressions or {}):
        raise Refused('recipient_suppressed', email=email)
    from .suppression import is_suppressed
    address_suppression = is_suppressed(db,email)
    if address_suppression:
        raise Refused('recipient_suppressed',email=email,evidence=address_suppression)
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
    # ZeroBounce's role_based flag is deliberately not an exclusion. Catch-all domains are deliverable but
    # unconfirmable, so they send with a note. A named human may knowingly override anything else.
    # ZeroBounce verification gates campaigns only; one-off and transactional mail skips it (opt-out, bounce and suppression checks above always apply).
    if campaign and evidence.get('status') != 'valid' and not catch_all(evidence) and not str(evidence.get('override_by') or '').strip():
        raise Refused('recipient_unverified', email=email, verification_status=evidence.get('status','missing'), verification_reason=evidence.get('sub_status'))
    return email


def thread_reply(db, message):
    with dict_cursor(db) as cur:
        origin = message.get('personalization',{}).get('followup_source_message_id')
        cur.execute("select thread_id,replied_at,created_at from mail_message where id=any(%s::text[])",([message['id']]+([origin] if origin else []),))
        sources = list(cur.fetchall())
        if any(source['replied_at'] for source in sources):
            return True
        thread_ids = {source['thread_id'] for source in sources if source['thread_id']}
        if message.get('thread_id'):
            thread_ids.add(message['thread_id'])
        cutoff = min([source['created_at'] for source in sources]+[message['created_at']])
        cur.execute("""select 1 from mail_message where thread_id=any(%s::text[]) and direction='inbound'
            and coalesce(sent_at,created_at)>%s limit 1""",(list(thread_ids),cutoff))
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
    normalised = re.sub(r'[_\W]+',' ',name,flags=re.UNICODE)
    if re.search(r'\b(agent|claude|mailvin|hermes|auto|self|chatgpt|assistant)\b',normalised,re.I):
        raise Refused('approval_invalid_approver')
    return name.strip()
