"""Shared local-only WhatsApp context query contract.

All functions take an open psycopg2 connection and return JSON-compatible dicts.
threads_for_person(db, person_id, limit=50, offset=0) and
threads_for_company(db, company_id, limit=50, offset=0) return {threads,limit,offset}.
Threads include whole groups when an observed member has an active identity link;
company context includes direct company links and people whose company_id matches.
This is shared context, not attribution of every group message to that person.
thread_messages(db, thread_id, limit=50, offset=0) returns {messages,limit,offset},
ordered oldest first by occurred_at then id, including tombstones and unresolved
reply_to_provider_id. Reads never contact WhatsApp or load capture credentials.
Active links are resolved at query time, so revocation immediately removes wrong
person context, including historical messages, without rewriting source records.
Limits are 1..200; offsets are non-negative. IDs are canonical database text IDs.
"""
from .core import Refused, cursor


def pagination(limit=50, offset=0):
    limit, offset = int(limit), int(offset)
    if not 1 <= limit <= 200 or offset < 0:
        raise Refused('invalid_pagination')
    return limit, offset


def context_threads(db, person_id=None, company_id=None, limit=50, offset=0):
    limit, offset = pagination(limit, offset)
    with cursor(db) as cur:
        cur.execute('''select t.*, (t.kind='group') as shared_context,
          (select count(*) from whatsapp_message m where m.thread_id=t.id) as message_count
          from whatsapp_thread t where exists (
            select 1 from whatsapp_identity_link l left join crm_people p on p.id=l.person_id
            where l.account_id=t.account_id and l.valid_to is null
            and ((%s is not null and l.person_id=%s) or (%s is not null and (l.company_id=%s or p.company_id=%s)))
            and (l.identity_id=t.identity_id or exists(select 1 from whatsapp_thread_member tm
              where tm.thread_id=t.id and tm.identity_id=l.identity_id)))
          order by t.last_captured_at desc,t.id limit %s offset %s''',
          (person_id, person_id, company_id, company_id, company_id, limit, offset))
        return {'threads': [dict(row) for row in cur.fetchall()], 'limit': limit, 'offset': offset}


def threads_for_person(db, person_id, limit=50, offset=0):
    return context_threads(db, person_id=person_id, limit=limit, offset=offset)


def threads_for_company(db, company_id, limit=50, offset=0):
    return context_threads(db, company_id=company_id, limit=limit, offset=offset)


def thread_messages(db, thread_id, limit=50, offset=0):
    limit, offset = pagination(limit, offset)
    with cursor(db) as cur:
        cur.execute('''select m.*,i.display_name as sender_name,i.canonical_jid as sender_jid,
          case when m.deleted_at is not null then null when (m.metadata->'flags'->>'viewOnce')::boolean is true then null
            when nullif(m.metadata->'flags'->>'expiresAt','')::timestamptz <= now() then null else m.body end as body,
          case when m.deleted_at is not null or (m.metadata->'flags'->>'viewOnce')::boolean is true
            or nullif(m.metadata->'flags'->>'expiresAt','')::timestamptz <= now() then null else m.attachment end as attachment
          from whatsapp_message m left join whatsapp_identity i on i.id=m.sender_identity_id
          where m.thread_id=%s order by m.occurred_at,m.id limit %s offset %s''', (thread_id, limit, offset))
        return {'messages': [dict(row) for row in cur.fetchall()], 'limit': limit, 'offset': offset}


def status(db):
    with cursor(db) as cur:
        result = {}
        for name in ('account', 'identity', 'thread', 'message', 'event'):
            cur.execute('select count(*) as count from whatsapp_' + name)
            result[name + 's'] = cur.fetchone()['count']
        cur.execute('select count(*) as count from whatsapp_event where kind=\'quarantine\'')
        result['quarantined'] = cur.fetchone()['count']
        cur.execute('select updated_at,byte_offset,record_count,quarantine_count from whatsapp_ingest_cursor order by updated_at')
        result['cursors'] = [dict(row) for row in cur.fetchall()]
        cur.execute("select metadata->'capture_status' as health from whatsapp_account order by created_at")
        result['capture_health'] = [row['health'] for row in cur.fetchall()]
        result['history_complete'] = False
        return result
