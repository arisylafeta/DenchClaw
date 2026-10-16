"""Pull provider truth into one mail log; dry-run is the default."""
from urllib.parse import quote
from urllib.error import URLError
from datetime import datetime, timezone
from .core import connection, dict_cursor, Refused, ProviderError
from .gmail_sync import sync_gmail
from .ingest import ingest_postmark_event


class PostmarkClient:
    def request(self, path, method='GET', payload=None):
        from .drivers import postmark
        try:
            return postmark(path,method,payload)
        except (URLError, OSError, TimeoutError, ValueError) as exc:
            raise ProviderError('postmark_read_failed', provider='postmark', cause=type(exc).__name__) from exc

    def details(self, message_id):
        return self.request('/messages/outbound/'+quote(message_id,safe='')+'/details')

    def suppressions(self, stream):
        from .drivers import stream_suppressions
        return stream_suppressions(stream, client=self.request)


def sync_postmark(db, campaign=None, since=None, apply=False, client=None, account=None):
    from .drivers import sync_suppressions
    client = client or PostmarkClient()
    clauses = ["m.transport like 'postmark-%%'", 'm.provider_message_id is not null']
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
        receipts.append({'message_id':message['id'],'provider_message_id':message['provider_message_id'],'event_count':len(details.get('MessageEvents',[]))})
    dumps = {stream:client.suppressions(stream) for stream in streams}
    for stream,dump in dumps.items():
        suppression_results.extend(sync_suppressions(stream,dump,apply,db=db))
        for email,item in sorted(dump.items()):
            payloads.append({**item,'RecordType':'Suppressed','MessageStream':stream,'Recipient':email})
            if item.get('SuppressionReason')=='ManualSuppression' and item.get('Origin')=='Recipient':
                payloads.append({**item,'RecordType':'SubscriptionChange','MessageStream':stream,'Recipient':email})
    results = [ingest_postmark_event(db,payload,apply=apply) for payload in payloads]
    inserted_events = len({event_id for result in results for event_id in result.get('event_ids',[])})
    return {'dry_run':not apply,'receipts':receipts,'suppressions':suppression_results,'event_count':len(payloads),'inserted_events':inserted_events}

def recheck_thread(thread_id, account, driver=None):
    with connection() as db:
        with db.cursor() as cur:
            cur.execute('select gmail_thread_id from mail_thread where id=%s',(thread_id,))
            row = cur.fetchone()
        if not row or not row[0]:
            # Postmark-origin replies arrive in other Gmail threads: refresh the mailbox.
            sync_gmail(db,account,apply=True,driver=driver)
        else:
            sync_gmail(db,account,apply=True,driver=driver,thread_id=row[0])
        with db.cursor() as cur:
            cur.execute("select exists(select 1 from mail_message where thread_id=%s and direction='inbound')",(thread_id,))
            return cur.fetchone()[0]


def handle(args):
    with connection(read_only=not args.apply) as db:
        if args.provider == 'postmark':
            return sync_postmark(db,args.campaign,args.since,args.apply,account=args.account)
        if args.account:
            accounts = [args.account]
        else:
            with db.cursor() as cur:
                cur.execute('select distinct gmail_account from mail_identity where active and gmail_account is not null order by gmail_account')
                accounts = [r[0] for r in cur.fetchall()]
        return {'dry_run':not args.apply,'accounts':[sync_gmail(db,account,args.since,args.apply) for account in accounts]}


def register(subparsers):
    providers = subparsers.add_parser('sync').add_subparsers(dest='provider',required=True)
    for name in ('gmail','postmark'):
        parser = providers.add_parser(name)
        parser.add_argument('--account')
        parser.add_argument('--campaign')
        parser.add_argument('--since')
        parser.add_argument('--apply',action='store_true')
        parser.set_defaults(handler=handle)
