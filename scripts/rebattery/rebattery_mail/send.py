"""Approval-bound, claim-before-send execution. Unknown receipts are never retried."""
import json
from uuid import uuid4
import psycopg2
from .core import connection, dict_cursor, Refused, ProviderError, UnknownOutcome
from .digest import digest, load
from . import policy
from .drivers import resolve_driver


def approval_row(db,target):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_approval where subject_id=%s order by approved_at desc,id desc limit 1',(target,))
        return cur.fetchone()


def approve(args):
    name = policy.human(args.approved_by)
    with connection(read_only=not args.apply) as db:
        campaign,rows = load(db,args.target)
        sha = digest(rows)
        if sha != args.sha256:
            raise Refused('approval_digest_mismatch',current_sha256=sha)
        if campaign:
            notes = json.loads(campaign['notes'])
            if notes.get('frozen_sha256') != sha or campaign['audience_size'] != len(rows):
                raise Refused('approval_stale')
            if campaign['mail_state'] not in ('frozen','approved','pilot'):
                raise Refused('approval_stale')
        elif rows[0]['state'] not in ('draft','frozen','approved'):
            raise Refused('approval_stale')
        count = sum(len(r['to_emails']) for r in rows)
        if len({r['identity_key'] for r in rows}) != 1:
            raise Refused('approval_identity_mismatch')
        if args.apply:
            with db.cursor() as cur:
                cur.execute('insert into mail_approval(id,subject_type,subject_id,sha256,recipient_count,identity_key,approved_by,expires_at) values (%s,%s,%s,%s,%s,%s,%s,%s)',(uuid4().hex,'campaign' if campaign else 'message',args.target,sha,count,rows[0]['identity_key'],name,args.expires_at))
                if campaign:
                    cur.execute("update campaigns set approved_manifest_sha256=%s,approved_by=%s,approved_at=now(),mail_state='approved' where id=%s",(sha,name,args.target))
    return {'subject_id':args.target,'sha256':sha,'recipient_count':count,'approved_by':name,'dry_run':not args.apply}


def check(db,target,expected=None):
    campaign,rows = load(db,target)
    sha = digest(rows)
    if expected is not None and sha != expected:
        raise Refused('approval_digest_mismatch',current_sha256=sha)
    if any(r['state'] in ('sending','unknown') for r in rows):
        raise Refused('audience_has_sending_or_unknown')
    if campaign and (json.loads(campaign['notes']).get('frozen_sha256') != sha or campaign['audience_size'] != len(rows)):
        raise Refused('approval_stale')
    policy.approval(approval_row(db,target),sha,sum(len(r['to_emails']) for r in rows),rows[0]['identity_key'],campaign['frozen_at'] if campaign else None)
    return campaign,rows,sha


def pause_for_reply(message):
    with connection() as db, db.cursor() as cur:
        cur.execute("update mail_followup set state='paused',paused_reason='thread_has_reply',updated_at=now() where draft_message_id=%s or (thread_id=%s and state in ('pending','drafted'))",(message['id'],message.get('thread_id')))


def preflight(message, driver):
    with connection(read_only=True) as db:
        author,_ = policy.identity(db,message['identity_key'],message['purpose'],message['transport'])
    snapshot = message['personalization'].get('identity_snapshot')
    if not snapshot or any(author.get(key) != value for key,value in snapshot.items()):
        raise Refused('approval_identity_mismatch')
    suppressions = driver.preflight(author,message)
    with connection(read_only=True) as db:
        policy.content(message)
        if message.get('person_id'):
            with db.cursor() as cur:
                cur.execute('select lower(trim(email)) from crm_people where id=%s',(message['person_id'],))
                person = cur.fetchone()
                if not person or person[0] != message['recipient_email']:
                    raise Refused('approval_stale', 'Frozen recipient address no longer matches the CRM person')
        for email in message['to_emails']:
            policy.recipient(db,email,message['personalization'].get('verification',{}),suppressions)
        replied = policy.thread_reply(db,message)
    if replied:
        pause_for_reply(message)
        raise Refused('thread_has_reply')
    return author


def mark_failure(message_id,state,event=None,detail=None):
    with connection() as db, db.cursor() as cur:
        cur.execute('update mail_message set state=%s,updated_at=now() where id=%s and state in (\'sending\',\'unknown\')',(state,message_id))
        if event:
            cur.execute("insert into mail_event(message_id,type,source,occurred_at,detail) values (%s,%s,'cli',now(),%s::jsonb)",(message_id,event,json.dumps(detail or {})))


def record_acceptance(message, receipt):
    with connection() as db, db.cursor() as cur:
        cur.execute("""update mail_message set state='accepted',provider_message_id=%s,gmail_message_id=%s,
            accepted_at=now(),sent_at=now(),updated_at=now() where id=%s and state='sending'""",(receipt.get('provider_message_id'),receipt.get('gmail_message_id'),message['id']))
        if cur.rowcount != 1:
            raise RuntimeError('Claim changed after provider acceptance')
        cur.execute("insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values (%s,'sent',%s,%s,now(),%s::jsonb)",(message['id'],'gmail' if message['transport']=='gmail' else 'postmark','sent:'+message['id'],json.dumps(receipt)))


def send_claimed(message,driver):
    try:
        author = preflight(message,driver)  # Recheck after claiming, immediately before submission.
    except Refused:
        mark_failure(message['id'],'failed')
        raise
    try:
        receipt = driver.send(author,message)
    except UnknownOutcome:
        mark_failure(message['id'],'unknown')
        raise
    except Refused:
        mark_failure(message['id'],'failed')
        raise
    except ProviderError:
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
            # The durable pre-submission claim remains sending, which also blocks retry.
            raise UnknownOutcome('accepted_write_failed',message_id=message['id'],receipt=receipt,ledger_unavailable=True) from exc
        raise UnknownOutcome('accepted_write_failed',message_id=message['id'],receipt=receipt) from exc
    return {'message_id':message['id'],'state':'accepted',**receipt}


def claim(message):
    key = 'mail:'+message['id']
    try:
        with connection() as db, dict_cursor(db) as cur:
            cur.execute("""update mail_message set state='sending',claimed_at=now(),idempotency_key=%s,
                updated_at=now() where id=%s and state in ('draft','frozen','approved') and idempotency_key is null returning *""",(key,message['id']))
            row = cur.fetchone()
            if not row:
                raise Refused('duplicate_idempotency_key',message_id=message['id'])
            return {**message,**dict(row)}
    except psycopg2.errors.UniqueViolation as exc:
        raise Refused('duplicate_idempotency_key') from exc


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
            eligible = [r for r in rows if r['state'] in ('draft','frozen','approved')]
            if not eligible:
                raise Refused('duplicate_idempotency_key')
            cap = args.max_recipients if campaign_mode else None
            if cap is not None and cap < 1:
                raise Refused('invalid_recipient_cap')
            chosen = eligible[:cap] if cap else eligible
            if not args.apply:
                return {'subject_id':target,'sha256':sha,'message_ids':[r['id'] for r in chosen],'dry_run':True}
            results = []
            for message in chosen:
                with connection(read_only=True) as db:
                    author,_ = policy.identity(db,message['identity_key'],message['purpose'],message['transport'])
                sender = driver or resolve_driver(author,message['transport'])
                preflight(message,sender)
                results.append(send_claimed(claim(message),sender))
            pilot = bool(campaign and cap is not None)
            if campaign:
                with connection() as db, db.cursor() as cur:
                    cur.execute("update campaigns set mail_state=%s,pilot_cap=%s,launched_at=coalesce(launched_at,now()) where id=%s",('pilot' if pilot else 'launched',cap,target))
            return {'subject_id':target,'sha256':sha,'results':results,'dry_run':False,**({'next_gate':'pilot_review'} if pilot else {})}
        finally:
            if args.apply:
                with guard.cursor() as cur:
                    cur.execute('select pg_advisory_unlock(hashtextextended(%s,0))',(target,))


def launch(args,driver=None):
    return execute(args,driver,True)


def recover(args,driver=None):
    with connection(read_only=True) as db:
        campaign,rows = load(db,args.target)
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
                    accepted_at=coalesce(accepted_at,now()),updated_at=now() where id=%s and state in ('sending','unknown')""",(receipt.get('provider_message_id'),receipt.get('gmail_message_id'),message['id']))
                cur.execute("insert into mail_event(message_id,type,source,provider_event_id,occurred_at,detail) values (%s,'sent',%s,%s,now(),%s::jsonb) on conflict do nothing",(message['id'],'gmail' if message['transport']=='gmail' else 'postmark','sent:'+message['id'],json.dumps(receipt)))
    return {'subject_id':args.target,'results':results,'dry_run':not args.apply}


def register(subparsers):
    parser = subparsers.add_parser('approve')
    parser.add_argument('target')
    parser.add_argument('--sha256',required=True)
    parser.add_argument('--approved-by',required=True)
    parser.add_argument('--expires-at')
    parser.add_argument('--apply',action='store_true')
    parser.set_defaults(handler=approve)
    for name,handler in [('send',execute),('launch',launch),('recover',recover)]:
        parser = subparsers.add_parser(name)
        parser.add_argument('target')
        parser.add_argument('--apply',action='store_true')
        if name == 'launch':
            parser.add_argument('--approved-sha256',required=True)
            parser.add_argument('--max-recipients',type=int)
        parser.set_defaults(handler=handler)
