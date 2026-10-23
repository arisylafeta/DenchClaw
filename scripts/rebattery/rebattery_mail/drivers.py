"""Provider boundaries. No provider submission without the explicit live-send gate."""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from contextlib import nullcontext
from datetime import datetime
from email.utils import getaddresses
from .core import Refused, ProviderError, UnknownOutcome, connection, dict_cursor, gog_env


def live_gate():
    if os.environ.get('DENCH_MAIL_LIVE_SEND') != '1':
        raise Refused('live_send_disabled')


HERMES_PYTHON = '/usr/local/lib/hermes-agent/venv/bin/python3'
_SECRET_MARKER = 'REBATTERY_MAIL_SECRET='
_SECRET_CODE = (
    "import sys\n"
    "sys.path.insert(0, '/usr/local/lib/hermes-agent')\n"
    "import hermes_bootstrap\n"
    "from hermes_cli.env_loader import load_hermes_dotenv\n"
    "from agent.secret_scope import get_secret\n"
    "load_hermes_dotenv(hermes_home='/root/.hermes')\n"
    "print('" + _SECRET_MARKER + "' + (get_secret(sys.argv[1]) or ''))\n"
)


_SECRET_CACHE = {}


def hermes_secret(name):
    """Read one approved secret through the Hermes secret loader in Hermes' own interpreter.

    Importing the loader in this process re-executes the script into the Hermes Python, which lacks
    psycopg2, so the loader runs in a subprocess and only the value is returned. Never logged.
    Successful lookups are cached for the life of the process (a lookup costs ~2.5 s); failures are not."""
    if name in _SECRET_CACHE:
        return _SECRET_CACHE[name]
    try:
        result = subprocess.run([HERMES_PYTHON, '-c', _SECRET_CODE, name], capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.TimeoutExpired):
        return None
    for line in result.stdout.splitlines():
        if line.startswith(_SECRET_MARKER):
            value = line[len(_SECRET_MARKER):].strip() or None
            if value:
                _SECRET_CACHE[name] = value
            return value
    return None


def postmark(path, method='GET', payload=None):
    if method != 'GET':
        live_gate()
    token = os.environ.get('POSTMARK_SERVER_TOKEN')
    if not token:
        token = hermes_secret('POSTMARK_SERVER_TOKEN')
    if not token:
        raise ProviderError('postmark_credentials_missing')
    request = urllib.request.Request('https://api.postmarkapp.com' + path,
        data=json.dumps(payload).encode() if payload is not None else None, method=method,
        headers={'X-Postmark-Server-Token': token, 'Accept': 'application/json', 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def stream_suppressions(stream, client=None, required_type=None):
    client = client or postmark
    path = '/message-streams/' + urllib.parse.quote(stream, safe='')
    details = client(path)
    if details.get('ArchivedAt') or details.get('MessageStreamType') not in ('Broadcasts', 'Transactional'):
        raise Refused('postmark_stream_unavailable')
    if required_type and details.get('MessageStreamType') != required_type:
        raise Refused('postmark_stream_type_mismatch', required_type=required_type)
    if details.get('MessageStreamType') == 'Broadcasts' and details.get('SubscriptionManagementConfiguration', {}).get('UnsubscribeHandlingType', 'none').lower() == 'none':
        raise Refused('marketing_requires_unsubscribe')
    dump = client(path + '/suppressions/dump')
    if not isinstance(dump, dict) or not isinstance(dump.get('Suppressions'), list):
        raise ProviderError('incomplete_suppression_dump')
    result = {}
    for item in dump['Suppressions']:
        if not isinstance(item, dict) or any(not isinstance(item.get(k), str) or not item[k].strip() for k in ('EmailAddress', 'SuppressionReason', 'Origin', 'CreatedAt')):
            raise ProviderError('incomplete_suppression_record')
        address = item['EmailAddress'].strip().lower()
        try:
            since = datetime.fromisoformat(item['CreatedAt'].replace('Z', '+00:00')).date()
        except ValueError as exc:
            raise ProviderError('invalid_suppression_date') from exc
        if '@' not in address or address in result:
            raise ProviderError('invalid_suppression_address')
        result[address] = {**item, 'since': since}
    return result


def sync_suppressions(stream, suppressions, apply, db=None):
    results = []
    with (nullcontext(db) if db is not None else connection(read_only=not apply)) as db, dict_cursor(db) as cur:
        cur.execute('select id, lower(trim(email)) as email from crm_people where lower(trim(email))=any(%s::text[])', (list(suppressions),))
        people = {}
        for person in cur.fetchall():
            people.setdefault(person['email'], []).append(person['id'])
        for email, item in sorted(suppressions.items()):
            ids = sorted(people.get(email, []))
            global_out = item['SuppressionReason'] in ('SpamComplaint', 'HardBounce')
            how = f"Postmark stream={stream}; reason={item['SuppressionReason']}; origin={item['Origin']}"
            results.append({'email': email, 'person_ids': ids, 'reason': item['SuppressionReason'], 'origin': item['Origin'], 'since': item['since'], 'global_opt_out': global_out, 'matched': bool(ids)})
            if apply:
                from .suppression import record_suppression
                record_suppression(db,email,item['SuppressionReason'],'postmark',stream,item['CreatedAt'],item)
                for person_id in ids:
                    cur.execute("""insert into crm_subscriptions(person_id,list,status,since,how) values (%s,'Supply update','Opted out',%s,%s)
                        on conflict(person_id,list) do update set status='Opted out',since=excluded.since,how=excluded.how,updated_at=now()
                        where (crm_subscriptions.status,crm_subscriptions.since,crm_subscriptions.how) is distinct from (excluded.status,excluded.since,excluded.how)""", (person_id,item['since'],how))
                    if global_out:
                        cur.execute('update crm_people set email_opted_out=true,updated_at=now() where id=%s and not coalesce(email_opted_out,false)', (person_id,))
    return results


class GmailSendDriver:
    def __init__(self, runner=None, gmail_no_send=False, reader=None):
        self.runner = runner or subprocess.run
        self.gmail_no_send = gmail_no_send
        self.reader = reader

    def preflight(self, identity, message):
        if self.gmail_no_send or os.environ.get('GOG_GMAIL_NO_SEND') == '1':
            raise Refused('live_send_disabled')
        if self.runner is subprocess.run and identity.get('gmail_account'):
            # Prove keyring and token work before any claim, so a credential problem is a clean refusal, not an unknown send.
            try:
                check = subprocess.run(['gog','--account',identity['gmail_account'],'gmail','messages','search','in:sent','--max','1','--json','--no-input'],
                                       capture_output=True, text=True, timeout=30, env=gog_env())
            except (OSError, subprocess.TimeoutExpired) as exc:
                raise ProviderError('gmail_auth_unavailable', cause=type(exc).__name__) from exc
            if check.returncode:
                raise ProviderError('gmail_auth_unavailable', returncode=check.returncode)
        return {}

    def send(self, identity, message):
        live_gate()
        if self.gmail_no_send or os.environ.get('GOG_GMAIL_NO_SEND') == '1':
            raise Refused('live_send_disabled')
        args = ['gog','--account',identity['gmail_account'],'--json','gmail','send','--from',identity['address'],
                '--to',','.join(message['to_emails']),'--subject',message['subject'],'--body',message['body_text'] or '']
        if message.get('cc_emails'):
            args += ['--cc',','.join(message['cc_emails'])]
        if identity.get('reply_to'):
            args += ['--reply-to',identity['reply_to']]
        if message.get('body_html'):
            args += ['--body-html',message['body_html']]
        anchor = message.get('personalization', {}).get('reply_gmail_message_id')
        if message.get('thread_id') or anchor:
            if not anchor:
                raise Refused('gmail_reply_anchor_missing')
            # gog resolves the Gmail message and derives In-Reply-To/References and the thread from its RFC
            # headers. It rejects --thread-id together with --reply-to-message-id, so send only the anchor.
            args += ['--reply-to-message-id',anchor]
        elif message.get('gmail_thread_id'):
            args += ['--thread-id',message['gmail_thread_id']]
        try:
            response = self.runner(args, capture_output=True, text=True, timeout=30, env=gog_env())
            if response.returncode == 2:
                # gog exit code 2 is a usage error raised before any API call: nothing was submitted.
                raise ProviderError('gmail_send_rejected', returncode=2)
            if response.returncode:
                raise UnknownOutcome('gmail_send_uncertain')
            payload = json.loads(response.stdout)
            message_id = payload.get('id') or payload.get('messageId')
            if not message_id:
                raise UnknownOutcome('gmail_send_missing_receipt')
            return {'gmail_message_id':message_id,'provider_message_id':None}
        except (OSError,TimeoutError,subprocess.TimeoutExpired,ValueError) as exc:
            raise UnknownOutcome('gmail_send_uncertain') from exc

    def recover(self, identity, message):
        from .gmail_driver import GmailDriver
        reader = self.reader or GmailDriver()
        candidates = {item.get('gmail_message_id') for item in message.get('recovery_receipts',[])}
        if message.get('gmail_message_id'):
            candidates.add(message['gmail_message_id'])
        expected = {address.strip().lower() for key in ('to_emails','cc_emails','bcc_emails') for address in message.get(key,[])}
        matches = []
        for candidate in sorted(value for value in candidates if value):
            full = reader.fetch(identity['gmail_account'],candidate)
            raw = full.get('message',{})
            headers = {key.lower().replace('_','-'):value for key,value in full.get('headers',{}).items()}
            recipients = {address.lower() for _,address in getaddresses([headers[key] for key in ('to','cc','bcc') if headers.get(key)]) if address}
            senders = {address.lower() for _,address in getaddresses([headers.get('from','')])}
            if raw.get('id') == candidate and recipients == expected and identity['address'].lower() in senders:
                matches.append({'gmail_message_id':candidate,'provider_message_id':None,'rfc_message_id':headers.get('message-id')})
        return matches[0] if len(matches)==1 else None


class PostmarkSendDriver:
    def __init__(self, client=None):
        self.client = client or postmark

    def preflight(self, identity, message):
        stream = identity.get('postmark_stream')
        if message['purpose'] == 'marketing' and stream == 'outbound':
            raise Refused('postmark_broadcast_stream_required')
        required = 'Broadcasts' if message['purpose'] == 'marketing' or message.get('transport') == 'postmark-broadcast' else 'Transactional'
        return stream_suppressions(stream, self.client, required_type=required)

    def send(self, identity, message):
        live_gate()
        payload = {'From':f"{identity['display_name']} <{identity['address']}>", 'ReplyTo':identity.get('reply_to') or identity['address'],
                   'To':','.join(message['to_emails']), 'Subject':message['subject'],'HtmlBody':message['body_html'],
                   'TextBody':message['body_text'],'MessageStream':identity['postmark_stream'],
                   'TrackOpens':True,'TrackLinks':'HtmlAndText','Metadata':{'recipient_id':message['id'],'campaign_id':message.get('campaign_id') or '', 'idempotency_key':message['idempotency_key']}}
        if message.get('bcc_emails'):
            payload['Bcc'] = ','.join(message['bcc_emails'])
        if message.get('campaign_id'):
            payload['Tag'] = message['campaign_id']
        headers = [{'Name':name,'Value':message[key]} for name,key in (('In-Reply-To','in_reply_to'),('References','rfc_references')) if message.get(key)]
        if headers:
            payload['Headers'] = headers
        try:
            response = self.client('/email','POST',payload)
        except urllib.error.HTTPError as exc:
            if 400 <= exc.code < 500:
                raise ProviderError('postmark_rejected', status=exc.code) from exc
            raise UnknownOutcome('postmark_send_uncertain') from exc
        except (urllib.error.URLError,TimeoutError,OSError) as exc:
            raise UnknownOutcome('postmark_send_uncertain') from exc
        if response.get('ErrorCode') != 0:
            raise ProviderError('postmark_rejected', code=response.get('ErrorCode'))
        if not response.get('MessageID'):
            raise UnknownOutcome('postmark_send_missing_receipt')
        return {'provider_message_id':response['MessageID'],'gmail_message_id':None}

    def recover(self, identity, message):
        params = urllib.parse.urlencode({'count':100,'offset':0,'messagestream':identity['postmark_stream'],'metadata_recipient_id':message['id']})
        found = self.client('/messages/outbound?' + params).get('Messages', [])
        expected = {address.strip().lower() for address in message['to_emails']}
        matches = [m for m in found if m.get('MessageID') and m.get('Metadata',{}).get('recipient_id') == message['id']
                   and {address.strip().lower() for address in m.get('Recipients',[])} == expected]
        return {'provider_message_id':matches[0]['MessageID'],'gmail_message_id':None} if len(matches) == 1 else None


def resolve_driver(identity, transport):
    return GmailSendDriver() if transport == 'gmail' else PostmarkSendDriver()
