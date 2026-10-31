"""One applied Gmail sync per account: the lock, and the CLI flags Relay's scan uses (--skip-known, --if-free)."""
import argparse
import os
from contextlib import contextmanager

import psycopg2
import pytest

from rebattery_mail import sync

TEST_DB = os.environ.get('RELAY_TEST_DB', 'stock_test_9e426f3f65c340ea8fbd892fd0fabf84')


def test_second_sync_of_the_same_account_skips_while_the_first_runs():
    try:
        first, second = psycopg2.connect(dbname=TEST_DB), psycopg2.connect(dbname=TEST_DB)
    except psycopg2.OperationalError:
        pytest.skip('local scratch Postgres not reachable')
    try:
        assert sync.lock_gmail_sync(first, 'Alex@rebattery.io')
        assert not sync.lock_gmail_sync(second, 'alex@rebattery.io', wait=False)
        assert sync.lock_gmail_sync(second, 'ari@rebattery.io', wait=False)
        second.rollback()
        first.commit()
        assert sync.lock_gmail_sync(second, 'alex@rebattery.io', wait=False)
    finally:
        first.close()
        second.close()


def parse(argv):
    parser = argparse.ArgumentParser()
    sync.register(parser.add_subparsers(dest='command'))
    return parser.parse_args(argv)


def test_flags_reach_the_sync_and_a_busy_account_is_skipped(monkeypatch):
    calls = []

    @contextmanager
    def fake_connection(read_only=False):
        yield object()

    monkeypatch.setattr(sync, 'connection', fake_connection)
    monkeypatch.setattr(sync, 'sync_gmail', lambda db, account, since, apply, skip_known=False: calls.append((account, since, skip_known)) or {'account': account})
    monkeypatch.setattr(sync, 'lock_gmail_sync', lambda db, account, wait=True: account != 'busy@rebattery.io' or wait)

    args = parse(['sync', 'gmail', '--account', 'alex@rebattery.io', '--since', '2026/10/30', '--skip-known', '--if-free', '--apply'])
    assert sync.handle(args) == {'dry_run': False, 'accounts': [{'account': 'alex@rebattery.io'}]}
    assert calls == [('alex@rebattery.io', '2026/10/30', True)]

    busy = sync.handle(parse(['sync', 'gmail', '--account', 'busy@rebattery.io', '--if-free', '--apply']))
    assert busy['accounts'][0]['skipped'] and len(calls) == 1
    sync.handle(parse(['sync', 'gmail', '--account', 'busy@rebattery.io', '--apply']))
    assert calls[-1] == ('busy@rebattery.io', None, False)
