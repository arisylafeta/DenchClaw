import importlib.util
import os
from pathlib import Path

import psycopg2
from psycopg2.extras import Json, RealDictCursor
import pytest

spec = importlib.util.spec_from_file_location('platform_account_sync', Path(__file__).with_name('platform_account_sync.py'))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
AUTH = '00000000-0000-0000-0000-000000000001'
ACCOUNT = '00000000-0000-0000-0000-000000000002'


def fixture_rows(email=' Person.Name+buyer@Example.com '):
    return ([{'id': AUTH, 'email': email}], [{'id': 'u', 'auth_user_id': AUTH}],
            [{'user_id': 'u', 'account_id': ACCOUNT}],
            [{'id': ACCOUNT, 'role': 'buyer', 'status': 'approved'}])


def test_matching_preserves_dots_and_plus_tags():
    rows, counts = sync.build_links(*fixture_rows(), [{'id': 'p', 'email': 'person.name+buyer@example.com'},
                                                     {'id': 'wrong', 'email': 'personname@example.com'}])
    assert rows[0]['person_id'] == 'p'
    assert rows[0]['email'] == 'person.name+buyer@example.com'
    assert counts['matched'] == counts['by_role']['buyer']['matched'] == 1


@pytest.mark.parametrize('people,outcome', [([], 'unmatched'),
    ([{'id': 'a', 'email': 'same@example.com'}, {'id': 'b', 'email': ' SAME@EXAMPLE.COM '}], 'ambiguous')])
def test_unmatched_and_duplicate_emails_never_auto_link(people, outcome):
    rows, counts = sync.build_links(*fixture_rows('same@example.com'), people)
    assert rows[0]['person_id'] is None
    assert rows[0]['review_status'] == 'needs_review'
    assert counts[outcome] == 1


def test_missing_email_does_not_match_empty_crm_email():
    rows, counts = sync.build_links(*fixture_rows(None), [{'id': 'p', 'email': None}])
    assert counts['unmatched'] == 1
    assert rows[0]['person_id'] is None


def test_multiple_memberships_do_not_choose_arbitrary_role():
    auth, users, memberships, accounts = fixture_rows()
    memberships.append({'user_id': 'u', 'account_id': 'second'})
    accounts.append({'id': 'second', 'role': 'supplier'})
    rows, counts = sync.build_links(auth, users, memberships, accounts, [])
    assert rows[0]['account_id'] is None
    assert rows[0]['review_status'] == 'needs_review'
    assert counts['by_role']['unknown']['total_accounts'] == 1


def test_rest_paginates_even_when_server_caps_below_requested_limit():
    reader = sync.PlatformReader('https://unused', 'secret')
    paths = []
    def get(path):
        paths.append(path)
        return [{'id': 1}, {'id': 2}] if len(paths) == 1 else [{'id': 3}] if len(paths) == 2 else []
    reader.get = get
    assert len(reader.table('users', 'id', 'id.asc')) == 3
    assert 'offset=2' in paths[1]
    assert 'offset=3' in paths[2]


def test_auth_admin_pages_past_one_thousand():
    reader = sync.PlatformReader('https://unused', 'secret')
    paths = []
    def get(path):
        paths.append(path)
        return {'users': [{}] * (1000 if len(paths) == 1 else 1)}
    reader.get = get
    assert len(reader.auth_users()) == 1001
    assert 'page=2' in paths[1]


@pytest.fixture
def database():
    dsn = os.environ.get('PLATFORM_ACCOUNT_TEST_DSN')
    if not dsn:
        pytest.skip('Set PLATFORM_ACCOUNT_TEST_DSN for temporary-table Postgres integration tests')
    conn = psycopg2.connect(dsn)
    with conn.cursor() as cur:
        # Temp names shadow real tables; no CRM customer records are touched.
        cur.execute('create temp table crm_people (id text primary key, email text)')
        cur.execute('create temp table crm_platform_accounts (like public.crm_platform_accounts including all)')
        cur.execute("insert into crm_people values ('p', 'person.name+buyer@example.com')")
    yield conn
    conn.rollback()
    conn.close()


class Reader:
    def auth_users(self):
        return fixture_rows()[0]

    def table(self, name, select, order):
        return dict(zip(('users', 'account_memberships', 'accounts'), fixture_rows()[1:]))[name]


def test_dry_run_never_writes(database):
    assert sync.sync(database, Reader())['matched'] == 1
    with database.cursor() as cur:
        cur.execute('select count(*) from crm_platform_accounts')
        assert cur.fetchone()[0] == 0


def test_sync_is_byte_for_byte_idempotent(database):
    assert sync.sync(database, Reader(), apply=True)['changed'] == 1
    with database.cursor() as cur:
        cur.execute('select row_to_json(t) from crm_platform_accounts t')
        before = cur.fetchone()[0]
    assert sync.sync(database, Reader(), apply=True)['changed'] == 0
    with database.cursor() as cur:
        cur.execute('select row_to_json(t) from crm_platform_accounts t')
        assert cur.fetchone()[0] == before
        cur.execute('select count(*) from crm_people')
        assert cur.fetchone()[0] == 1


@pytest.mark.parametrize('method,status', [('manual', 'auto'), ('email_exact', 'confirmed'), ('unmatched', 'rejected')])
def test_sync_preserves_review_decisions_but_refreshes_platform_metadata(database, method, status):
    sync.sync(database, Reader(), apply=True)
    with database.cursor() as cur:
        cur.execute("update crm_platform_accounts set person_id=null, match_method=%s, review_status=%s, account_status='stale'", (method, status))
    assert sync.sync(database, Reader(), apply=True)['changed'] == 1
    with database.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute('select * from crm_platform_accounts')
        row = cur.fetchone()
        assert row['person_id'] is None
        assert (row['match_method'], row['review_status']) == (method, status)
        assert row['account_status'] == 'approved'
    assert sync.sync(database, Reader(), apply=True)['changed'] == 0


def test_remote_failure_leaves_existing_links_untouched(database):
    sync.sync(database, Reader(), apply=True)
    reader = Reader()
    reader.table = lambda *args: (_ for _ in ()).throw(RuntimeError('unavailable'))
    with pytest.raises(RuntimeError):
        sync.sync(database, reader, apply=True)
    with database.cursor() as cur:
        cur.execute('select count(*) from crm_platform_accounts')
        assert cur.fetchone()[0] == 1
