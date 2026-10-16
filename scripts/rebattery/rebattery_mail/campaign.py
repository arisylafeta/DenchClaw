"""Read-only cohorts and immutable, individually rendered campaign deliveries."""
import hashlib
import json
import re
from pathlib import Path
from urllib.parse import urlparse
from .core import connection, dict_cursor, Refused
from .draft import prepare, insert, content_flags
from .digest import digest
from . import policy
from .drivers import resolve_driver


def validate_links(row, links, auction_url=None):
    urls, keys = set(),set()
    for link in links:
        key, url = link.get('key'),link.get('url','')
        parsed = urlparse(url)
        if not isinstance(key,str) or not re.fullmatch('[a-z0-9_-]{1,40}',key) or key in keys or url in urls:
            raise Refused('invalid_tracked_link')
        if parsed.scheme != 'https' or parsed.hostname not in ('www.rebattery.io','form.typeform.com'):
            raise Refused('unapproved_destination_host')
        urls.add(url)
        keys.add(key)
    html_urls = set(re.findall(r'''href=["'](https://[^"']+)''',row['body_html']))
    text_urls = set(re.findall(r'https://[^\s<>]+',row['body_text']))
    if html_urls != urls or text_urls != urls:
        raise Refused('tracked_link_parity')
    if auction_url:
        parsed = urlparse(auction_url)
        if parsed.scheme != 'https' or not parsed.path.startswith('/marketplace/auctions/') or auction_url not in urls:
            raise Refused('invalid_auction_url')
    row['links'] = [{'cta_key':l['key'],'destination_url':l['url'],'listing_id':l.get('listing_id')} for l in links]


def cohort(db, config):
    ids = config.get('person_ids')
    if bool(ids) == bool(config.get('cohort_sql')):
        raise Refused('invalid_cohort_source')
    with dict_cursor(db) as cur:
        if not ids:
            sql = Path(config['cohort_sql']).read_text().strip()
            if not sql.lower().startswith('select ') or ';' in sql:
                raise Refused('cohort_requires_read_only_select')
            # Even SELECT functions cannot write in this separate read-only transaction.
            with connection(read_only=True) as reader, dict_cursor(reader) as select:
                select.execute("set local statement_timeout='10s'")
                select.execute(sql)
                if [c.name for c in select.description] != ['person_id']:
                    raise Refused('invalid_cohort_columns')
                ids = [r['person_id'] for r in select.fetchall()]
        if not isinstance(ids,list) or not 1 <= len(ids) <= 500 or len(set(ids)) != len(ids) or any(not isinstance(i,str) for i in ids):
            raise Refused('invalid_cohort')
        cur.execute('select id,company_id,email,first_name,last_name,opening from crm_people where id=any(%s::text[])',(ids,))
        people = {r['id']:dict(r) for r in cur.fetchall()}
    if set(ids) != set(people):
        raise Refused('unknown_person_ids')
    return [people[i] for i in sorted(ids)]


def campaign_policy(config,author):
    supply = (config.get('type')=='supply_update'
              or bool(re.match(r'(?i)supply[\s_-]*update',config['name']))
              or bool(re.match(r'(?i)supply-update',config['id'])))
    promotional = supply or config.get('type') in ('intro','newsletter','marketing','promotion')
    if promotional and config['purpose']!='marketing':
        raise Refused('campaign_purpose_mismatch','Promotional campaign types require marketing purpose')
    if supply and (author['address']!='supply@rebattery.io' or (author.get('reply_to') or author['address'])!='supply@rebattery.io'):
        raise Refused('supply_update_identity_required')
    cap = config.get('pilot_cap')
    if cap is not None and cap<1:
        raise Refused('invalid_recipient_cap')


def create(args):
    config = vars(args).copy()
    config.pop('handler',None)
    config['variables'] = json.loads(args.vars)
    config['verification'] = json.loads(args.verification)
    config['links'] = json.loads(args.links)
    config['personalization'] = json.loads(args.personalization)
    config['person_ids'] = args.person_ids.split(',') if args.person_ids else None
    if any(column not in ('first_name','last_name','opening') or not re.fullmatch('[a-z][a-z0-9_]*',key) for key,column in config['personalization'].items()):
        raise Refused('invalid_personalization')
    with connection(read_only=not args.apply) as db:
        author, transport = policy.identity(db,args.identity,args.purpose,args.transport)
        campaign_policy(config,author)
        if args.apply:
            with db.cursor() as cur:
                cur.execute("""insert into campaigns(id,campaign_name,purpose,identity_key,template_name,mail_state,notes,type)
                    values (%s,%s,%s,%s,%s,'draft',%s,%s)""",(args.id,args.name,args.purpose,args.identity,args.template,json.dumps({'mail_config':config}),args.type))
    return {'campaign_id':args.id,'mail_state':'draft','dry_run':not args.apply}


def freeze(args, driver=None):
    with connection(read_only=not args.apply) as db, dict_cursor(db) as cur:
        cur.execute('select * from campaigns where id=%s' + (' for update' if args.apply else ''),(args.target,))
        campaign = cur.fetchone()
        if not campaign or campaign['mail_state'] != 'draft':
            raise Refused('campaign_not_draft')
        config = json.loads(campaign['notes'])['mail_config']
        author, transport = policy.identity(db,config['identity'],config['purpose'],config['transport'])
        campaign_policy(config,author)
        driver = driver or resolve_driver(author,transport)
        suppressions = driver.preflight(author,{'purpose':config['purpose']})
        rows, exclusions,seen = [],[],set()
        for person in cohort(db,config):
            email = (person['email'] or '').strip().lower()
            try:
                policy.recipient(db,email,config['verification'],suppressions)
            except Refused as exc:
                exclusions.append({'person_id':person['id'],**exc.payload()})
                continue
            if email in seen:
                raise Refused('duplicate_recipient')
            seen.add(email)
            variables = dict(config['variables'])
            for key,column in config['personalization'].items():
                if person[column] is None or not str(person[column]).strip():
                    raise Refused('missing_variable',variable=key,person_id=person['id'])
                variables[key] = person[column]
            row,_ = prepare(db,config['identity'],[email],config['purpose'],config['template'],variables,config['subject'],config['body'],config['html'],campaign=args.target,verification=config['verification'],transport=transport,message_id=hashlib.sha256((args.target+'\0'+person['id']).encode()).hexdigest()[:32])
            row.update(person_id=person['id'],company_id=person['company_id'],state='frozen',listing_id=config.get('listing_id'),auction_url=config.get('auction_url'))
            row['personalization']['campaign_cap'] = config.get('pilot_cap')
            validate_links(row,config['links'],config.get('auction_url'))
            rows.append(row)
        if not rows:
            raise Refused('no_eligible_recipients',exclusions=exclusions)
        sha = digest(rows)
        if args.apply:
            for row in rows:
                insert(db,row)
            cur.execute("""update campaigns set frozen_at=now(),mail_state='frozen',audience_size=%s,
                audience=%s,notes=%s where id=%s""",(len(rows),'Frozen SHA256 '+sha,json.dumps({'mail_config':config,'frozen_sha256':sha,'exclusions':exclusions}),args.target))
    return {'campaign_id':args.target,'messages':rows,'exclusions':exclusions,'sha256':sha,'dry_run':not args.apply}


def register(subparsers):
    parser = subparsers.add_parser('campaign')
    commands = parser.add_subparsers(dest='campaign_command',required=True)
    parser = commands.add_parser('create')
    content_flags(parser)
    parser.set_defaults(purpose='marketing')
    parser.add_argument('--id',required=True)
    parser.add_argument('--name',required=True)
    parser.add_argument('--person-ids')
    parser.add_argument('--cohort-sql')
    parser.add_argument('--pilot-cap',type=int,help='Optional frozen ceiling for each explicitly approved launch')
    parser.add_argument('--links',default='[]')
    parser.add_argument('--personalization',default='{}')
    parser.add_argument('--listing-id')
    parser.add_argument('--auction-url')
    parser.add_argument('--type',default='intro')
    parser.add_argument('--apply',action='store_true')
    parser.set_defaults(handler=create)
    parser = commands.add_parser('freeze')
    parser.add_argument('target')
    parser.add_argument('--apply',action='store_true')
    parser.set_defaults(handler=freeze)
