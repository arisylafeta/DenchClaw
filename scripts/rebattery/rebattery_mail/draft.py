"""Prepare and preview exact outbound copy without submitting to providers."""
import json
from uuid import uuid4
from .core import connection, dict_cursor, Refused, PURPOSES
from . import policy
from .templating import render_message as _render_message
from .digest import digest, load


def render_message(row, variables):
    try:
        return _render_message(row, variables)
    except Refused as exc:
        if exc.rule == 'unresolved_merge_token':
            raise Refused('literal_merge_token') from exc
        raise


def prepare(db, identity_key, recipients, purpose='personal', template=None, variables=None,
            subject=None, body=None, html=None, thread=None, campaign=None, verification=None, transport=None, message_id=None):
    author, transport = policy.identity(db,identity_key,purpose,transport)
    variables = variables or {}
    if template:
        with dict_cursor(db) as cur:
            cur.execute('select * from mail_template where name=%s order by version desc limit 1',(template,))
            tpl = cur.fetchone()
        if not tpl:
            raise Refused('template_not_found')
        if purpose not in tpl['allowed_purposes'] or (tpl['allowed_identities'] and identity_key not in tpl['allowed_identities']):
            raise Refused('purpose_not_allowed_for_identity')
        rendered = render_message(tpl,variables)
    else:
        if subject is None or body is None:
            raise Refused('missing_variable', 'Provide a template or subject and body')
        rendered = render_message({'subject':subject,'html':html or '', 'text_body':body,'required_variables':[]},variables)
    row = {'id':message_id or uuid4().hex,'direction':'outbound','state':'draft','identity_key':identity_key,
           'from_email':author['address'],'transport':transport,'purpose':purpose,'to_emails':sorted(set(e.strip().lower() for e in recipients)),
           'cc_emails':[],'bcc_emails':[],'recipient_email':recipients[0].strip().lower() if len(recipients)==1 else None,
           'subject':rendered['subject'],'body_text':rendered['text'] + ('\n\n'+author['signature_text'] if author.get('signature_text') else ''),
           'body_html':rendered['html'] + (author.get('signature_html') or ''),'thread_id':thread,'campaign_id':campaign,
           'personalization':{'variables':variables,'verification':verification or {},
                              'identity_snapshot':{key:author.get(key) for key in ('address','display_name','reply_to','gmail_account','postmark_stream')}},'links':[]}
    if not row['to_emails']:
        raise Refused('recipient_unverified')
    if thread:
        with dict_cursor(db) as cur:
            cur.execute("select * from mail_message where thread_id=%s and state in ('received','accepted') order by coalesce(sent_at,created_at) desc limit 1",(thread,))
            previous = cur.fetchone()
            if not previous:
                raise Refused('thread_not_found')
            row['in_reply_to'] = previous['rfc_message_id']
            row['rfc_references'] = ' '.join(filter(None,[previous['rfc_references'],previous['rfc_message_id']]))
            row['personalization']['reply_gmail_message_id'] = previous['gmail_message_id']
    policy.content(row)
    return row, author


def insert(db,row):
    columns = [k for k in row if k not in ('links','gmail_thread_id','created_at')]
    values = [json.dumps(row[k]) if k=='personalization' else row[k] for k in columns]
    with db.cursor() as cur:
        cur.execute('insert into mail_message ('+','.join(columns)+') values ('+','.join(['%s']*len(columns))+') on conflict do nothing', values)
        if cur.rowcount != 1:
            raise Refused('duplicate_idempotency_key',message_id=row['id'])
        for link in row.get('links',[]):
            cur.execute('insert into mail_message_link(id,message_id,cta_key,destination_url,listing_id) values (%s,%s,%s,%s,%s)',(uuid4().hex,row['id'],link['cta_key'],link['destination_url'],link.get('listing_id')))


def create(args):
    with connection(read_only=not args.apply) as db:
        row, author = prepare(db,args.identity,args.to.split(','),args.purpose,args.template,json.loads(args.vars),args.subject,args.body,args.html,args.thread,args.campaign,json.loads(args.verification),args.transport,args.id)
        exclusions = []
        for email in row['to_emails']:
            try:
                policy.recipient(db,email,row['personalization']['verification'])
            except Refused as exc:
                exclusions.append(exc.payload())
        if args.apply:
            insert(db,row)
    return {'message':row,'signature':{'text':author['signature_text'],'html':author['signature_html']},'recipients':row['to_emails'],'exclusions':exclusions,'sha256':digest([row]),'dry_run':not args.apply}


def preview(args):
    with connection(read_only=True) as db:
        campaign, rows = load(db,args.target)
        author,_ = policy.identity(db,rows[0]['identity_key'],rows[0]['purpose'],rows[0]['transport'])
        exclusions = []
        for row in rows:
            policy.content(row)
            for email in row['to_emails']:
                try:
                    policy.recipient(db,email,row['personalization'].get('verification',{}))
                except Refused as exc:
                    exclusions.append(exc.payload())
    return {'subject_id':args.target,'messages':rows,'recipients':[e for r in rows for e in r['to_emails']], 'signature':{'text':author['signature_text'],'html':author['signature_html']},'exclusions':exclusions,'sha256':digest(rows),'dry_run':True}


def content_flags(parser):
    parser.add_argument('--identity',required=True)
    parser.add_argument('--purpose',choices=PURPOSES,default='personal')
    parser.add_argument('--transport',choices=('gmail','postmark-broadcast','postmark-transactional'))
    parser.add_argument('--template')
    parser.add_argument('--vars',default='{}')
    parser.add_argument('--subject')
    parser.add_argument('--body')
    parser.add_argument('--html')
    parser.add_argument('--verification',default='{}',help='JSON address to ZeroBounce result mapping; only valid results are eligible')


def register(subparsers):
    parser = subparsers.add_parser('draft')
    content_flags(parser)
    parser.add_argument('--to',required=True)
    parser.add_argument('--id')
    parser.add_argument('--thread')
    parser.add_argument('--campaign')
    parser.add_argument('--apply',action='store_true')
    parser.set_defaults(handler=create)
    parser = subparsers.add_parser('preview')
    parser.add_argument('target')
    parser.set_defaults(handler=preview)
