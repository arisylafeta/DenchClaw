"""Follow-ups prepare drafts only. A reply permanently pauses the chase."""
import json
from .core import connection, dict_cursor, Refused
from .draft import prepare, insert
from .drivers import resolve_driver
from . import policy


def manage(args,driver=None):
    if args.action == 'list':
        with connection(read_only=True) as db, dict_cursor(db) as cur:
            cur.execute('select * from mail_followup order by due_at,id')
            return {'followups':[dict(r) for r in cur.fetchall()]}
    with connection(read_only=not args.apply) as db, dict_cursor(db) as cur:
        cur.execute('select * from mail_followup where id=%s' + (' for update' if args.apply else ''),(args.target,))
        followup = cur.fetchone()
        if not followup:
            raise Refused('followup_not_found')
        if args.action in ('pause','cancel'):
            state = 'paused' if args.action=='pause' else 'cancelled'
            if args.apply:
                cur.execute('update mail_followup set state=%s,paused_reason=%s,updated_at=now() where id=%s',(state,args.reason,args.target))
            return {'followup_id':args.target,'state':state,'reason':args.reason,'dry_run':not args.apply}
        if followup['state'] != 'pending':
            raise Refused('followup_not_pending')
        cur.execute('select * from mail_message where ' + ('id=%s' if followup['message_id'] else 'thread_id=%s') + ' order by created_at desc limit 1',(followup['message_id'] or followup['thread_id'],))
        original = cur.fetchone()
        if not original:
            raise Refused('message_not_found')
        original = dict(original)
        original['thread_id'] = followup['thread_id'] or original['thread_id']
        author,transport = policy.identity(db,followup['identity_key'] or original['identity_key'],original['purpose'])
        if args.apply:
            (driver or resolve_driver(author,transport)).preflight(author,original)
        replied = policy.thread_reply(db,original)
        if replied:
            if args.apply:
                cur.execute("update mail_followup set state='paused',paused_reason='thread_has_reply',updated_at=now() where id=%s",(args.target,))
                db.commit()
            raise Refused('thread_has_reply')
        recipients = original['to_emails'] if original['direction']=='outbound' else [original['from_email']]
        row,_ = prepare(db,author['key'],recipients,original['purpose'],args.template,json.loads(args.vars),args.subject or original['subject'],args.body,args.html,original['thread_id'],verification=original['personalization'].get('verification',{}),transport=transport)
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
