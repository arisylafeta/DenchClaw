#!/usr/bin/env python3
"""Link platform auth users to existing CRM people; dry-run unless --apply.

Production access is GET-only. Output is aggregate counts, never identities or secrets.
No CRM people are created or updated. Manual/confirmed/rejected decisions survive sync.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import shlex
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

import psycopg2
from psycopg2.extras import Json, RealDictCursor

PLATFORM_ENV = Path('/root/.hermes/workspace/secrets/dench-platform-admin.env')
PROJECT_HOST = 'ozyqdztmvnzffugumuig.supabase.co'
FIELDS = ('auth_user_id', 'person_id', 'account_id', 'account_role', 'account_status',
          'email', 'match_method', 'review_status', 'auth_created_at', 'last_sign_in_at')


def normalize_email(value):
    return (value or '').strip().lower() or None


def platform_credentials(path=PLATFORM_ENV):
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith('#'):
            continue
        key, sep, value = line.removeprefix('export ').partition('=')
        if sep:
            parts = shlex.split(value, comments=True)
            values[key.strip()] = parts[0] if parts else ''
    url = values['NEXT_PUBLIC_SUPABASE_URL'].rstrip('/')
    key = values['SUPABASE_SECRET_KEY']
    parsed = urllib.parse.urlparse(url)
    host = parsed.hostname
    if parsed.scheme != 'https' or parsed.username or parsed.password or parsed.path not in ('', '/'):
        raise ValueError('Invalid production platform URL')
    if host != PROJECT_HOST:
        # The approved custom API domain must CNAME to the expected production project.
        if host != 'api.rebattery.io' or socket.gethostbyname_ex(host)[0] != PROJECT_HOST:
            raise ValueError('Production project identity could not be verified')
    if not key:
        raise ValueError('Missing platform credential')
    return url, key


class PlatformReader:
    def __init__(self, url, key):
        self.url, self.key = url, key

    def get(self, path):
        headers = {'apikey': self.key, 'Accept': 'application/json'}
        if not self.key.startswith('sb_secret_'):
            headers['Authorization'] = 'Bearer ' + self.key
        request = urllib.request.Request(self.url + path, headers=headers, method='GET')
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'Platform read failed (HTTP {exc.code})') from None
        except (urllib.error.URLError, ValueError):
            raise RuntimeError('Platform read failed; no CRM changes applied') from None

    def auth_users(self):
        users, page = [], 1
        while True:
            payload = self.get(f'/auth/v1/admin/users?page={page}&per_page=1000')
            batch = payload['users']
            users.extend(batch)
            if not batch or len(batch) < 1000:
                return users
            page += 1

    def table(self, name, select, order):
        rows, offset = [], 0
        while True:
            query = urllib.parse.urlencode({'select': select, 'order': order, 'limit': 1000, 'offset': offset})
            batch = self.get(f'/rest/v1/{name}?{query}')
            if not isinstance(batch, list):
                raise RuntimeError('Invalid platform table response')
            rows.extend(batch)
            # Continue until empty, even if a server applies a smaller page cap.
            if not batch:
                return rows
            offset += len(batch)


def build_links(auth_users, users, memberships, accounts, people):
    """Return proposed links and privacy-safe match counts; ambiguous identities stay unlinked."""
    emails = defaultdict(set)
    for person in people:
        email = normalize_email(person.get('email'))
        if email:
            emails[email].add(person['id'])
    public_users = defaultdict(list)
    for user in users:
        public_users[user.get('auth_user_id')].append(user['id'])
    account_map = {account['id']: account for account in accounts}
    membership_map = defaultdict(set)
    for membership in memberships:
        membership_map[membership['user_id']].add(membership['account_id'])
    rows, counts = [], Counter()
    by_role = defaultdict(Counter)
    for auth in auth_users:
        account_ids = set()
        for user_id in public_users[auth['id']]:
            account_ids.update(membership_map[user_id])
        linked_accounts = [account_map[aid] for aid in sorted(account_ids) if aid in account_map]
        # One auth identity can have several account memberships. Do not silently pick a role.
        account = linked_accounts[0] if len(linked_accounts) == 1 and len(account_ids) == 1 else {}
        account_ambiguous = len(account_ids) > 1 or bool(account_ids - account_map.keys())
        email = normalize_email(auth.get('email'))
        matches = emails.get(email, set())
        outcome = 'ambiguous' if len(matches) > 1 else 'matched' if len(matches) == 1 else 'unmatched'
        person_id = next(iter(matches)) if len(matches) == 1 else None
        role = account.get('role') or 'unknown'
        counts['total_accounts'] += 1
        counts[outcome] += 1
        by_role[role]['total_accounts'] += 1
        by_role[role][outcome] += 1
        rows.append(dict(zip(FIELDS, (
            auth['id'], person_id, account.get('id'), account.get('role'), account.get('status'),
            email, 'email_exact' if person_id else 'unmatched',
            'auto' if person_id and not account_ambiguous else 'needs_review',
            auth.get('created_at'), auth.get('last_sign_in_at'),
        ))))
    summary = {key: counts[key] for key in ('total_accounts', 'matched', 'ambiguous', 'unmatched')}
    summary['by_role'] = {role: {key: count[key] for key in ('total_accounts', 'matched', 'ambiguous', 'unmatched')}
                          for role, count in sorted(by_role.items())}
    return rows, summary


UPSERT = """
with incoming as (
  select * from jsonb_populate_recordset(null::crm_platform_accounts, %s::jsonb)
), written as (
  insert into crm_platform_accounts as target
    (auth_user_id, person_id, account_id, account_role, account_status, email,
     match_method, review_status, auth_created_at, last_sign_in_at)
  select auth_user_id, person_id, account_id, account_role, account_status, email,
         match_method, review_status, auth_created_at, last_sign_in_at from incoming
  on conflict (auth_user_id) do update set
    person_id = case when target.match_method = 'manual' or target.review_status in ('confirmed', 'rejected') then target.person_id else excluded.person_id end,
    match_method = case when target.match_method = 'manual' or target.review_status in ('confirmed', 'rejected') then target.match_method else excluded.match_method end,
    review_status = case when target.match_method = 'manual' or target.review_status in ('confirmed', 'rejected') then target.review_status else excluded.review_status end,
    account_id = excluded.account_id, account_role = excluded.account_role,
    account_status = excluded.account_status, email = excluded.email,
    auth_created_at = excluded.auth_created_at, last_sign_in_at = excluded.last_sign_in_at,
    linked_at = case when target.person_id is distinct from excluded.person_id
      and target.match_method <> 'manual' and target.review_status not in ('confirmed', 'rejected')
      then now() else target.linked_at end,
    updated_at = now()
  where (target.account_id, target.account_role, target.account_status, target.email,
         target.auth_created_at, target.last_sign_in_at)
        is distinct from
        (excluded.account_id, excluded.account_role, excluded.account_status, excluded.email,
         excluded.auth_created_at, excluded.last_sign_in_at)
     or (target.match_method <> 'manual' and target.review_status not in ('confirmed', 'rejected')
         and (target.person_id, target.match_method, target.review_status) is distinct from
             (excluded.person_id, excluded.match_method, excluded.review_status))
  returning 1
)
select count(*) as changed from written
"""


def sync(conn, reader, apply=False):
    # Finish every remote read before starting local writes. Failure never means an empty source.
    auth = reader.auth_users()
    users = reader.table('users', 'id,auth_user_id', 'id.asc')
    memberships = reader.table('account_memberships', 'user_id,account_id', 'user_id.asc,account_id.asc')
    accounts = reader.table('accounts', 'id,role,status', 'id.asc')
    with conn.cursor(cursor_factory=RealDictCursor) as cursor:
        cursor.execute('select id, email from crm_people')
        rows, summary = build_links(auth, users, memberships, accounts, cursor.fetchall())
        if apply:
            cursor.execute(UPSERT, (Json(rows),))
            summary['changed'] = cursor.fetchone()['changed']
    summary['mode'] = 'apply' if apply else 'dry-run'
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--dry-run', action='store_true', help='Default: report counts without writing')
    mode.add_argument('--apply', action='store_true', help='Upsert links in the local CRM only')
    args = parser.parse_args()
    try:
        reader = PlatformReader(*platform_credentials())
        with psycopg2.connect(dbname='denchclaw') as conn:
            if not args.apply:
                conn.set_session(readonly=True)
            summary = sync(conn, reader, apply=args.apply)
        print(json.dumps(summary, sort_keys=True))
    except Exception as exc:
        # Database/HTTP errors can contain personal data or credentials; never echo them.
        print(f'Platform account sync failed ({type(exc).__name__}); transaction rolled back.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
