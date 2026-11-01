"""Read-only queries over the authoritative mail log."""
import json
from .core import connection, dict_cursor, Refused, UsageError, PURPOSES, TRANSPORTS

COUNTS = ('sent', 'delivered', 'bounced', 'opened', 'clicked', 'unsubscribed', 'replied')


def filename_pattern(text):
    """ILIKE pattern: plain text is a substring match, * and ? make it a glob."""
    escaped = text.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')
    if '*' in text or '?' in text:
        return escaped.replace('*', '%').replace('?', '_')
    return '%' + escaped + '%'


def query(db, sql, params=()):
    with dict_cursor(db) as cur:
        cur.execute(sql, params)
        return [dict(r) for r in cur.fetchall()]


def search(db, **filters):
    clauses, params = [], []
    for key, column in (('identity', 'identity_key'), ('campaign', 'campaign_id'), ('thread', 'thread_id'), ('direction', 'direction'), ('transport', 'transport'), ('purpose', 'purpose'), ('state', 'state'), ('from', 'from_email')):
        if filters.get(key):
            clauses.append(f'm.{column}=%s')
            params.append(filters[key])
    if filters.get('to'):
        clauses.append('(%s=any(m.to_emails) or %s=any(m.cc_emails) or %s=any(m.bcc_emails) or m.recipient_email=%s)')
        params.extend([filters['to']] * 4)
    if filters.get('q'):
        clauses.append("to_tsvector('english', coalesce(m.subject,'') || ' ' || coalesce(m.body_text,m.body_preview,'')) @@ websearch_to_tsquery('english',%s)")
        params.append(filters['q'])
    for key, operator in (('since', '>='), ('until', '<=')):
        if filters.get(key):
            clauses.append(f'm.sent_at {operator} %s::timestamptz')
            params.append(filters[key])
    if filters.get('has_attachment'):
        clauses.append('m.has_attachments')
    if filters.get('filename'):
        clauses.append("exists(select 1 from jsonb_array_elements(case when jsonb_typeof(m.personalization->'attachments')='array' then m.personalization->'attachments' else '[]'::jsonb end) a where a->>'filename' ilike %s)")
        params.append(filename_pattern(filters['filename']))
    if filters.get('crm_only'):
        clauses.append('m.crm_visible')
    if filters.get('event'):
        event = filters['event']
        if event not in ('opened','clicked','replied','bounced'):
            raise UsageError('invalid_event', event=event)
        clauses.append(f'(exists(select 1 from mail_event e where e.message_id=m.id and e.type=%s) or m.{event}_at is not null)')
        params.append(event)
    limit = filters.get('limit', 100)
    if not 1 <= limit <= 1000:
        raise UsageError('invalid_limit', minimum=1, maximum=1000)
    params.append(limit)
    return {'messages': query(db, 'select m.* from mail_message m' + (' where ' + ' and '.join(clauses) if clauses else '') + ' order by m.sent_at desc nulls last, m.id limit %s', params)}


def message(db, id):
    rows = query(db, 'select * from mail_message where id=%s', (id,))
    if not rows:
        raise Refused('message_not_found', message_id=id)
    from .attachment import live_attachments
    rows[0]['attachments'] = live_attachments(db, rows[0])
    return {'message': rows[0], 'events': query(db, 'select * from mail_event where message_id=%s order by occurred_at,id', (id,)), 'links': query(db, 'select * from mail_message_link where message_id=%s order by cta_key,id', (id,))}


def thread(db, id):
    rows = query(db, 'select * from mail_thread where id=%s', (id,))
    if not rows:
        raise Refused('thread_not_found', thread_id=id)
    from .attachment import live_attachments
    messages = query(db, 'select * from mail_message where thread_id=%s order by sent_at desc nulls last,id', (id,))
    for row in messages:
        row['attachments'] = live_attachments(db, row)
    return {'thread': rows[0], 'messages': messages, 'events': query(db, 'select e.* from mail_event e join mail_message m on m.id=e.message_id where m.thread_id=%s order by e.occurred_at,e.id', (id,))}


def person(db, id):
    people = query(db, 'select * from crm_people where id=%s or lower(trim(email))=lower(trim(%s)) order by id', (id,id))
    ids = [r['id'] for r in people]
    emails = sorted({r['email'].strip().lower() for r in people if r['email']} | ({id.lower()} if '@' in id else set()))
    return {'people': people, 'messages': query(db, '''select distinct m.* from mail_message m where m.person_id=any(%s) or m.from_person_id=any(%s) or m.from_email=any(%s) or m.recipient_email=any(%s) or m.to_emails && %s::text[] or m.cc_emails && %s::text[] or exists(select 1 from mail_message_recipient r where r.message_id=m.id and r.person_id=any(%s)) order by m.sent_at desc nulls last,m.id''', (ids,ids,emails,emails,emails,emails,ids)), 'followups': query(db, "select * from mail_followup where person_id=any(%s) and state in ('pending','drafted','paused') order by due_at,id", (ids,))}


def status(db, id):
    rows = query(db, 'select * from mail_message where id=%s or campaign_id=%s order by id', (id,id))
    if not rows and not query(db, 'select id from campaigns where id=%s', (id,)):
        raise Refused('status_not_found', subject_id=id)
    events = query(db, 'select * from mail_event where message_id=any(%s) order by occurred_at,id', ([r['id'] for r in rows],))
    by_message = {}
    for event in events:
        by_message.setdefault(event['message_id'], []).append(event)
    counts = dict.fromkeys(COUNTS, 0)
    evidence = {'clicks_soon_after_delivery': [], 'all_links_in_short_window': [], 'google_image_proxy': []}
    for row in rows:
        observed = by_message.get(row['id'], [])
        kinds = {e['type'] for e in observed}
        for kind in COUNTS:
            fallback = row.get(kind + '_at')
            if kind == 'sent':
                fallback = row['direction'] == 'outbound' and (row.get('accepted_at') or (row['state'] == 'accepted' and row.get('sent_at')))
            counts[kind] += int(kind in kinds or bool(fallback))
        delivery = min([e['occurred_at'] for e in observed if e['type']=='delivered'] + ([row['delivered_at']] if row['delivered_at'] else []), default=None)
        clicks = [e for e in observed if e['type']=='clicked']
        if delivery and any(0 <= (e['occurred_at']-delivery).total_seconds() <= 5 for e in clicks):
            evidence['clicks_soon_after_delivery'].append(row['id'])
        links = query(db, 'select destination_url from mail_message_link where message_id=%s', (row['id'],))
        urls = {r['destination_url'] for r in links}
        timed_urls = [(e['occurred_at'], e['detail'].get('OriginalLink') or e['detail'].get('Link') or e['detail'].get('Details',{}).get('Link')) for e in clicks]
        if len(urls)>1 and any(urls <= {url for at,url in timed_urls if 0 <= (at-start).total_seconds() <= 5} for start,_ in timed_urls):
            evidence['all_links_in_short_window'].append(row['id'])
        if any('googleimageproxy' in json.dumps(e['detail']).lower() or 'ggpht.com' in json.dumps(e['detail']).lower() for e in observed):
            evidence['google_image_proxy'].append(row['id'])
    return {'subject_id': id, 'message_count': len(rows), 'counts': counts, 'evidence': evidence}


def handle(args):
    with connection(read_only=True) as db:
        if args.command == 'search':
            return search(db, **{k:v for k,v in vars(args).items() if k not in ('handler','command')})
        return globals()[args.command](db, args.id)


def register(subparsers):
    parser = subparsers.add_parser('search')
    for name in ('q','from','to','identity','campaign','thread','state','since','until'):
        parser.add_argument('--'+name)
    parser.add_argument('--direction', choices=('inbound','outbound'))
    parser.add_argument('--transport', choices=TRANSPORTS)
    parser.add_argument('--purpose', choices=PURPOSES)
    parser.add_argument('--event', choices=('opened','clicked','replied','bounced'))
    parser.add_argument('--crm-only', action='store_true')
    parser.add_argument('--has-attachment', action='store_true')
    parser.add_argument('--filename', help='Attachment filename filter (substring, or glob with * and ?); needs stored metadata, see attachment backfill')
    parser.add_argument('--limit', type=int, default=100)
    parser.set_defaults(handler=handle)
    for name in ('thread','message','person','status'):
        parser = subparsers.add_parser(name)
        parser.add_argument('id')
        parser.set_defaults(handler=handle)
