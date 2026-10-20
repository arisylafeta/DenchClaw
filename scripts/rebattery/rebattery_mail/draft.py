"""Prepare and preview exact outbound copy without submitting to providers."""
import html as html_lib
import json
import re
from uuid import uuid4
from .core import connection, dict_cursor, Refused, UsageError, PURPOSES
from . import policy
from .templating import render_message as _render_message
from .templating import compose, template_variables
from .digest import digest, load


def render_message(row, variables):
    try:
        return _render_message(row, variables)
    except Refused as exc:
        if exc.rule == 'unresolved_merge_token':
            raise Refused('literal_merge_token') from exc
        raise


def text_to_html(text):
    """Escaped HTML paragraphs for a plain-text body, so a text-only draft never ships a signature-only HTML part."""
    paragraphs = [chunk for chunk in re.split(r'\n\s*\n', text.strip()) if chunk.strip()]
    return ''.join('<p style="margin:0 0 14px;font-size:15px;line-height:1.6;">' + html_lib.escape(chunk.strip(), quote=True).replace('\n', '<br>\n') + '</p>\n'
                   for chunk in paragraphs)


def prepare(db, identity_key, recipients, purpose='personal', template=None, variables=None,
            subject=None, body=None, html=None, thread=None, campaign=None, verification=None, transport=None, message_id=None,
            oneoff_blocks=None, allow_multiple_cta=False):
    author, transport = policy.identity(db,identity_key,purpose,transport)
    variables = variables or {}
    generated = None
    if oneoff_blocks is not None:
        from .blocks import compose_blocks, oneoff_template
        if template or body is not None or html is not None:
            raise Refused('conflicting_oneoff_content')
        if not subject:
            raise Refused('missing_oneoff_subject')
        generated = compose_blocks(oneoff_blocks, identity_key, allow_multiple_cta)
        tpl = oneoff_template(generated, subject, identity_key, purpose)
        rendered = compose(tpl, variables, author, purpose, transport)
    elif template:
        with dict_cursor(db) as cur:
            cur.execute('select * from mail_template where name=%s order by version desc limit 1',(template,))
            tpl = cur.fetchone()
        if not tpl:
            raise Refused('template_not_found')
        rendered = compose(tpl, variables, author, purpose, transport)
        meta = tpl.get('meta') or {}
        if 'source_body_html' in meta:
            values = template_variables(tpl, variables)
            values.update(signature_html='', signature_text='', unsubscribe_html='', unsubscribe_text='', preview=variables.get('preview', ''))
            campaign_body = render_message({'html': meta['source_body_html'], 'text_body': meta['source_body_text']}, values)
    else:
        if subject is None or body is None:
            raise Refused('missing_variable', 'Provide a template or subject and body')
        rendered = render_message({'subject':subject,'html':html or '', 'text_body':body,'required_variables':[]},variables)
        if not rendered['html'].strip():
            rendered['html'] = text_to_html(rendered['text'])
    row = {'id':message_id or uuid4().hex,'direction':'outbound','state':'draft','identity_key':identity_key,
           'from_email':author['address'],'transport':transport,'purpose':purpose,'to_emails':sorted(set(e.strip().lower() for e in recipients)),
           'cc_emails':[],'bcc_emails':[],'recipient_email':recipients[0].strip().lower() if len(recipients)==1 else None,
           'subject':rendered['subject'],'body_text':rendered['text'] + ('\n\n'+author['signature_text'] if not template and generated is None and author.get('signature_text') else ''),
           'body_html':rendered['html'] + ((author.get('signature_html') or '') if not template and generated is None else ''),'thread_id':thread,'campaign_id':campaign,
           'personalization':{'variables':variables,'verification':verification or {},
                              'identity_snapshot':{key:author.get(key) for key in ('address','display_name','reply_to','gmail_account','postmark_stream')}},'links':[]}
    if generated is not None:
        row['personalization']['oneoff'] = {'warnings': generated['warnings'], 'variables_used': generated['variables_used']}
    if template and 'source_body_html' in (tpl.get('meta') or {}):
        row['personalization']['template_link_scope'] = campaign_body
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
        from .blocks import read_blocks
        blocks = read_blocks(args.oneoff_blocks) if getattr(args, 'oneoff_blocks', None) is not None else None
        row, author = prepare(db,args.identity,args.to.split(','),args.purpose,args.template,json.loads(args.vars),args.subject,args.body,args.html,args.thread,args.campaign,json.loads(args.verification),args.transport,args.id,
                              oneoff_blocks=blocks, allow_multiple_cta=getattr(args, 'allow_multiple_cta', False))
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


def _strip_unsubscribe(text, html):
    text = re.sub(r'(?m)^Unsubscribe: \S+\n*', '', text or '')
    html = re.sub(r'<p><a href="[^"]*">Unsubscribe</a></p>', '', html or '')
    return text.replace(policy.UNSUBSCRIBE, ''), html.replace(policy.UNSUBSCRIBE, '')


def edit(args):
    """Change an unsent draft in place. Switching away from marketing drops the unsubscribe footer."""
    changes = {k: getattr(args, k) for k in ('purpose', 'subject', 'body', 'html') if getattr(args, k, None) is not None}
    if not changes:
        raise UsageError('nothing_to_edit')
    with connection() as db:
        with dict_cursor(db) as cur:
            cur.execute("select * from mail_message where id=%s and state='draft' and idempotency_key is null for update", (args.target,))
            row = cur.fetchone()
            if not row:
                raise Refused('draft_not_editable', message_id=args.target)
            row = dict(row)
            text, html = row['body_text'] or '', row['body_html'] or ''
            purpose = changes.get('purpose', row['purpose'])
            if purpose != row['purpose']:
                if purpose == 'marketing':
                    raise Refused('use_new_draft_for_marketing')
                policy.identity(db, row['identity_key'], purpose, row['transport'])
                if row['purpose'] == 'marketing':
                    text, html = _strip_unsubscribe(text, html)
            if 'body' in changes and 'html' not in changes and html:
                raise Refused('html_required_with_body', 'Pass --html too so both versions carry the new copy')
            text, html = changes.get('body', text), changes.get('html', html)
            row.update(purpose=purpose, subject=changes.get('subject', row['subject']), body_text=text, body_html=html)
            policy.content(row)
            cur.execute('update mail_message set purpose=%s,subject=%s,body_text=%s,body_html=%s,updated_at=now() where id=%s',
                        (row['purpose'], row['subject'], row['body_text'], row['body_html'], args.target))
    with connection(read_only=True) as db:
        _, rows = load(db, args.target)
    return {'message': rows[0], 'sha256': digest(rows)}


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
    parser.add_argument('--oneoff-blocks', help='Semantic block JSON or @file; uses the catalogue shell and policy-owned signature')
    parser.add_argument('--allow-multiple-cta', action='store_true')
    parser.add_argument('--to',required=True)
    parser.add_argument('--id')
    parser.add_argument('--thread')
    parser.add_argument('--campaign')
    parser.add_argument('--apply',action='store_true')
    parser.set_defaults(handler=create)
    parser = subparsers.add_parser('edit')
    parser.add_argument('target')
    parser.add_argument('--purpose', choices=PURPOSES)
    parser.add_argument('--subject')
    parser.add_argument('--body')
    parser.add_argument('--html')
    parser.set_defaults(handler=edit)
    parser = subparsers.add_parser('preview')
    parser.add_argument('target')
    parser.set_defaults(handler=preview)
