"""Bounded local PostgreSQL readers. No capture credentials or provider access."""
from datetime import datetime
from . import read
from .core import cursor

COMMANDS = {'search', 'message', 'thread', 'person', 'company', 'trade'}


def register_read_commands(commands):
    for name in sorted(COMMANDS):
        sub = commands.add_parser(name)
        if name != 'search':
            sub.add_argument('id')
        else:
            sub.add_argument('--q', default='')
        sub.add_argument('--limit', type=int, default=50)
        sub.add_argument('--offset', type=int, default=0)
        sub.add_argument('--since')
        sub.add_argument('--until')
        sub.add_argument('--direction', choices=('inbound', 'outbound'))


def source_ref(row, kind):
    row = dict(row)
    row['source_ref'] = f"whatsapp:{kind}:{row['id']}"
    if kind == 'message':
        row['thread_ref'] = f"whatsapp:thread:{row['thread_id']}"
    return row


def message_rows(db, args, extra='true', values=()):
    limit, offset = read.pagination(args.limit, args.offset)
    clauses, params = [extra], list(values)
    for flag, op in (('since', '>='), ('until', '<')):
        value = getattr(args, flag, None)
        if value:
            datetime.fromisoformat(value.replace('Z', '+00:00'))
            clauses.append(f'm.occurred_at {op} %s::timestamptz')
            params.append(value)
    if args.direction:
        clauses.append('m.direction=%s')
        params.append(args.direction)
    with cursor(db) as cur:
        cur.execute('''select m.id,m.thread_id,m.account_id,m.provider_message_id,m.direction,m.occurred_at,
          m.captured_at,m.timestamp_source,m.reply_to_message_id,m.reply_to_provider_id,m.edit_version,m.deleted_at,
          m.attachment,m.metadata,
          case when m.deleted_at is not null or (m.metadata->'flags'->>'viewOnce')::boolean is true
            or m.metadata->>'content_redacted'='true'
            or nullif(m.metadata->'flags'->>'expiresAt','')::timestamptz <= now() then null else m.body end as body,
          i.display_name as sender_name,
          coalesce((select jsonb_agg(jsonb_build_object('person_id',l.person_id,'company_id',l.company_id,
            'confidence',l.confidence,'method',l.method)) from whatsapp_identity_link l
            where l.identity_id=m.sender_identity_id and l.valid_to is null),'[]'::jsonb) as identity_links,
          (t.kind='group') as shared_context
          from whatsapp_message m join whatsapp_thread t on t.id=m.thread_id
          left join whatsapp_identity i on i.id=m.sender_identity_id where ''' + ' and '.join(clauses) +
          ' order by m.occurred_at,m.id limit %s offset %s', (*params, limit, offset))
        return {'messages': [source_ref(r, 'message') for r in cur.fetchall()], 'limit': limit, 'offset': offset}


def thread_details(db, ids):
    with cursor(db) as cur:
        cur.execute('''select t.*,(t.kind='group') as shared_context,
          coalesce((select jsonb_agg(jsonb_build_object('identity_id',l.identity_id,'person_id',l.person_id,
            'company_id',l.company_id,'confidence',l.confidence,'method',l.method))
            from whatsapp_identity_link l where l.valid_to is null and (l.identity_id=t.identity_id
              or exists(select 1 from whatsapp_thread_member tm where tm.thread_id=t.id and tm.identity_id=l.identity_id))),
            '[]'::jsonb) as identity_links from whatsapp_thread t where t.id=any(%s)''', (ids,))
        return {row['id']: source_ref(row, 'thread') for row in cur.fetchall()}


def dispatch_read_command(args, db):
    read.pagination(args.limit, args.offset)
    if args.command in ('person', 'company'):
        fn = read.threads_for_person if args.command == 'person' else read.threads_for_company
        result = fn(db, args.id, args.limit, args.offset)
        details = thread_details(db, [r['id'] for r in result['threads']])
        result['threads'] = [{**dict(r), **details[r['id']]} for r in result['threads']]
        if args.since or args.until or args.direction:
            result['messages'] = message_rows(db, args, 'm.thread_id=any(%s)',
                ([r['id'] for r in result['threads']],))['messages']
        return result
    if args.command == 'thread':
        details = thread_details(db, [args.id]).get(args.id)
        if args.since or args.until or args.direction:
            result = message_rows(db, args, 'm.thread_id=%s', (args.id,))
        else:
            result = read.thread_messages(db, args.id, args.limit, args.offset)
            for row in result['messages']:
                row['identity_links'] = [link for link in (details or {}).get('identity_links', [])
                                         if link['identity_id'] == row['sender_identity_id']]
                row['shared_context'] = bool(details and details['shared_context'])
                if row['metadata'].get('content_redacted'):
                    row['body'] = None
            result['messages'] = [source_ref(row, 'message') for row in result['messages']]
        result['thread'] = details
        return result
    if args.command == 'message':
        return message_rows(db, args, 'm.id=%s', (args.id,))
    if args.command == 'trade':
        return message_rows(db, args, '''(exists(select 1 from crm_bulk_thread_links e
          where e.bulk_listing_id=%s and e.channel='whatsapp' and e.thread_id=m.thread_id and e.state<>'rejected')
          or exists(select 1 from crm_bulk_listing_activity a where a.bulk_listing_id=%s
          and a.data->>'whatsapp_message_id'=m.id))''', (args.id, args.id))
    # Search only retained readable text, never deleted/expired/view-once copies.
    return message_rows(db, args, '''m.body ilike %s and m.deleted_at is null
      and coalesce(m.metadata->>'content_redacted','false')<>'true'
      and coalesce((m.metadata->'flags'->>'viewOnce')::boolean,false)=false
      and (nullif(m.metadata->'flags'->>'expiresAt','')::timestamptz is null
        or (m.metadata->'flags'->>'expiresAt')::timestamptz > now())''', ('%' + args.q + '%',))
