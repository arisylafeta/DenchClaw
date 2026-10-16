"""Idempotent Postmark webhook and reconciliation ingestion."""
import hashlib
import json
from datetime import datetime, timezone
from .core import Refused

TYPES = {'Delivery':'delivered','Delivered':'delivered','Bounce':'bounced','Bounced':'bounced','Open':'opened','Opened':'opened','Click':'clicked','LinkClicked':'clicked','SubscriptionChange':'unsubscribed','Suppressed':'suppressed','Sent':'sent'}
TIMESTAMPS = {'sent':'sent_at','delivered':'delivered_at','bounced':'bounced_at','opened':'opened_at','clicked':'clicked_at','replied':'replied_at'}


def ingest_postmark_event(db, payload, apply=True):
    kind = TYPES.get(payload.get('RecordType') or payload.get('Type'))
    if not kind:
        raise Refused('unsupported_postmark_event', event_type=payload.get('RecordType') or payload.get('Type'))
    # A reactivation never restores consent and is not an unsubscribe event.
    if kind == 'unsubscribed' and payload.get('SuppressSending') is False:
        return {'inserted':False,'ignored':'reactivation'}
    at = next((payload[k] for k in ('DeliveredAt','BouncedAt','ReceivedAt','ChangedAt','OccurredAt','CreatedAt') if payload.get(k)), None)
    if not at:
        raise Refused('postmark_event_missing_timestamp')
    try:
        parsed_at = datetime.fromisoformat(str(at).replace('Z','+00:00'))
        canonical_at = parsed_at.replace(tzinfo=parsed_at.tzinfo or timezone.utc).astimezone(timezone.utc).isoformat()
    except ValueError as exc:
        raise Refused('postmark_event_invalid_timestamp') from exc
    provider_id = payload.get('MessageID')
    email = (payload.get('Recipient') or payload.get('EmailAddress') or '').strip().lower()
    with db.cursor() as cur:
        if provider_id:
            cur.execute('select id from mail_message where provider_message_id=%s',(provider_id,))
        elif kind in ('suppressed','unsubscribed') and email:
            cur.execute('select id from mail_message where lower(recipient_email)=%s or %s=any(to_emails) order by id',(email,email))
        else:
            raise Refused('postmark_event_missing_message_id')
        messages = cur.fetchall()
        inserted = 0
        event_ids = []
        for (message_id,) in messages:
            # Canonical keys unify webhook and outbound-details representations.
            details = payload.get('Details') or {}
            url = payload.get('OriginalLink') or payload.get('Link') or details.get('Link')
            event_identity = [message_id,kind,canonical_at,url]
            event_id = payload.get('provider_event_id') or hashlib.sha256(json.dumps(event_identity,sort_keys=True).encode()).hexdigest()
            if not apply:
                cur.execute("select 1 from mail_event where source='postmark' and provider_event_id=%s",(event_id,))
                if not cur.fetchone():
                    event_ids.append(event_id)
                    inserted += 1
                continue
            cur.execute('''insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values(%s,%s,'postmark',%s,%s,%s::jsonb) on conflict do nothing returning id''',(message_id,kind,event_id,at,json.dumps(payload,default=str)))
            fresh = cur.fetchone()
            if not fresh:
                continue
            inserted += 1
            event_ids.append(event_id)
            if kind in TIMESTAMPS:
                column = TIMESTAMPS[kind]
                cur.execute(f'update mail_message set {column}=least({column},%s::timestamptz),last_synced_at=now(),updated_at=now() where id=%s',(at,message_id))
            if kind=='clicked' and url:
                cur.execute('update mail_message_link set first_clicked_at=least(first_clicked_at,%s::timestamptz) where message_id=%s and destination_url=%s',(at,message_id,url))
        if apply and kind in ('suppressed','unsubscribed','bounced') and email:
            reason = payload.get('SuppressionReason') or payload.get('Type') or 'ManualSuppression'
            # Soft bounces are evidence, not permanent suppressions.
            suppress = kind in ('suppressed','unsubscribed') or payload.get('Inactive') is True or reason in ('HardBounce','SpamComplaint')
            if suppress:
                from .suppression import record_suppression
                record_suppression(db,email,reason,'postmark',payload.get('MessageStream'),canonical_at,payload)
                how = 'Postmark stream={}; reason={}; origin={}'.format(payload.get('MessageStream',''),reason,payload.get('Origin',''))
                cur.execute('''insert into crm_subscriptions(person_id,list,status,since,how) select id,'Supply update','Opted out',%s::timestamptz::date,%s from crm_people where lower(trim(email))=%s on conflict(person_id,list) do update set status='Opted out',since=excluded.since,how=excluded.how where (crm_subscriptions.status,crm_subscriptions.since,crm_subscriptions.how) is distinct from (excluded.status,excluded.since,excluded.how)''',(at,how,email))
                if reason in ('HardBounce','SpamComplaint'):
                    cur.execute('update crm_people set email_opted_out=true where lower(trim(email))=%s and not coalesce(email_opted_out,false)',(email,))
    return {'inserted':bool(inserted),'event_count':inserted,'provider_message_id':provider_id,'event_ids':event_ids}
