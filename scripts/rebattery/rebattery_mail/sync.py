"""Pull provider truth into one mail log; dry-run is the default."""
from urllib.parse import quote
from urllib.error import URLError
from datetime import datetime, timedelta, timezone
from email.parser import Parser
from .core import connection, dict_cursor, Refused, ProviderError
from .gmail_sync import sync_gmail
from .ingest import ingest_postmark_event
from .crm_visibility import parse_message_ids


def postmark_rfc_identity(details):
    headers = details.get('Headers') or details.get('headers') or {}
    if isinstance(headers,list):
        headers = {item['Name'].lower():item.get('Value','') for item in headers if item.get('Name')}
    else:
        headers = {key.lower():value for key,value in headers.items()}
    value = headers.get('message-id') or details.get('Message-ID')
    if not value and details.get('RawMessage'):
        value = Parser().parsestr(details['RawMessage'],headersonly=True).get('Message-ID')
    tokens = parse_message_ids(value)
    return next(iter(tokens)) if len(tokens)==1 else None


class PostmarkClient:
    def request(self, path, method='GET', payload=None):
        from .drivers import postmark
        try:
            return postmark(path,method,payload)
        except (URLError, OSError, TimeoutError, ValueError) as exc:
            raise ProviderError('postmark_read_failed', provider='postmark', cause=type(exc).__name__) from exc

    def details(self, message_id):
        path = '/messages/outbound/'+quote(message_id,safe='')
        details = self.request(path+'/details')
        if not postmark_rfc_identity(details):
            details['RawMessage'] = self.request(path+'/dump').get('Body','')
        return details

    def suppressions(self, stream):
        from .drivers import stream_suppressions
        return stream_suppressions(stream, client=self.request)


def sync_postmark(db, campaign=None, since=None, apply=False, client=None, account=None, recent_days=None):
    from .drivers import sync_suppressions
    client = client or PostmarkClient()
    clauses = ["m.transport like 'postmark-%%'", 'm.provider_message_id is not null', "m.provider_message_id not like 'gmail:%%'"]
    params = []
    if account:
        with db.cursor() as cur:
            cur.execute('select postmark_stream from mail_identity where key=%s or address=%s order by key limit 1',(account,account))
            identity = cur.fetchone()
        if identity and not identity[0]:
            raise Refused('identity_transport_unavailable',identity=account,transport='postmark')
        account = identity[0] if identity else account
        clauses.append('i.postmark_stream=%s')
        params.append(account)
    if campaign:
        clauses.append('m.campaign_id=%s')
        params.append(campaign)
    if recent_days is not None:
        # Incremental window: recent sends, plus any send Postmark has not yet reported on, so a missed
        # delivery or bounce is retried on every run until it resolves.
        clauses.append("(coalesce(m.sent_at,m.created_at) >= now() - make_interval(days => %s) or (m.delivered_at is null and m.bounced_at is null and coalesce(m.sent_at,m.created_at) >= now() - interval '44 days'))")
        params.append(int(recent_days))
    with dict_cursor(db) as cur:
        cur.execute('select m.id,m.provider_message_id,i.postmark_stream from mail_message m left join mail_identity i on i.key=m.identity_key where '+' and '.join(clauses)+' order by m.id',params)
        messages = [dict(r) for r in cur.fetchall()]
        cur.execute('select distinct postmark_stream from mail_identity where active and postmark_stream is not null order by postmark_stream')
        streams = [r['postmark_stream'] for r in cur.fetchall()]
        if account:
            streams = [account]
    receipts, suppression_results = [],[]
    # Collect all provider reads before any writes, so a partial fetch cannot masquerade as a complete sync.
    payloads = []
    for message in messages:
        details = client.details(message['provider_message_id'])
        for event in details.get('MessageEvents',[]):
            from .ingest import TYPES
            if since and event.get('ReceivedAt'):
                event_at = datetime.fromisoformat(event['ReceivedAt'].replace('Z','+00:00'))
                since_at = datetime.fromisoformat(str(since).replace('Z','+00:00'))
                if event_at.replace(tzinfo=event_at.tzinfo or timezone.utc) < since_at.replace(tzinfo=since_at.tzinfo or timezone.utc):
                    continue
            if event.get('Type') in TYPES:
                payloads.append({**event,'MessageID':message['provider_message_id']})
        receipts.append({'message_id':message['id'],'provider_message_id':message['provider_message_id'],'rfc_message_id':postmark_rfc_identity(details),'event_count':len(details.get('MessageEvents',[]))})
    dumps = {stream:client.suppressions(stream) for stream in streams}
    for stream,dump in dumps.items():
        suppression_results.extend(sync_suppressions(stream,dump,apply,db=db))
        for email,item in sorted(dump.items()):
            payloads.append({**item,'RecordType':'Suppressed','MessageStream':stream,'Recipient':email})
            if item.get('SuppressionReason')=='ManualSuppression' and item.get('Origin')=='Recipient':
                payloads.append({**item,'RecordType':'SubscriptionChange','MessageStream':stream,'Recipient':email})
    if apply:
        with db.cursor() as cur:
            for receipt in receipts:
                cur.execute('update mail_message set rfc_message_id=coalesce(rfc_message_id,%s),last_synced_at=now() where id=%s',(receipt['rfc_message_id'],receipt['message_id']))
    results = [ingest_postmark_event(db,payload,apply=apply) for payload in payloads]
    inserted_events = len({event_id for result in results for event_id in result.get('event_ids',[])})
    return {'dry_run':not apply,'receipts':receipts,'suppressions':suppression_results,'event_count':len(payloads),'inserted_events':inserted_events}


def sync_health(db, postmark_max_age_hours=1, gmail_max_age_hours=6):
    """Read-only freshness report. `problems` is empty when every provider sync is current.

    Postmark is stale when a send from the last 3 days was not re-read recently. A send Postmark
    has not reported on after 2 hours is unreconciled. Gmail is stale when no message has been
    touched by a Gmail sync lately. A send row in `sending` or `unknown` blocks launches."""
    with dict_cursor(db) as cur:
        cur.execute("""
            select
              (select max(occurred_at) from mail_event where source='postmark') as last_postmark_event,
              (select count(*) from mail_message where transport like 'postmark-%%' and provider_message_id not like 'gmail:%%'
                 and coalesce(sent_at,created_at) >= now() - interval '3 days'
                 and (last_synced_at is null or last_synced_at < now() - make_interval(hours => %s))) as postmark_stale,
              (select count(*) from mail_message where transport like 'postmark-%%' and provider_message_id not like 'gmail:%%'
                 and delivered_at is null and bounced_at is null
                 and coalesce(sent_at,created_at) between now() - interval '44 days' and now() - interval '2 hours') as postmark_unreconciled,
              (select max(last_synced_at) from mail_message where transport='gmail') as last_gmail_sync,
              (select count(*) from mail_message where direction='outbound' and state in ('sending','unknown')) as stuck_sends,
              now() as checked_at
        """,(postmark_max_age_hours,))
        row = dict(cur.fetchone())
    problems = []
    if row['postmark_stale']:
        problems.append('postmark_sync_stale: %d recent sends not re-read in the last %dh' % (row['postmark_stale'],postmark_max_age_hours))
    if row['postmark_unreconciled']:
        problems.append('postmark_unreconciled: %d sends with no delivery or bounce report after 2h' % row['postmark_unreconciled'])
    gmail = row['last_gmail_sync']
    if gmail is None or (row['checked_at']-gmail).total_seconds() > gmail_max_age_hours*3600:
        problems.append('gmail_sync_stale: last Gmail sync %s' % (gmail.isoformat() if gmail else 'never'))
    if row['stuck_sends']:
        problems.append('stuck_sends: %d outbound rows in sending/unknown' % row['stuck_sends'])
    return {'healthy':not problems,'problems':problems,'last_postmark_event':row['last_postmark_event'],'last_gmail_sync':gmail,
            'postmark_unreconciled':row['postmark_unreconciled'],'checked_at':row['checked_at']}

def sync_postmark_suppressions(db, stream, apply=False, client=None):
    """Reconcile one Broadcast dump without reading or changing message receipts."""
    from .drivers import stream_suppressions, sync_suppressions
    if not isinstance(stream,str) or not stream.strip() or stream == 'outbound':
        raise Refused('postmark_broadcast_stream_required')
    client = client or PostmarkClient()
    suppressions = stream_suppressions(stream,client=client.request,required_type='Broadcasts')
    return {'dry_run':not apply,'stream':stream,'list':'Supply update',
            'suppressions':sync_suppressions(stream,suppressions,apply,db=db)}

def recheck_thread(thread_id, account, driver=None):
    with connection() as db:
        # References and Postmark-origin replies may cross Gmail threads, and
        # accepted sends may not have any provider thread linkage yet. The refresh must stay
        # bounded: an unbounded `in:anywhere` sync of a whole mailbox can run for many minutes
        # inside a send preflight. Look back from just before the thread's first message.
        since = None
        if thread_id:
            with db.cursor() as cur:
                cur.execute("select min(coalesce(sent_at,created_at)) - interval '1 day' from mail_message where thread_id=%s",(thread_id,))
                first = cur.fetchone()[0]
            since = first.strftime('%Y/%m/%d') if first else None
        if since is None:
            since = (datetime.now(timezone.utc) - timedelta(days=30)).strftime('%Y/%m/%d')
        result = sync_gmail(db,account,since=since,apply=True,driver=driver,skip_known=True)
        if thread_id is None:
            return bool(result['counts']['replies'])
        with db.cursor() as cur:
            cur.execute("select exists(select 1 from mail_message where thread_id=%s and direction='inbound')",(thread_id,))
            return cur.fetchone()[0]


def handle(args):
    with connection(read_only=not args.apply) as db:
        if args.provider == 'postmark-suppressions':
            return sync_postmark_suppressions(db,args.stream,args.apply)
        if args.provider == 'health':
            return sync_health(db)
        if args.provider == 'postmark':
            return sync_postmark(db,args.campaign,args.since,args.apply,account=args.account,recent_days=args.recent_days)
        if args.account:
            accounts = [args.account]
        else:
            with db.cursor() as cur:
                cur.execute('select distinct gmail_account from mail_identity where active and gmail_account is not null order by gmail_account')
                accounts = [r[0] for r in cur.fetchall()]
        return {'dry_run':not args.apply,'accounts':[sync_gmail(db,account,args.since,args.apply) for account in accounts]}


def register(subparsers):
    providers = subparsers.add_parser('sync').add_subparsers(dest='provider',required=True)
    parser = providers.add_parser('postmark-suppressions')
    parser.add_argument('--stream',required=True)
    parser.add_argument('--apply',action='store_true')
    parser.set_defaults(handler=handle)
    parser = providers.add_parser('health',help='Read-only report of how current the Postmark and Gmail syncs are')
    parser.set_defaults(handler=handle,apply=False)
    for name in ('gmail','postmark'):
        parser = providers.add_parser(name)
        parser.add_argument('--account')
        parser.add_argument('--campaign')
        parser.add_argument('--since')
        if name == 'postmark':
            parser.add_argument('--recent-days',type=int,help='Only re-read sends from the last N days, plus sends Postmark has not yet reported on')
        parser.add_argument('--apply',action='store_true')
        parser.set_defaults(handler=handle)
