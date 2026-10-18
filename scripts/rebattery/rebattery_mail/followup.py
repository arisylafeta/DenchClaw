"""Follow-ups prepare drafts only. Refresh before taking a follow-up row lock."""
import json
from .core import connection, dict_cursor, Refused
from .draft import prepare, insert
from .drivers import resolve_driver
from .send import refresh_replies
from . import policy


def source(db,followup):
    with dict_cursor(db) as cur:
        if followup['message_id']:
            cur.execute('select * from mail_message where id=%s',(followup['message_id'],))
        else:
            cur.execute("select * from mail_message where thread_id=%s and direction='outbound' order by coalesce(sent_at,created_at) desc limit 1",(followup['thread_id'],))
        original = cur.fetchone()
    if not original:
        raise Refused('message_not_found')
    original = dict(original)
    original['thread_id'] = followup['thread_id'] or original['thread_id']
    return original


def load_followup(db,target,lock=False,allow_paused=False):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_followup where id=%s'+(' for update' if lock else ''),(target,))
        row = cur.fetchone()
    if not row:
        raise Refused('followup_not_found')
    if not allow_paused and row['state']=='paused' and row['paused_reason'] in ('reply','thread_has_reply'):
        raise Refused('thread_has_reply')
    return row


def manage(args,driver=None):
    if args.action=='list':
        with connection(read_only=True) as db,dict_cursor(db) as cur:
            cur.execute('select * from mail_followup order by due_at,id')
            return {'followups':[dict(row) for row in cur.fetchall()]}
    if args.action=='draft':
        # No transaction holding a follow-up row lock may wait for another connection's sync.
        with connection(read_only=True) as db:
            followup = load_followup(db,args.target)
            if followup['state']!='pending':
                raise Refused('followup_not_pending')
            original = source(db,followup)
            author,transport = policy.identity(db,original['identity_key'],original['purpose'],original['transport'])
        if args.apply:
            refresh_replies(original,author,driver or resolve_driver(author,transport))
    with connection(read_only=not args.apply) as db,dict_cursor(db) as cur:
        followup = load_followup(db,args.target,lock=args.apply,allow_paused=args.action in ('pause','cancel'))
        if args.action in ('pause','cancel'):
            state = 'paused' if args.action=='pause' else 'cancelled'
            if args.apply:
                cur.execute('update mail_followup set state=%s,paused_reason=%s,updated_at=now() where id=%s',(state,args.reason,args.target))
            return {'followup_id':args.target,'state':state,'reason':args.reason,'dry_run':not args.apply}
        if followup['state']!='pending':
            raise Refused('followup_not_pending')
        original = source(db,followup)  # Re-read after refresh, then re-evaluate under the lock.
        if policy.thread_reply(db,original):
            if args.apply:
                cur.execute("update mail_followup set state='paused',paused_reason='thread_has_reply',updated_at=now() where id=%s",(args.target,))
                db.commit()
            raise Refused('thread_has_reply')
        author,transport = policy.identity(db,followup['identity_key'] or original['identity_key'],original['purpose'],original['transport'])
        if not original.get('rfc_message_id') and not original.get('gmail_message_id'):
            raise Refused('reply_anchor_missing','Synchronise the originating sent message before drafting a follow-up')
        recipients = original['to_emails'] if original['direction']=='outbound' else [original['from_email']]
        row,_ = prepare(db,author['key'],recipients,original['purpose'],args.template,json.loads(args.vars),args.subject or original['subject'],args.body,args.html,original['thread_id'],verification=original['personalization'].get('verification',{}),transport=transport)
        row['personalization']['followup_source_message_id'] = original['id']
        if not row.get('in_reply_to'):
            row['in_reply_to'] = original['rfc_message_id']
            row['rfc_references'] = ' '.join(filter(None,[original['rfc_references'],original['rfc_message_id']]))
            row['personalization']['reply_gmail_message_id'] = original['gmail_message_id']
        if args.apply:
            insert(db,row)
            cur.execute("update mail_followup set state='drafted',draft_message_id=%s,updated_at=now() where id=%s",(row['id'],args.target))
    return {'followup_id':args.target,'message':row,'dry_run':not args.apply}


def register(subparsers):
    parser = subparsers.add_parser('followup')
    commands = parser.add_subparsers(dest='action',required=True)
    parser = commands.add_parser('list')
    parser.set_defaults(handler=manage)
    for action in ('draft','pause','cancel'):
        parser = commands.add_parser(action)
        parser.add_argument('target')
        parser.add_argument('--apply',action='store_true')
        if action=='draft':
            parser.add_argument('--template')
            parser.add_argument('--vars',default='{}')
            parser.add_argument('--subject')
            parser.add_argument('--body')
            parser.add_argument('--html')
        else:
            parser.add_argument('--reason',required=True)
        parser.set_defaults(handler=manage)
