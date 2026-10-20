"""Approval-bound submission, with fresh gates for every provider call."""
import json
import os
from types import SimpleNamespace as NS_
from uuid import uuid4
import psycopg2
from .core import connection, dict_cursor, Refused, ProviderError, UnknownOutcome
from .digest import digest, load
from . import policy
from .drivers import resolve_driver, live_gate

CLAIMABLE = ('draft','frozen','approved')


def approval_row(db,target,approval_id=None):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_approval where subject_id=%s' + (' and id=%s' if approval_id else '') + ' order by approved_at desc,id desc limit 1', (target,approval_id) if approval_id else (target,))
        return cur.fetchone()


def approval_count(rows):
    return sum(len(row['to_emails']) for row in rows if row['state'] in CLAIMABLE)


def reject_member(campaign,rows):
    if not campaign and any(row.get('campaign_id') for row in rows):
        raise Refused('campaign_member_requires_campaign_flow')


def frozen_check(campaign,rows,sha):
    if campaign and (json.loads(campaign['notes']).get('frozen_sha256') != sha or campaign['audience_size'] != len(rows)):
        raise Refused('approval_stale')
    if len({row['identity_key'] for row in rows}) != 1:
        raise Refused('approval_identity_mismatch')


def approve(args):
    name = policy.human(args.approved_by)
    scope = getattr(args,'scope','pilot')
    if scope not in ('pilot','full'):
        raise Refused('approval_invalid_scope')
    with connection(read_only=not args.apply) as db:
        if args.apply:
            with db.cursor() as cur:
                cur.execute('select pg_try_advisory_xact_lock(hashtextextended(%s,0))',(args.target,))
                if not cur.fetchone()[0]:
                    raise Refused('audience_has_sending_or_unknown')
        campaign,rows = load(db,args.target)
        reject_member(campaign,rows)
        sha = digest(rows)
        if sha != args.sha256:
            raise Refused('approval_digest_mismatch',current_sha256=sha)
        frozen_check(campaign,rows,sha)
        if any(row['state'] in ('sending','unknown') for row in rows):
            raise Refused('audience_has_sending_or_unknown')
        if campaign and campaign['mail_state'] not in ('frozen','approved','pilot'):
            raise Refused('approval_stale')
        count = approval_count(rows)
        if not count:
            raise Refused('approval_stale')
        if args.apply:
            with db.cursor() as cur:
                cur.execute('insert into mail_approval(id,subject_type,subject_id,sha256,recipient_count,identity_key,approved_by,expires_at,scope) values (%s,%s,%s,%s,%s,%s,%s,%s,%s)',(uuid4().hex,'campaign' if campaign else 'message',args.target,sha,count,rows[0]['identity_key'],name,args.expires_at,scope))
                if campaign:
                    cur.execute("update campaigns set approved_manifest_sha256=%s,approved_by=%s,approved_at=now(),mail_state='approved' where id=%s",(sha,name,args.target))
    return {'subject_id':args.target,'sha256':sha,'recipient_count':count,'approved_by':name,'scope':scope,'dry_run':not args.apply}


def check(db,target,expected=None):
    campaign,rows = load(db,target)
    reject_member(campaign,rows)
    sha = digest(rows)
    if expected is not None and sha != expected:
        raise Refused('approval_digest_mismatch',current_sha256=sha)
    if any(row['state'] in ('sending','unknown') for row in rows):
        raise Refused('audience_has_sending_or_unknown')
    frozen_check(campaign,rows,sha)
    approval = approval_row(db,target)
    if campaign and approval:
        notes = json.loads(campaign['notes'])
        with db.cursor() as cur:
            cur.execute('select %s::timestamptz is not null and %s::timestamptz <= %s::timestamptz',
                        (notes.get('last_pilot_completed_at'),approval['approved_at'],notes.get('last_pilot_completed_at')))
            before_pilot_review = cur.fetchone()[0]
        if notes.get('last_pilot_approval_id')==approval['id'] or before_pilot_review:
            raise Refused('approval_stale','The remainder needs a new named-human approval after pilot review')
    count = approval_count(rows)
    # A repeated completed send should report its idempotency boundary, not a changed count.
    if not count and approval:
        raise Refused('duplicate_idempotency_key')
    policy.approval(approval,sha,count,rows[0]['identity_key'],campaign['frozen_at'] if campaign else None)
    policy.human(approval['approved_by'])
    return campaign,rows,sha


def pause_for_reply(message):
    origin = message.get('personalization',{}).get('followup_source_message_id') or message['id']
    with connection() as db, db.cursor() as cur:
        cur.execute("update mail_followup set state='paused',paused_reason='thread_has_reply',updated_at=now() where (draft_message_id=%s or message_id=%s or thread_id=%s) and state in ('pending','drafted')",(message['id'],origin,message.get('thread_id')))


def refresh_replies(message,author,driver=None):
    """Refresh the reply mailbox regardless of outbound delivery transport."""
    origin = message.get('personalization',{}).get('followup_source_message_id')
    with connection(read_only=True) as db, dict_cursor(db) as cur:
        cur.execute('select m.id,m.thread_id,m.transport,m.rfc_message_id,m.provider_message_id,u.email as owner_email from mail_message m left join crm_users u on u.id=m.mailbox_owner_id where m.id=%s',(origin or message['id'],))
        source = cur.fetchone()
        thread_id = (source['thread_id'] if source else None) or message.get('thread_id')
        # A first message has no thread and no earlier outbound mail to be answered, so the real mailbox
        # sync is skipped for it (an injected driver refresh hook still runs).
        fresh = not thread_id and not origin
        reply_to = author.get('reply_to') or author['address']
        cur.execute('select distinct gmail_account from mail_identity where active and gmail_account is not null and lower(address)=lower(%s)',(reply_to,))
        accounts = {row['gmail_account'] for row in cur.fetchall()}
        account = next(iter(accounts)) if len(accounts)==1 else None
        if not account and reply_to.lower()==author['address'].lower():
            account = author.get('gmail_account') or (source['owner_email'] if source else None)
        if not account and thread_id:
            cur.execute('select u.email from mail_thread t join crm_users u on u.id=t.mailbox_owner_id where t.id=%s',(thread_id,))
            owner = cur.fetchone()
            account = owner['email'] if owner else None
    if not account and not fresh:
        raise Refused('reply_mailbox_unavailable',reply_to=reply_to)
    if driver is not None and hasattr(driver,'refresh_replies'):
        driver.refresh_replies(author,message)
    else:
        from .sync import recheck_thread, PostmarkClient, postmark_rfc_identity
        if source and source['transport'].startswith('postmark') and source['provider_message_id'] and not source['rfc_message_id']:
            from urllib.parse import quote
            client = driver.client if driver is not None and hasattr(driver,'client') else PostmarkClient().request
            path = '/messages/outbound/'+quote(source['provider_message_id'],safe='')
            details = client(path+'/details')
            if not postmark_rfc_identity(details):
                details['RawMessage'] = client(path+'/dump').get('Body','')
            rfc_id = postmark_rfc_identity(details)
            if not rfc_id:
                raise Refused('reply_anchor_missing','The originating Postmark RFC Message-ID is not yet available')
            with connection() as db,db.cursor() as cur:
                cur.execute('update mail_message set rfc_message_id=%s where id=%s and rfc_message_id is null',(rfc_id,source['id']))
        if not fresh:
            recheck_thread(thread_id,account)
    # Sync may have linked a previously unthreaded accepted message.
    with connection(read_only=True) as db, db.cursor() as cur:
        cur.execute('select m.thread_id,t.gmail_thread_id from mail_message m left join mail_thread t on t.id=m.thread_id where m.id=%s',(message['id'],))
        observed = cur.fetchone()
        if observed and observed[0]:
            message['thread_id'],message['gmail_thread_id'] = observed


def preflight(message, driver):
    with connection(read_only=True) as db:
        author,_ = policy.identity(db,message['identity_key'],message['purpose'],message['transport'])
    snapshot = message['personalization'].get('identity_snapshot')
    if not snapshot or any(author.get(key) != value for key,value in snapshot.items()):
        raise Refused('approval_identity_mismatch')
    suppressions = driver.preflight(author,message)
    refresh_replies(message,author,driver)
    with connection(read_only=True) as db:
        policy.content(message)
        if message.get('person_id'):
            with db.cursor() as cur:
                cur.execute('select lower(trim(email)) from crm_people where id=%s',(message['person_id'],))
                person = cur.fetchone()
                if not person or person[0] != message['recipient_email']:
                    raise Refused('approval_stale','Frozen recipient address no longer matches the CRM person')
        for email in message['to_emails']:
            policy.recipient(db,email,message['personalization'].get('verification',{}),suppressions)
        replied = policy.thread_reply(db,message)
    if replied:
        pause_for_reply(message)
        raise Refused('thread_has_reply')
    return author


def mark_failure(message_id,state,event=None,detail=None,reason=None):
    with connection() as db, db.cursor() as cur:
        cur.execute("""update mail_message set state=%s,updated_at=now(),personalization=case when %s is null then personalization
            else jsonb_set(personalization,'{send_failure}',%s::jsonb,true) end where id=%s and state in ('sending','unknown')""",(state,reason,json.dumps({'reason':reason,'detail':detail}),message_id))
        if event:
            cur.execute("insert into mail_event(message_id,type,source,occurred_at,detail) values (%s,%s,'cli',now(),%s::jsonb)",(message_id,event,json.dumps(detail or {})))


def record_acceptance(message, receipt):
    with connection() as db, db.cursor() as cur:
        cur.execute("""update mail_message set state='accepted',provider_message_id=%s,gmail_message_id=%s,
            accepted_at=now(),sent_at=now(),updated_at=now() where id=%s and state='sending'""",(receipt.get('provider_message_id'),receipt.get('gmail_message_id'),message['id']))
        if cur.rowcount != 1:
            raise RuntimeError('Claim changed after provider acceptance')
        cur.execute("insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values (%s,'sent',%s,%s,now(),%s::jsonb)",(message['id'],'gmail' if message['transport']=='gmail' else 'postmark','sent:'+message['id'],json.dumps(receipt)))


def send_claimed(message,driver,authorise):
    try:
        author = preflight(message,driver)
        authorise()  # Expiry/revocation/content gates are checked after all provider reads.
    except Exception as exc:
        mark_failure(message['id'],'failed',reason='preflight_error',detail={'cause':getattr(exc,'rule',type(exc).__name__)})
        raise
    try:
        receipt = driver.send(author,message)
    except UnknownOutcome:
        mark_failure(message['id'],'unknown')
        raise
    except (Refused,ProviderError):
        mark_failure(message['id'],'failed')
        raise
    except Exception as exc:
        mark_failure(message['id'],'unknown')
        raise UnknownOutcome('provider_send_uncertain',message_id=message['id']) from exc
    try:
        record_acceptance(message,receipt)
    except Exception as exc:
        try:
            mark_failure(message['id'],'unknown','accepted_write_failed',receipt)
        except Exception:
            raise UnknownOutcome('accepted_write_failed',message_id=message['id'],receipt=receipt,ledger_unavailable=True) from exc
        raise UnknownOutcome('accepted_write_failed',message_id=message['id'],receipt=receipt) from exc
    return {'message_id':message['id'],'state':'accepted',**receipt}


def claim(message):
    try:
        with connection() as db, dict_cursor(db) as cur:
            cur.execute("""update mail_message set state='sending',claimed_at=now(),idempotency_key=%s,
                updated_at=now() where id=%s and state in ('draft','frozen','approved') and idempotency_key is null returning *""",('mail:'+message['id'],message['id']))
            row = cur.fetchone()
            if not row:
                raise Refused('duplicate_idempotency_key',message_id=message['id'])
            return {**message,**dict(row)}
    except psycopg2.errors.UniqueViolation as exc:
        raise Refused('duplicate_idempotency_key') from exc


def submission_approval(target,approval_id,sha,count,identity_key):
    with connection(read_only=True) as db:
        campaign,rows = load(db,target)
        current_sha = digest(rows)
        if current_sha != sha:
            raise Refused('approval_digest_mismatch')
        frozen_check(campaign,rows,current_sha)
        row = approval_row(db,target,approval_id)
        policy.approval(row,sha,count,identity_key,campaign['frozen_at'] if campaign else None)
        policy.human(row['approved_by'])


def execute(args, driver=None, campaign_mode=False):
    target = args.target
    with connection(read_only=not args.apply) as guard:
        if args.apply:
            with guard.cursor() as cur:
                cur.execute('select pg_try_advisory_lock(hashtextextended(%s,0))',(target,))
                if not cur.fetchone()[0]:
                    raise Refused('audience_has_sending_or_unknown')
        try:
            campaign,rows,sha = check(guard,target,args.approved_sha256 if campaign_mode else None)
            if bool(campaign) != campaign_mode:
                raise Refused('wrong_subject_type')
            eligible = [row for row in rows if row['state'] in CLAIMABLE]
            if campaign:
                eligible.sort(key=lambda row:row['recipient_email'])
            if not eligible:
                raise Refused('duplicate_idempotency_key')
            approval = approval_row(guard,target)
            cap = args.max_recipients if campaign_mode else None
            if cap is not None and cap < 1:
                raise Refused('invalid_recipient_cap')
            if campaign and approval['scope']=='pilot' and cap is None:
                raise Refused('pilot_cap_required')
            configured_cap = rows[0]['personalization'].get('campaign_cap')
            if configured_cap is not None and (cap is None or cap>configured_cap):
                raise Refused('campaign_cap_exceeded')
            chosen = eligible[:cap] if cap else eligible
            if not args.apply:
                return {'subject_id':target,'sha256':sha,'message_ids':[row['id'] for row in chosen],'dry_run':True}
            live_gate()  # Refuse before changing any delivery state or claiming a key.
            count = approval_count(rows)
            def authorise():
                submission_approval(target,approval['id'],sha,count,rows[0]['identity_key'])
            results = []
            for message in chosen:
                with connection(read_only=True) as db:
                    author,_ = policy.identity(db,message['identity_key'],message['purpose'],message['transport'])
                sender = driver or resolve_driver(author,message['transport'])
                preflight(message,sender)
                authorise()
                results.append(send_claimed(claim(message),sender,authorise))
            pilot = bool(campaign and cap is not None)
            if campaign:
                with connection() as db, db.cursor() as cur:
                    if pilot:
                        cur.execute("""update campaigns set mail_state='pilot',pilot_cap=%s,launched_at=coalesce(launched_at,now()),
                            notes=(notes::jsonb || jsonb_build_object('last_pilot_approval_id',%s::text,'last_pilot_completed_at',clock_timestamp()))::text where id=%s""",(cap,approval['id'],target))
                    else:
                        cur.execute("update campaigns set mail_state='launched',launched_at=coalesce(launched_at,now()) where id=%s",(target,))
            return {'subject_id':target,'sha256':sha,'results':results,'dry_run':False,**({'next_gate':'pilot_review'} if pilot else {})}
        finally:
            if args.apply:
                with guard.cursor() as cur:
                    cur.execute('select pg_advisory_unlock(hashtextextended(%s,0))',(target,))


def send_message(args,driver=None):
    """One-message send. Naming the approver is the go-ahead: it records approval of the exact current
    digest and sends. Without --approved-by this stays a dry run."""
    name = getattr(args,'approved_by',None)
    if not name:
        try:
            return execute(args,driver)
        except Refused as exc:
            if exc.rule != 'approval_missing':
                raise
        with connection(read_only=True) as db:
            _,rows = load(db,args.target)
        return {'subject_id':args.target,'dry_run':True,'recipients':[e for r in rows for e in r['to_emails']],
                'subject':rows[0]['subject'],'sha256':digest(rows),'hint':'Add --approved-by NAME to send this'}
    name = policy.human(name)
    with connection(read_only=True) as db:
        campaign,rows = load(db,args.target)
        if campaign:
            raise Refused('wrong_subject_type','Campaigns use approve and launch')
        if not any(row['state'] in CLAIMABLE for row in rows):
            raise Refused('duplicate_idempotency_key')
        sha = digest(rows)
        notes = [n for row in rows for email in row['to_emails']
                 for n in [policy.verification_note((row['personalization'].get('verification') or {}).get(email.strip().lower(),{}))] if n]
    args.apply = True
    approve(NS_(target=args.target,sha256=sha,approved_by=name,scope='full',expires_at=None,apply=True))
    os.environ['DENCH_MAIL_LIVE_SEND'] = '1'
    result = execute(args,driver)
    return {**result,'approved_by':name,'notes':notes}


def launch(args,driver=None):
    return execute(args,driver,True)


def recover(args,driver=None):
    with connection(read_only=True) as db:
        _,rows = load(db,args.target)
        with dict_cursor(db) as cur:
            for message in rows:
                cur.execute("select detail from mail_event where message_id=%s and type='accepted_write_failed' order by id",(message['id'],))
                message['recovery_receipts'] = [row['detail'] for row in cur.fetchall()]
    results = []
    for message in rows:
        if message['state'] not in ('sending','unknown'):
            continue
        with connection(read_only=True) as db:
            author,_ = policy.identity(db,message['identity_key'],message['purpose'],message['transport'])
        receipt = (driver or resolve_driver(author,message['transport'])).recover(author,message)
        results.append({'message_id':message['id'],'state':'found' if receipt else 'unresolved','receipt':receipt})
        if receipt and args.apply:
            with connection() as db, db.cursor() as cur:
                cur.execute("""update mail_message set state='accepted',provider_message_id=%s,gmail_message_id=%s,
                    rfc_message_id=coalesce(%s,rfc_message_id),accepted_at=coalesce(accepted_at,now()),updated_at=now()
                    where id=%s and state in ('sending','unknown')""",(receipt.get('provider_message_id'),receipt.get('gmail_message_id'),receipt.get('rfc_message_id'),message['id']))
                cur.execute("insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values (%s,'sent',%s,%s,now(),%s::jsonb) on conflict do nothing",(message['id'],'gmail' if message['transport']=='gmail' else 'postmark','sent:'+message['id'],json.dumps(receipt)))
    return {'subject_id':args.target,'results':results,'dry_run':not args.apply}


def register(subparsers):
    parser = subparsers.add_parser('approve')
    parser.add_argument('target')
    parser.add_argument('--sha256',required=True)
    parser.add_argument('--approved-by',required=True)
    parser.add_argument('--scope',choices=('pilot','full'),default='pilot')
    parser.add_argument('--expires-at')
    parser.add_argument('--apply',action='store_true')
    parser.set_defaults(handler=approve)
    for name,handler in [('send',send_message),('launch',launch),('recover',recover)]:
        parser = subparsers.add_parser(name)
        parser.add_argument('target')
        parser.add_argument('--apply',action='store_true')
        if name == 'send':
            parser.add_argument('--approved-by',help='Named human; sends the current draft for real and records their approval')
        if name == 'launch':
            parser.add_argument('--approved-sha256',required=True)
            parser.add_argument('--max-recipients',type=int)
        parser.set_defaults(handler=handler)
