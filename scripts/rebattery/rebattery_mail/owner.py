"""Thread ownership: which Hermes agent owns an email thread and its follow-ups, and waking it when mail arrives.

Agents call these commands; the caller is the Hermes profile and session the command runs in
(HERMES_SESSION_PROFILE / HERMES_SESSION_ID). Mutations are dry-run unless --apply.

Rules for agents: claim an unowned thread for yourself, hand off or clear only threads you own. Router profiles
(MAIL_OWNER_ROUTERS, default mailvin and default) may assign any thread and manage routing rules. A run without a Hermes
profile (cron, an operator shell) acts as 'operator' with router rights.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import urllib.request
from datetime import datetime, timedelta, timezone

from .core import Refused, UsageError, connection, dict_cursor

PROFILE_RE = re.compile(r'^[a-z0-9][a-z0-9_-]{0,63}$')
KINDS = ('tag', 'sender', 'person', 'company', 'domain', 'mailbox')
OWN_DOMAIN = 'rebattery.io'
API_BASE = os.environ.get('HERMES_API_BASE', 'http://127.0.0.1:8642')
ENV_FILE = '/root/.hermes/.env'


def actor():
    """(profile, session_id) of the calling agent, or ('operator', None) outside an agent session."""
    profile = os.environ.get('HERMES_SESSION_PROFILE') or ''
    if not profile:
        home = os.environ.get('HERMES_HOME') or ''
        if '/profiles/' in home:
            profile = home.rstrip('/').rsplit('/', 1)[-1]
    return (profile, os.environ.get('HERMES_SESSION_ID') or None) if profile else ('operator', None)


def routers():
    return {p.strip() for p in os.environ.get('MAIL_OWNER_ROUTERS', 'mailvin,default').split(',') if p.strip()} | {'operator'}


def check_profile(profile):
    if not profile or not PROFILE_RE.match(profile):
        raise UsageError('invalid_profile', f'Not a Hermes profile name: {profile!r}')
    return profile


def resolve_thread(cur, ref):
    """A mail_thread id, or a Gmail thread id when it is unique across mailboxes."""
    cur.execute('select id, subject, gmail_thread_id from mail_thread where id=%s', (ref,))
    row = cur.fetchone()
    if row:
        return row
    cur.execute('select id, subject, gmail_thread_id from mail_thread where gmail_thread_id=%s', (ref,))
    rows = cur.fetchall()
    if len(rows) > 1:
        raise Refused('thread_ambiguous', 'That Gmail thread id exists in several mailboxes; use the mail_thread id',
                      candidates=[r['id'] for r in rows])
    if not rows:
        raise Refused('thread_not_found', thread=ref)
    return rows[0]


def current_owner(cur, thread_id, lock=False):
    cur.execute('select * from mail_thread_owner where thread_id=%s' + (' for update' if lock else ''), (thread_id,))
    return cur.fetchone()


def write_owner(cur, thread_id, profile, session_id, by, reason, action, previous, rule_id=None):
    if profile is None:
        cur.execute('delete from mail_thread_owner where thread_id=%s', (thread_id,))
    else:
        cur.execute(
            '''insert into mail_thread_owner (thread_id, profile, session_id, assigned_by, reason, rule_id)
               values (%s,%s,%s,%s,%s,%s)
               on conflict (thread_id) do update set profile=excluded.profile, session_id=excluded.session_id,
                 assigned_by=excluded.assigned_by, reason=excluded.reason, rule_id=excluded.rule_id, updated_at=now()''',
            (thread_id, profile, session_id, by, reason, rule_id))
    cur.execute(
        '''insert into mail_thread_owner_event (thread_id, action, from_profile, from_session_id, to_profile, to_session_id, actor, reason)
           values (%s,%s,%s,%s,%s,%s,%s,%s)''',
        (thread_id, action, previous and previous['profile'], previous and previous['session_id'], profile, session_id, by, reason))


def change(args, action):
    me, my_session = actor()
    is_router = me in routers()
    if action == 'clear':
        target, session = None, None
    elif action == 'handoff':
        target, session = check_profile(args.to), args.session
    else:
        target = check_profile(args.profile or me)
        if target == 'operator':
            raise UsageError('profile_required', 'Outside an agent session, pass --profile')
        session = args.session if args.session is not None else (my_session if target == me else None)
    if not (args.reason or '').strip():
        raise UsageError('reason_required', 'Say why, in a few words (--reason)')
    with connection(read_only=not args.apply) as db, dict_cursor(db) as cur:
        thread = resolve_thread(cur, args.thread)
        previous = current_owner(cur, thread['id'], lock=args.apply)
        if not is_router:
            if action == 'set':
                if target != me:
                    raise Refused('not_router', 'You can only claim threads for yourself; hand off threads you own instead')
                if previous and previous['profile'] != me:
                    raise Refused('owned_by_other', f"Owned by {previous['profile']}; ask them to hand it off", owner=dict(previous))
            elif not previous or previous['profile'] != me:
                raise Refused('not_owner', 'Only the owning agent (or a router) can hand off or clear this thread',
                              owner=previous and dict(previous))
        if action != 'set' and not previous:
            raise Refused('thread_unowned', thread=thread['id'])
        by = f'agent:{me}' if me != 'operator' else 'operator'
        if args.apply:
            write_owner(cur, thread['id'], target, session, by, args.reason.strip(), action, previous)
        return {'thread_id': thread['id'], 'subject': thread['subject'], 'action': action,
                'from': previous and {'profile': previous['profile'], 'session_id': previous['session_id']},
                'to': target and {'profile': target, 'session_id': session}, 'actor': by, 'dry_run': not args.apply}


def show(args):
    with connection(read_only=True) as db, dict_cursor(db) as cur:
        thread = resolve_thread(cur, args.thread)
        owner = current_owner(cur, thread['id'])
        cur.execute('select * from mail_thread_owner_event where thread_id=%s order by created_at desc limit 20', (thread['id'],))
        return {'thread_id': thread['id'], 'subject': thread['subject'], 'owner': owner and dict(owner),
                'history': [dict(r) for r in cur.fetchall()]}


def list_threads(args):
    me, _ = actor()
    since = datetime.now(timezone.utc) - timedelta(days=args.days)
    with connection(read_only=True) as db, dict_cursor(db) as cur:
        if args.unassigned:
            cur.execute(
                '''select t.id as thread_id, t.subject, t.last_message_at, m.from_email as last_inbound_from, m.identity_key as mailbox
                   from mail_thread t
                   join lateral (select from_email, identity_key from mail_message where thread_id=t.id and direction='inbound'
                                 order by created_at desc limit 1) m on true
                   left join mail_thread_owner o on o.thread_id=t.id
                   where o.thread_id is null and t.last_message_at >= %s
                   order by t.last_message_at desc limit %s''', (since, args.limit))
        else:
            profile = args.profile or me
            cur.execute(
                '''select o.thread_id, o.profile, o.session_id, o.reason, o.updated_at, t.subject, t.last_message_at
                   from mail_thread_owner o join mail_thread t on t.id=o.thread_id
                   where o.profile=%s order by t.last_message_at desc nulls last limit %s''', (profile, args.limit))
        return {'threads': [dict(r) for r in cur.fetchall()]}


# ---- routing -------------------------------------------------------------------------------------------------

def plus_tags(addresses):
    tags = []
    for address in addresses or []:
        local, _, domain = (address or '').lower().partition('@')
        if domain == OWN_DOMAIN and '+' in local:
            tags.append(local.split('+', 1)[1])
    return tags


def route(cur, message):
    """Who should own this inbound message's thread, and why. Returns (profile, session_id, why, rule_id) or None."""
    if message.get('thread_id'):
        owner = current_owner(cur, message['thread_id'])
        if owner:
            return owner['profile'], owner['session_id'], 'thread owner', None
    sender = (message.get('from_email') or '').lower()
    candidates = [('tag', t) for t in plus_tags(list(message.get('to_emails') or []) + list(message.get('cc_emails') or []))]
    candidates += [('sender', sender), ('person', message.get('from_person_id') or message.get('person_id')),
                   ('company', message.get('company_id')), ('domain', sender.rpartition('@')[2]),
                   ('mailbox', message.get('identity_key'))]
    for kind, value in candidates:
        if not value:
            continue
        cur.execute('select * from mail_owner_rule where match_kind=%s and lower(match_value)=lower(%s) order by priority limit 1',
                    (kind, value))
        rule = cur.fetchone()
        if rule:
            return rule['profile'], rule['session_id'], f'rule {kind}={value}', rule['id']
    if sender:
        cur.execute(
            '''select distinct o.profile, o.session_id from mail_thread_owner o
               join mail_message m on m.thread_id=o.thread_id
               where lower(m.from_email)=%s and m.created_at > now() - interval '60 days' ''', (sender,))
        owners = cur.fetchall()
        if len(owners) == 1:
            return owners[0]['profile'], owners[0]['session_id'], 'sender has one owned thread', None
    return None


def route_cmd(args):
    with connection(read_only=True) as db, dict_cursor(db) as cur:
        cur.execute('select * from mail_message where id=%s or gmail_message_id=%s limit 1', (args.message, args.message))
        message = cur.fetchone()
        if not message:
            raise Refused('message_not_found', message=args.message)
        hit = route(cur, message)
        return {'message_id': message['id'], 'thread_id': message['thread_id'],
                'owner': hit and {'profile': hit[0], 'session_id': hit[1], 'why': hit[2], 'rule_id': hit[3]}}


def rules(args):
    me, _ = actor()
    if args.action == 'list':
        with connection(read_only=True) as db, dict_cursor(db) as cur:
            cur.execute('select * from mail_owner_rule order by match_kind, priority, match_value')
            return {'rules': [dict(r) for r in cur.fetchall()]}
    if me not in routers():
        raise Refused('not_router', 'Only a router agent changes routing rules; suggest the rule in your handoff reason')
    with connection(read_only=not args.apply) as db, dict_cursor(db) as cur:
        if args.action == 'add':
            if args.kind not in KINDS or not args.value:
                raise UsageError('invalid_rule', f'--kind must be one of {", ".join(KINDS)} and --value is required')
            row = {'match_kind': args.kind, 'match_value': args.value.lower(), 'profile': check_profile(args.profile),
                   'session_id': args.session, 'priority': args.priority, 'note': args.note, 'created_by': me}
            if args.apply:
                cur.execute('''insert into mail_owner_rule (match_kind, match_value, profile, session_id, priority, note, created_by)
                               values (%(match_kind)s,%(match_value)s,%(profile)s,%(session_id)s,%(priority)s,%(note)s,%(created_by)s)
                               on conflict (match_kind, match_value) do update set profile=excluded.profile, session_id=excluded.session_id,
                                 priority=excluded.priority, note=excluded.note, created_by=excluded.created_by returning id''', row)
                row['id'] = cur.fetchone()['id']
            return {'rule': row, 'dry_run': not args.apply}
        cur.execute('select * from mail_owner_rule where id=%s', (args.id,))
        rule = cur.fetchone()
        if not rule:
            raise Refused('rule_not_found', id=args.id)
        if args.apply:
            cur.execute('delete from mail_owner_rule where id=%s', (args.id,))
        return {'removed': dict(rule), 'dry_run': not args.apply}


# ---- dispatch -------------------------------------------------------------------------------------------------

def api_key():
    key = os.environ.get('API_SERVER_KEY')
    if key:
        return key
    with open(ENV_FILE) as handle:
        for line in handle:
            if line.startswith('API_SERVER_KEY='):
                return line.split('=', 1)[1].strip().strip('"\'')
    raise Refused('api_key_missing', 'API_SERVER_KEY is not configured')


def api(method, path, body=None, timeout=30):
    request = urllib.request.Request(API_BASE + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={'Authorization': 'Bearer ' + api_key(), 'Content-Type': 'application/json'})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read() or b'{}')


def wake_text(thread_id, rows):
    first = rows[0]
    senders = ', '.join(sorted({r['from_email'] or 'unknown sender' for r in rows}))
    count = f'{len(rows)} new emails' if len(rows) > 1 else 'A new email'
    return (f"[mail] {count} on a thread you own: \"{first['subject'] or '(no subject)'}\" from {senders}.\n"
            f"Thread: {thread_id}. Read it with `rebattery-mail thread {thread_id}`, then draft the reply with "
            f"`rebattery-mail draft --thread {thread_id}`. Do not send. Follow the mail-thread-ownership skill; if this thread "
            f"is not yours to handle, hand it off with a reason.")


def ensure_session(cur, owner, subject, apply):
    """The owner's session; a thread owned by a profile without a session gets its own, remembered for follow-ups."""
    if owner['session_id']:
        return owner['session_id'], False
    if not apply:
        return None, True
    created = api('POST', f"/p/{owner['profile']}/api/sessions", {'title': f'Mail: {subject or "(no subject)"}'[:120], 'source': 'crm'})
    session_id = created.get('id') or created.get('session_id') or (created.get('session') or {}).get('id')
    if not session_id:
        raise Refused('session_create_failed', response=created)
    cur.execute('update mail_thread_owner set session_id=%s, updated_at=now() where thread_id=%s', (session_id, owner['thread_id']))
    # Make it visible in the CRM sidebar as a team chat.
    subprocess.run(['/root/.hermes/scripts/crm-register-session.sh', owner['profile'], session_id], capture_output=True, timeout=30)
    return session_id, True


def deliver(profile, session_id, text, log_path):
    """Fire the turn and return: a reply can take minutes and the session may be mid-turn (the gateway queues it)."""
    payload = json.dumps({'message': text})
    url = f'{API_BASE}/p/{profile}/api/sessions/{session_id}/chat'
    # The key goes in through curl's config on stdin, never on the command line.
    config = f'header = "Authorization: Bearer {api_key()}"\nheader = "Content-Type: application/json"\n'
    with open(log_path, 'a') as log:
        log.write(f'{datetime.now(timezone.utc).isoformat()} wake {profile} {session_id}\n')
        log.flush()
        process = subprocess.Popen(['curl', '-sS', '-o', '/dev/null', '-w', f'{profile} {session_id} http=%{{http_code}}\\n',
                                    '--max-time', '3600', '-K', '-', '-X', 'POST', '--data-binary', payload, url],
                                   stdin=subprocess.PIPE, stdout=log, stderr=log, start_new_session=True)
    process.stdin.write(config.encode())  # type: ignore[union-attr]
    process.stdin.close()  # type: ignore[union-attr]


def dispatch(args):
    """Queue new inbound mail, route it, and wake each owner once per thread. Safe to run every minute."""
    own = None
    since = datetime.now(timezone.utc) - timedelta(minutes=args.lookback_minutes)
    result = {'queued': 0, 'unassigned': 0, 'skipped': 0, 'dispatched': [], 'deferred': [], 'dry_run': not args.apply}
    with connection(read_only=not args.apply) as db, dict_cursor(db) as cur:
        cur.execute("select lower(address) from mail_identity union select lower(gmail_account) from mail_identity where gmail_account is not null")
        own = {r['lower'] for r in cur.fetchall() if r['lower']}
        cur.execute(
            '''select m.* from mail_message m left join mail_agent_event e on e.message_id=m.id
               where m.direction='inbound' and m.created_at >= %s and e.id is null order by m.created_at''', (since,))
        for message in cur.fetchall():
            sender = (message['from_email'] or '').lower()
            if sender in own or sender.endswith('@' + OWN_DOMAIN):
                state, hit = 'skipped', None
            else:
                hit = route(cur, message)
                state = 'pending' if hit and message['thread_id'] else 'unassigned'
            result['queued' if state == 'pending' else state] += 1
            if not args.apply:
                continue
            if hit and state == 'pending':
                owner = current_owner(cur, message['thread_id'])
                if not owner:  # routed by a rule or the sender heuristic: the thread now belongs to that agent
                    write_owner(cur, message['thread_id'], hit[0], hit[1], 'router', hit[2], 'route', None, rule_id=hit[3])
            cur.execute('''insert into mail_agent_event (message_id, thread_id, profile, session_id, state, detail)
                           values (%s,%s,%s,%s,%s,%s) on conflict (message_id) do nothing''',
                        (message['id'], message['thread_id'], hit and hit[0], hit and hit[1], state,
                         json.dumps({'why': hit and hit[2], 'from': sender})))
        if args.apply:
            db.commit()
        # Wake owners. A thread whose newest message is younger than the debounce window waits for the next run.
        cur.execute(
            '''select e.thread_id, array_agg(e.id order by e.created_at) as ids, max(m.created_at) as newest
               from mail_agent_event e join mail_message m on m.id=e.message_id
               where e.state='pending' group by e.thread_id''')
        groups = cur.fetchall()
        for group in groups:
            if group['newest'] > datetime.now(timezone.utc) - timedelta(seconds=args.debounce_seconds):
                result['deferred'].append({'thread_id': group['thread_id'], 'reason': 'debounce'})
                continue
            owner = current_owner(cur, group['thread_id'], lock=args.apply)
            if not owner:
                if args.apply:
                    cur.execute("update mail_agent_event set state='unassigned', updated_at=now() where id=any(%s)", (group['ids'],))
                continue
            cur.execute('''select count(*) from mail_agent_event where profile=%s and state='dispatched'
                           and dispatched_at > now() - interval '1 hour' ''', (owner['profile'],))
            if cur.fetchone()['count'] >= args.max_per_hour:
                result['deferred'].append({'thread_id': group['thread_id'], 'reason': 'rate_limited', 'profile': owner['profile']})
                continue
            cur.execute('''select m.subject, m.from_email from mail_agent_event e join mail_message m on m.id=e.message_id
                           where e.id=any(%s) order by e.created_at''', (group['ids'],))
            rows = cur.fetchall()
            session_id, created = ensure_session(cur, dict(owner), rows[0]['subject'], args.apply)
            entry = {'thread_id': group['thread_id'], 'profile': owner['profile'], 'session_id': session_id,
                     'session_created': created, 'messages': len(rows)}
            if args.apply:
                try:
                    deliver(owner['profile'], session_id, wake_text(group['thread_id'], rows), args.log)
                    cur.execute('''update mail_agent_event set state='dispatched', profile=%s, session_id=%s, attempts=attempts+1,
                                   dispatched_at=now(), updated_at=now() where id=any(%s)''', (owner['profile'], session_id, group['ids']))
                except Exception as exc:  # leave pending; retried next run, failed after 5 attempts
                    cur.execute('''update mail_agent_event set attempts=attempts+1, updated_at=now(),
                                   state=case when attempts+1>=5 then 'failed' else state end, detail=detail||%s where id=any(%s)''',
                                (json.dumps({'error': str(exc)[:300]}), group['ids']))
                    entry['error'] = str(exc)[:300]
                db.commit()
            result['dispatched'].append(entry)
    return result


def register(subparsers):
    owner = subparsers.add_parser('owner', help='Which agent owns an email thread; route and wake owners on new mail')
    sub = owner.add_subparsers(dest='owner_command', required=True)

    p = sub.add_parser('show', help='Owner and ownership history of a thread')
    p.add_argument('thread')
    p.set_defaults(handler=show)

    p = sub.add_parser('set', help='Claim a thread (for yourself; routers may assign anyone)')
    p.add_argument('thread')
    p.add_argument('--profile', help='Defaults to your own profile')
    p.add_argument('--session', help='Session that handles it; defaults to your current session when claiming for yourself')
    p.add_argument('--reason', required=True)
    p.add_argument('--apply', action='store_true')
    p.set_defaults(handler=lambda a: change(a, 'set'))

    p = sub.add_parser('handoff', help='Give a thread you own to another agent')
    p.add_argument('thread')
    p.add_argument('--to', required=True)
    p.add_argument('--session')
    p.add_argument('--reason', required=True)
    p.add_argument('--apply', action='store_true')
    p.set_defaults(handler=lambda a: change(a, 'handoff'))

    p = sub.add_parser('clear', help='Release a thread you own (it becomes unassigned)')
    p.add_argument('thread')
    p.add_argument('--reason', required=True)
    p.add_argument('--apply', action='store_true')
    p.set_defaults(handler=lambda a: change(a, 'clear'))

    p = sub.add_parser('list', help='Threads you (or --profile) own, or recent unassigned threads')
    p.add_argument('--profile')
    p.add_argument('--unassigned', action='store_true')
    p.add_argument('--days', type=int, default=14)
    p.add_argument('--limit', type=int, default=50)
    p.set_defaults(handler=list_threads)

    p = sub.add_parser('route', help='Dry run: who would own this inbound message, and why')
    p.add_argument('message', help='mail_message id or Gmail message id')
    p.set_defaults(handler=route_cmd)

    p = sub.add_parser('rules', help='Routing rules for new threads (routers change them)')
    p.add_argument('action', choices=('list', 'add', 'remove'))
    p.add_argument('--kind', choices=KINDS)
    p.add_argument('--value')
    p.add_argument('--profile')
    p.add_argument('--session')
    p.add_argument('--priority', type=int, default=100)
    p.add_argument('--note')
    p.add_argument('--id')
    p.add_argument('--apply', action='store_true')
    p.set_defaults(handler=rules)

    p = sub.add_parser('dispatch', help='Cron: queue new inbound mail, route it and wake owners')
    p.add_argument('--lookback-minutes', type=int, default=180)
    p.add_argument('--debounce-seconds', type=int, default=90)
    p.add_argument('--max-per-hour', type=int, default=20)
    p.add_argument('--log', default='/root/.hermes/logs/mail-dispatch.log')
    p.add_argument('--apply', action='store_true')
    p.set_defaults(handler=dispatch)
