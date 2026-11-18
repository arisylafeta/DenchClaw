"""Bounded local PostgreSQL readers. No capture credentials or provider access."""
import mimetypes
import re
from datetime import datetime, timezone
from pathlib import Path
from . import media_store, read
from .core import ProviderError, Refused, cursor, instant

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


def register_attachment_command(commands):
    sub = commands.add_parser('attachment').add_subparsers(dest='action', required=True)
    get = sub.add_parser('get')
    get.add_argument('id', help='message id (canonical, or the provider message id when unambiguous)')
    get.add_argument('--out', required=True, help='existing or new directory to write the file into')


def safe_name(name, fallback):
    name = re.sub(r'[^A-Za-z0-9._ -]', '_', Path(name or '').name).strip(' .')
    return name[:120] or fallback


def attachment_get(db, args, store=media_store):
    """Fetch the decrypted file stored for a message. Never contacts WhatsApp."""
    with cursor(db) as cur:
        cur.execute('''select m.id,m.provider_message_id,m.deleted_at,m.attachment,m.metadata from whatsapp_message m
          where m.id=%s or m.provider_message_id=%s limit 2''', (args.id, args.id))
        rows = cur.fetchall()
    if not rows:
        raise Refused('message_not_found')
    if len(rows) > 1:
        raise Refused('message_ambiguous', 'Use the canonical message id')
    row = rows[0]
    flags = (row['metadata'] or {}).get('flags') or {}
    expires = flags.get('expiresAt')
    if (row['deleted_at'] or flags.get('viewOnce') or (row['metadata'] or {}).get('content_redacted')
            or (expires and instant(expires) <= datetime.now(timezone.utc))):
        raise Refused('attachment_unavailable', 'Message was deleted, expired, redacted or view-once')
    attachment = row['attachment'] or {}
    if not attachment:
        raise Refused('no_attachment')
    if attachment.get('download_status') != 'stored' or not attachment.get('ref'):
        raise Refused('attachment_not_stored', attachment.get('download_status') or 'not downloaded')
    out = Path(args.out).expanduser()
    out.mkdir(parents=True, exist_ok=True)
    name = safe_name(attachment.get('filename'), f"{row['provider_message_id']}{mimetypes.guess_extension((attachment.get('mime') or '').split(';')[0]) or ''}")
    for counter in range(100):
        target = out / (name if not counter else f'{Path(name).stem}-{counter}{Path(name).suffix}')
        try:
            result = store.get(attachment['ref'], str(target), attachment.get('sha256'))
            break
        except media_store.StoreError as exc:
            if exc.code == 'output_exists':
                continue
            raise ProviderError('attachment_download_failed', exc.code) from exc
    else:
        raise ProviderError('attachment_download_failed', 'output_exists')
    return {'path': result['path'], 'size': result['size'], 'sha256': result['sha256'], 'mime': attachment.get('mime'),
            'type': attachment.get('type'), 'source_ref': f"whatsapp:message:{row['id']}"}


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
