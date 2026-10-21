"""Screen retained inbound source text into human-review cards, never business rows."""
from urllib.parse import quote
from .core import cursor, Refused
from .read import pagination


def register_screen_command(commands):
    sub = commands.add_parser('screen')
    sub.add_argument('--apply', action='store_true')
    sub.add_argument('--limit', type=int, default=25)


def screen(db, apply=False, limit=25, model=None):
    # Reuse the production model helper and exact-quote validation. Tests inject a model.
    import bulk_trade_inbox_check as inbox
    limit, _ = pagination(limit, 0)
    key = 'injected-test-model' if model else inbox.gateway_key()
    if not key:
        raise Refused('model_key_missing')
    report = {'warnings': [], 'model_calls': 0, 'apply': apply, 'proposals': 0}
    with cursor(db) as cur:
        cur.execute("select pg_advisory_xact_lock(hashtext('whatsapp_screen'))")
        cur.execute('''select m.*,whatsapp_source_version(m) as version,l.person_id,l.company_id,p.email,p.full_name as trusted_contact,
          coalesce(c.name,p.full_name,'Mapped buyer') as trusted_name
          from whatsapp_message m
          join lateral (select person_id,company_id from whatsapp_identity_link
            where identity_id=m.sender_identity_id and valid_to is null and confidence in ('confirmed','high')
            and (person_id is null or not exists(select 1 from whatsapp_identity i where i.id=m.sender_identity_id and i.shared))
            and (select count(*) from whatsapp_identity_link x where x.identity_id=m.sender_identity_id and x.valid_to is null)=1
            limit 1) l on true
          left join crm_people p on p.id=l.person_id left join crm_companies c on c.id=coalesce(l.company_id,p.company_id)
          where m.direction='inbound' and m.body is not null and m.deleted_at is null
          and coalesce(m.metadata->>'content_redacted','false')<>'true'
          and coalesce((m.metadata->'flags'->>'viewOnce')::boolean,false)=false
          and (nullif(m.metadata->'flags'->>'expiresAt','')::timestamptz is null
            or (m.metadata->'flags'->>'expiresAt')::timestamptz > now())
          and not exists(select 1 from whatsapp_screen_checkpoint s where s.message_id=m.id
            and s.source_version=whatsapp_source_version(m))
          order by m.occurred_at,m.id limit %s for update of m''', (limit,))
        rows = list(cur.fetchall())
        sources = []
        for row in rows:
            sources.append({'kind': 'whatsapp', 'id': row['id'], 'thread': row['thread_id'],
                'key': 'whatsapp:' + row['thread_id'], 'url': '/?crm=inbox&view=whatsapp&thread=' + quote(row['thread_id'], safe='') + '#message-' + quote(row['id'], safe=''),
                'label': 'WhatsApp captured message', 'at': row['occurred_at'], 'text': row['body'],
                'inbound': True, 'from': None, 'participants': set(), 'version': row['version'],
                'trusted_name': row['trusted_name'], 'trusted_contact': row['trusted_contact'], 'trusted_identity': {'person_id': row['person_id'],
                    'company_id': row['company_id'], 'email': row['email']}})
        cards = inbox.screen_demand(cur, sources, key, report, model=model)
        if report['warnings']:
            raise Refused('screening_failed')
        if apply:
            cur.execute("insert into crm_bulk_trade_check_runs(kind,status) values('check','running') returning id")
            run_id = cur.fetchone()['id']
            for card in cards:
                if card['kind'] not in ('possible_demand', 'needs_triage'):
                    continue
                if inbox.insert_proposal(cur, run_id, card.get('lot_id'), card, status='new'):
                    report['proposals'] += 1
            for row in rows:
                cur.execute('''insert into whatsapp_screen_checkpoint(message_id,source_version) values(%s,%s)
                  on conflict(message_id) do update set source_version=excluded.source_version,screened_at=now()''',
                  (row['id'], row['version']))
            cur.execute("update crm_bulk_trade_check_runs set status='ok',finished_at=now(),proposals_made=%s where id=%s",
                        (report['proposals'], run_id))
        else:
            report['proposals'] = len(cards)
            db.rollback()
        report['screened'] = len(rows)
    return report
