"""Wide mailbox capture with the original narrow CRM side effects."""
import hashlib
import json
import re
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from .core import Refused, dict_cursor
from .gmail_driver import GmailDriver
from .gmail_body import extract_bodies
from .attachment import describe
from .crm_visibility import normalize_email, parse_email_addresses, ensure_person, visibility, is_common_email_provider, reply_matches


def stable_id(prefix, value):
    return prefix + hashlib.sha256(value.encode()).hexdigest()[:32]


def sync_gmail(db, account, since=None, apply=False, driver=None, thread_id=None, skip_known=False):
    driver = driver or GmailDriver()
    stats = dict(found=0, fetched=0, imported=0, linked=0, crm_visible=0, auto_created=0, drafts_skipped=0, replies=0, html_missing=0)
    with db.cursor() as cur:
        cur.execute('select id from crm_users where lower(email)=lower(%s) and is_active', (account,))
        owners = cur.fetchall()
        if len(owners) != 1:
            raise Refused('mailbox_owner_not_unique', account=account)
        owner_id = owners[0][0]
        cur.execute('select key,lower(address),lower(gmail_account) from mail_identity')
        identities = cur.fetchall()
        own_addresses = {normalize_email(r[1]) for r in identities} | {normalize_email(account)}
        cur.execute("select id,lower(email),company_id from crm_people where coalesce(email,'')<>''")
        rows = cur.fetchall()
        people = {r[1]:r[0] for r in rows}
        companies = {r[0]:r[2] for r in rows}
        cur.execute("select lower(domain),min(id) from crm_companies where coalesce(domain,'')<>'' group by lower(domain) having count(*)=1")
        domains = {r[0]:r[1] for r in cur.fetchall() if not is_common_email_provider(r[0])}
    query = 'in:anywhere -label:DRAFT'
    if since:
        query += ' after:' + str(since)
    hits = {r['id']:r for r in driver.search(account, query) if r.get('id')}
    labelled_ids = {r['id'] for r in driver.search(account, '(label:CRM) -label:DRAFT' + (' after:'+str(since) if since else '')) if r.get('id')}
    triaged_ids = {r['id'] for r in driver.search(account, '(label:Deal OR label:Inbound) -label:DRAFT' + (' after:'+str(since) if since else '')) if r.get('id')}
    stats['found'] = len(hits)
    prepared = []
    known = set()
    if skip_known:
        # Pre-send reply rechecks only need mail that is not in the log yet; re-fetching every message
        # of the day made a send preflight take minutes.
        with db.cursor() as cur:
            cur.execute('select gmail_message_id from mail_message where mailbox_owner_id=%s and gmail_message_id is not null',(owner_id,))
            known = {r[0] for r in cur.fetchall()}
    for gmail_id in sorted(hits):
        if gmail_id in known:
            continue
        full = driver.fetch(account,gmail_id)
        stats['fetched'] += 1
        raw = full.get('message',{})
        if thread_id and raw.get('threadId') != thread_id:
            continue
        labels = raw.get('labelIds',[])
        if any(str(label).upper()=='DRAFT' for label in labels):
            stats['drafts_skipped'] += 1
            continue
        # gog returns underscored keys (message_id, in_reply_to); the rest of the code uses RFC names.
        headers = {k.lower().replace('_','-'):v for k,v in full.get('headers',{}).items()}
        date = None
        try:
            date = parsedate_to_datetime(headers.get('date',''))
        except (ValueError,TypeError):
            pass
        if not date and raw.get('internalDate'):
            date = datetime.fromtimestamp(int(raw['internalDate'])/1000,tz=timezone.utc)
        if not date or not raw.get('threadId'):
            raise Refused('gmail_message_missing_metadata', gmail_message_id=gmail_id)
        if date.tzinfo is None:
            date = date.replace(tzinfo=timezone.utc)
        prepared.append((date,gmail_id,full,raw,headers,labels))
    # Chronological processing means sent rows exist before their replies are reconciled.
    planned = {}
    if not apply:
        with dict_cursor(db) as cur:
            cur.execute('select * from mail_message')
            planned = {r['id']:dict(r) for r in cur.fetchall()}
    for date,gmail_id,full,raw,headers,labels in sorted(prepared,key=lambda r:(r[0],r[1])):
        from_parties = parse_email_addresses(headers.get('from'))
        to_parties = parse_email_addresses(headers.get('to'))
        cc_parties = parse_email_addresses(headers.get('cc'))
        bcc_parties = parse_email_addresses(headers.get('bcc'))
        parties = from_parties+to_parties+cc_parties
        sender = normalize_email(from_parties[0][1]) if from_parties else None
        outbound = sender in own_addresses or 'SENT' in labels
        direction = 'outbound' if outbound else 'inbound'
        identity = next((r[0] for r in identities if normalize_email(r[1])==sender),None) if outbound else next((r[0] for r in identities if r[1]==account.lower()),None)
        labelled = gmail_id in labelled_ids or 'CRM' in labels
        visible,reason = visibility(parties,people,own_addresses,labelled,gmail_id in triaged_ids or bool({'Deal','Inbound'} & set(labels)))
        stats['imported'] += 1
        stats['crm_visible'] += int(visible)
        body, body_html, has_attachments = extract_bodies(full)
        stats['html_missing'] += int(not body_html)
        rfc_id = headers.get('message-id')
        with db.cursor() as cur:
            # Prefer the row that already holds this Gmail id: linking a send-log row by RFC id while another row owns the
            # id violates mail_message_owner_gmail_uidx and aborted every later sync of the mailbox.
            cur.execute('''select id from mail_message where (gmail_message_id=%s and (mailbox_owner_id=%s or mailbox_owner_id is null)) or (%s is not null and rfc_message_id=%s and direction=%s and (mailbox_owner_id=%s or mailbox_owner_id is null)) order by (gmail_message_id=%s) desc nulls last, id limit 1''', (gmail_id,owner_id,rfc_id,rfc_id,direction,owner_id,gmail_id))
            existing = cur.fetchone()
        message_id = existing[0] if existing else stable_id('gmail_msg_',account.lower()+':'+gmail_id)
        stats['linked'] += int(bool(existing))
        if not apply:
            observed = {'id':message_id,'direction':direction,'sent_at':date,'thread_id':stable_id('gmail_thread_',account.lower()+':'+raw['threadId']),'rfc_message_id':rfc_id,'mailbox_owner_id':owner_id}
            if not outbound or not existing:
                observed.update(from_email=sender,to_emails=[normalize_email(e) for _,e in to_parties],cc_emails=[normalize_email(e) for _,e in cc_parties],bcc_emails=[normalize_email(e) for _,e in bcc_parties],in_reply_to=headers.get('in-reply-to'),rfc_references=headers.get('references'),personalization={'provider_headers':headers})
            planned[message_id] = {**planned.get(message_id,{}),**observed}
        if not apply:
            if visible:
                for name,email in parties:
                    email = normalize_email(email)
                    if email and email not in people and email not in own_addresses and (labelled or email.split('@',1)[1] in domains):
                        people[email] = 'person_email_'+hashlib.md5(email.encode()).hexdigest()[:16]
                        stats['auto_created'] += 1
            continue
        with db.cursor() as cur:
            if visible:
                for name,email in parties:
                    ensure_person(cur,name,email,people,own_addresses,companies,stats,domains,labelled)
            from_person = people.get(sender)
            recipients = {kind:[normalize_email(e) for _,e in entries if normalize_email(e)] for kind,entries in [('to',to_parties),('cc',cc_parties),('bcc',bcc_parties)]}
            thread_pk = stable_id('gmail_thread_',account.lower()+':'+raw['threadId'])
            cur.execute('''insert into mail_thread(id,subject,gmail_thread_id,mailbox_owner_id,last_message_at,crm_visible) values(%s,%s,%s,%s,%s,%s)
                on conflict(mailbox_owner_id,gmail_thread_id) where gmail_thread_id is not null do update set subject=excluded.subject,last_message_at=greatest(mail_thread.last_message_at,excluded.last_message_at),crm_visible=mail_thread.crm_visible or excluded.crm_visible returning id''', (thread_pk,headers.get('subject'),raw['threadId'],owner_id,date,visible))
            thread_pk = cur.fetchone()[0]
            # Store raw MIME content; sanitisation belongs to the reader.
            preview = re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',body)).strip()[:500]
            fields = {'thread_id':thread_pk,'mailbox_owner_id':owner_id,'gmail_message_id':gmail_id,'rfc_message_id':rfc_id,'in_reply_to':headers.get('in-reply-to'),'rfc_references':headers.get('references'),'subject':headers.get('subject'),'body_text':body,'body_preview':preview,'body_html':body_html,'from_email':sender,'from_person_id':from_person,'to_emails':recipients['to'],'cc_emails':recipients['cc'],'bcc_emails':recipients['bcc'],'labels':labels,'has_attachments':has_attachments,'sent_at':date,'crm_visible':visible,'crm_visible_reason':reason}
            if not outbound:
                fields['personalization'] = json.dumps({'provider_headers':headers,**({'attachments':describe(full)} if has_attachments else {})})
            if existing:
                # An outbound row is an immutable copy/routing snapshot. Gmail
                # receipt normalisation must never rewrite approved content.
                if outbound:
                    observed_fields = ('thread_id','mailbox_owner_id','gmail_message_id','rfc_message_id','labels','sent_at','crm_visible','crm_visible_reason')
                    fields = {key:fields[key] for key in observed_fields}
                    fields.update(state='accepted',accepted_at=date)
                # HTML is gap-filling only, including for frozen outbound copies.
                fields.pop('body_html', None)
                if body_html:
                    cur.execute("update mail_message set body_html=%s where id=%s and coalesce(body_html,'')=''", (body_html,message_id))
                cur.execute('update mail_message set '+','.join(k+'=%s' for k in fields)+',last_synced_at=now(),updated_at=now() where id=%s', (*fields.values(),message_id))
            else:
                fields.update(id=message_id,direction=direction,transport='gmail',purpose='personal' if outbound else None,identity_key=identity,state='accepted' if outbound else 'received',accepted_at=date if outbound else None)
                cur.execute('insert into mail_message('+','.join(fields)+') values('+','.join(['%s']*len(fields))+')',tuple(fields.values()))
            cur.execute('update mail_message set last_synced_at=now() where id=%s',(message_id,))
            if outbound:
                cur.execute("insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values(%s,'sent','gmail',%s,%s,'{}') on conflict do nothing",(message_id,'sent:'+account.lower()+':'+gmail_id,date))
            if visible:
                for kind,entries in [('to',to_parties),('cc',cc_parties)]:
                    for position,(_,email) in enumerate(entries):
                        person = people.get(normalize_email(email))
                        if person:
                            cur.execute('insert into mail_message_recipient(message_id,person_id,recipient_type,position) values(%s,%s,%s,%s) on conflict do nothing',(message_id,person,kind,position))
                interaction_direction = 'Sent' if outbound else ('Received' if any(normalize_email(e) in own_addresses for _,e in to_parties+cc_parties) else 'Internal')
                for position,(_,email) in enumerate(parties):
                    person = people.get(normalize_email(email))
                    if not person or normalize_email(email) in own_addresses:
                        continue
                    cur.execute('insert into mail_thread_participant(thread_id,person_id,position) values(%s,%s,%s) on conflict do nothing',(thread_pk,person,position))
                    score = 0.3 if position>=len(from_parties)+len(to_parties) else 1.0
                    interaction = 'int_'+hashlib.md5(f'{message_id}_{person}'.encode()).hexdigest()[:16]
                    cur.execute('''insert into crm_interactions(id,type,occurred_at,person_id,company_id,email_message_id,direction,score_contribution) values(%s,'Email',%s,%s,%s,%s,%s,%s) on conflict(id) do update set occurred_at=excluded.occurred_at,direction=excluded.direction,score_contribution=excluded.score_contribution''',(interaction,date,person,companies.get(person),message_id,interaction_direction,score))
                    cur.execute("update crm_people set last_interaction_at=greatest(coalesce(last_interaction_at,'1970-01-01'::timestamptz),%s) where id=%s and (last_interaction_at is null or last_interaction_at<%s)",(date,person,date))
    if apply:
        with dict_cursor(db) as cur:
            cur.execute("select * from mail_message where mailbox_owner_id=%s or (direction='outbound' and mailbox_owner_id is null)",(owner_id,))
            planned = {r['id']:dict(r) for r in cur.fetchall()}
    with db.cursor() as cur:
        cur.execute("select provider_event_id from mail_event where source='gmail' and type='replied'")
        observed_replies = {r[0] for r in cur.fetchall()}
        outgoing = [row for row in planned.values() if row['direction']=='outbound']
        # reply_matches() requires the sender of the incoming message to be one of the outgoing message's
        # counterparties, so index outgoing mail by those addresses instead of testing every pair. The
        # all-pairs loop cost about 70 seconds of CPU per sync (42M comparisons) and ran on every send.
        by_counterparty = {}
        for row in outgoing:
            addresses = {normalize_email(email) for field in ('to_emails','cc_emails','bcc_emails') for email in row.get(field,[])}
            addresses.add(normalize_email(row.get('recipient_email')))
            for address in addresses:
                if address:
                    by_counterparty.setdefault(address,[]).append(row)
        for incoming in planned.values():
            if incoming['direction'] != 'inbound':
                continue
            for original in by_counterparty.get(normalize_email(incoming.get('from_email')),()):
                if not reply_matches(incoming,original,owner_id,account):
                    continue
                event_id = 'reply:'+original['id']+':'+incoming['id']
                if not apply:
                    stats['replies'] += int(event_id not in observed_replies)
                    continue
                cur.execute('update mail_message set replied_at=least(replied_at,%s) where id=%s',(incoming['sent_at'],original['id']))
                cur.execute("insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values(%s,'replied','gmail',%s,%s,jsonb_build_object('reply_message_id',%s)) on conflict do nothing",(original['id'],event_id,incoming['sent_at'],incoming['id']))
                stats['replies'] += cur.rowcount
                cur.execute("update mail_followup set state='paused',paused_reason='reply',updated_at=now() where state in ('pending','drafted') and (thread_id=any(%s::text[]) or message_id=%s)",([original.get('thread_id'),incoming.get('thread_id')],original['id']))
        if apply:
            cur.execute('''update mail_thread t set message_count=s.n,last_message_at=s.latest,crm_visible=s.visible from (select thread_id,count(*)::integer n,max(sent_at) latest,bool_or(crm_visible) visible from mail_message where mailbox_owner_id=%s group by thread_id) s where t.id=s.thread_id''',(owner_id,))
    return {'account':account,'dry_run':not apply,'counts':stats}
