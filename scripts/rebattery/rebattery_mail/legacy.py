"""Transactional, reconciled historical import. Dry runs execute then roll back.

Reruns refresh changed source fields without regressing message state or provider
evidence. Loaded campaigns with a receipt become launched; others stay legacy.
The cutover repeats these complete projections under exclusive source locks.
"""
from .core import Refused, connection


# Each projection is also the reconciliation contract, not just an insert recipe.
SOURCES = (
    ("crm_email_threads", "mail_thread", "id", """
      select id, subject, gmail_thread_id, mailbox_owner_id, last_message_at,
             coalesce(message_count,0) as message_count, true as crm_visible, created_at, updated_at
      from crm_email_threads"""),
    ("crm_campaign_sends", "mail_message", "id", """
      select s.id, 'outbound'::text as direction, 'postmark-broadcast'::text as transport,
        'marketing'::text as purpose,
        identity.key as identity_key,
        coalesce(identity.address, case when sender.address like '%@%' then sender.address end) as from_email,
        s.campaign_id, s.person_id, s.company_id, s.listing_id, s.auction_url,
        s.recipient_email, array[s.recipient_email] as to_emails,
        s.provider_message_id, s.state, s.claimed_at, s.accepted_at,
        s.accepted_at as sent_at, s.delivered_at, s.bounced_at,
        s.provider_opened_at as opened_at, s.provider_link_clicked_at as clicked_at,
        s.last_synced_at, s.personalization, s.rendered_subject as subject,
        s.rendered_html as body_html, s.rendered_text as body_text,
        false as crm_visible, s.created_at, s.created_at as updated_at
      from crm_campaign_sends s join campaigns c on c.id=s.campaign_id
      cross join lateral (select lower(btrim(coalesce(
        substring(c.sender_identity from '<([^<>]+)>'),c.sender_identity))) as address) sender
      left join lateral (select i.key,i.address from mail_identity i
        where lower(i.key)=lower(btrim(c.sender_identity)) or lower(i.address)=sender.address
        order by i.key limit 1) identity on true"""),
    ("crm_email_messages", "mail_message", "id", """
      select m.id, m.thread_id, m.subject, m.sent_at, m.from_person_id,
        m.from_email, m.body_preview, m.body as body_text, coalesce(m.has_attachments,false) as has_attachments,
        m.gmail_message_id, m.mailbox_owner_id, m.created_at, m.updated_at,
        'gmail'::text as transport, 'personal'::text as purpose,
        case when own.is_own then 'outbound' else 'inbound' end as direction,
        case when own.is_own then 'accepted' else 'received' end as state,
        case when own.is_own then m.sent_at end as accepted_at,
        (select i.key from mail_identity i where lower(i.address)=lower(m.from_email)
          order by i.key limit 1) as identity_key,
        coalesce((select array_agg(p.email order by r.position, p.id)
          from crm_email_message_recipients r join crm_people p on p.id=r.person_id
          where r.message_id=m.id and r.recipient_type='to' and p.email is not null), '{}') as to_emails,
        coalesce((select array_agg(p.email order by r.position, p.id)
          from crm_email_message_recipients r join crm_people p on p.id=r.person_id
          where r.message_id=m.id and r.recipient_type='cc' and p.email is not null), '{}') as cc_emails,
        true as crm_visible, 'legacy'::text as crm_visible_reason
      from crm_email_messages m left join crm_users u on u.id=m.mailbox_owner_id
      cross join lateral (select coalesce(lower(m.from_email)=lower(u.email),false)
        or exists(select 1 from mail_identity i where lower(i.address)=lower(m.from_email)
          or lower(i.gmail_account)=lower(m.from_email)) as is_own) own"""),
    ("crm_campaign_send_links", "mail_message_link", "id", """
      select id, send_id as message_id, cta_key, destination_url, listing_id,
             first_clicked_at from crm_campaign_send_links"""),
    ("crm_email_thread_participants", "mail_thread_participant", "thread_id, person_id", """
      select thread_id, person_id, position, created_at from crm_email_thread_participants"""),
    ("crm_email_message_recipients", "mail_message_recipient", "message_id, person_id, recipient_type", """
      select message_id, person_id, recipient_type, position, created_at from crm_email_message_recipients"""),
)

EVENTS = """
 select s.id as message_id, e.type, 'postmark'::text as source,
   'legacy:' || s.id || ':' || e.type as provider_event_id, e.at as occurred_at
 from crm_campaign_sends s cross join lateral (values
   ('sent',s.accepted_at), ('delivered',s.delivered_at), ('bounced',s.bounced_at),
   ('opened',s.provider_opened_at), ('clicked',s.provider_link_clicked_at)
 ) e(type,at) where e.at is not null
"""


def import_legacy(args):
    db = connection()
    try:
        with db.cursor() as cur:
            cur.execute("set transaction isolation level repeatable read")
            cur.execute("select to_regclass('crm_campaign_sends')")
            if cur.fetchone()[0] is None:
                raise Refused("legacy_tables_missing", "Legacy cutover has already removed the source tables")
            # Stop concurrent changes to the source while counting, loading and reconciling.
            cur.execute("lock table " + ', '.join(source for source, *_ in SOURCES) + " in share mode")
            counts = {}
            for source, target, key, projection in SOURCES:
                cur.execute("select * from (" + projection + ") expected limit 0")
                names = [col.name for col in cur.description]
                columns = ', '.join('"' + name + '"' for name in names)
                cur.execute(f"select count(*) from {source}")
                source_count = cur.fetchone()[0]
                keys = key.split(', ')
                changed = [name for name in names if name not in keys]
                assignments = ', '.join(f'"{name}"=excluded."{name}"' for name in changed)
                current = ', '.join(f't."{name}"' for name in changed)
                incoming = ', '.join(f'excluded."{name}"' for name in changed)
                guard = ''
                if target == 'mail_message':
                    # A newer log receipt is never erased by an older source snapshot.
                    states = "array['draft','frozen','approved','sending','unknown','failed','accepted','received']"
                    guard = f" and array_position({states},t.state)<=array_position({states},excluded.state)"
                    for name in ('claimed_at','accepted_at','delivered_at','bounced_at','opened_at','clicked_at','last_synced_at'):
                        if name in names:
                            guard += f' and (t."{name}" is null or excluded."{name}">=t."{name}")'
                    if 'provider_message_id' in names:
                        guard += ' and (t.provider_message_id is null or t.provider_message_id=excluded.provider_message_id)'
                cur.execute(f"""insert into {target} as t ({columns}) {projection}
                    on conflict ({key}) do update set {assignments}
                    where row({current}) is distinct from row({incoming}) {guard}
                    returning (xmax=0) as inserted""")
                changes = cur.fetchall()
                inserted = sum(row[0] for row in changes)
                updated = len(changes)-inserted
                match = ' and '.join(f't."{k}"=e."{k}"' for k in keys)
                cur.execute(f"select count(*) from ({projection}) e join {target} t on {match}")
                loaded = cur.fetchone()[0]
                cur.execute(f"select count(*) from (({projection}) except select {columns} from {target}) differences")
                mismatches = cur.fetchone()[0]
                counts[source] = dict(source=source_count, loaded=loaded, inserted=inserted, updated=updated,
                                      orphans=source_count-loaded, mismatches=mismatches)
            cur.execute("insert into mail_event (message_id,type,source,provider_event_id,occurred_at) " + EVENTS + """
                on conflict (source,provider_event_id) where provider_event_id is not null
                do update set message_id=excluded.message_id,type=excluded.type,occurred_at=excluded.occurred_at
                where (mail_event.message_id,mail_event.type,mail_event.occurred_at) is distinct from
                  (excluded.message_id,excluded.type,excluded.occurred_at)
                returning (xmax=0) as inserted""")
            events_inserted = sum(row[0] for row in cur.fetchall())
            cur.execute("select count(*) from (" + EVENTS + ") e where not exists (select 1 from mail_event t where t.source=e.source and t.provider_event_id=e.provider_event_id and t.message_id=e.message_id and t.type=e.type and t.occurred_at=e.occurred_at)")
            event_mismatches = cur.fetchone()[0]
            cur.execute("""update campaigns c set mail_state=case when exists
                (select 1 from crm_campaign_sends s where s.campaign_id=c.id and s.accepted_at is not null)
                then 'launched' else 'legacy' end
                where exists(select 1 from crm_campaign_sends s where s.campaign_id=c.id)""")
            result = {"applied": bool(args.apply), "counts": counts,
                      "events_inserted": events_inserted, "event_mismatches": event_mismatches,
                      "reconciled": not event_mismatches and all(not r['orphans'] and not r['mismatches'] for r in counts.values())}
            if not result['reconciled']:
                raise Refused("legacy_reconciliation_failed", **result)
        if args.apply:
            db.commit()
        else:
            db.rollback()
        return result
    finally:
        db.rollback()
        db.close()


def register(subparsers):
    legacy = subparsers.add_parser('legacy', help='Reconcile and import the historical mail tables')
    commands = legacy.add_subparsers(dest='legacy_command', required=True)
    command = commands.add_parser('import')
    command.add_argument('--apply', action='store_true')
    command.set_defaults(handler=import_legacy)
