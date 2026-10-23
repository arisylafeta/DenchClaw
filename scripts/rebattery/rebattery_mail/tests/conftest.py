"""Disposable, module-isolated Postgres databases for mail regression tests."""
import os
from pathlib import Path
from uuid import uuid4

import psycopg2
from psycopg2 import sql
from psycopg2.extensions import make_dsn, parse_dsn
import pytest

DEFAULT_ADMIN_DSN = 'dbname=postgres host=127.0.0.1 port=55470 user=postgres password=test'
MIGRATIONS = Path(__file__).resolve().parents[4] / 'apps/web/lib/crm-postgres/migrations'
CUTOVER = MIGRATIONS / '051_mail_cutover.sql'
ROLE_MIGRATION = MIGRATIONS / '052_mail_agent_role.sql'


def guard_test_dsn(dsn):
    """Never create, migrate or drop databases on a production-looking endpoint."""
    params = parse_dsn(dsn)
    if (params.get('host') not in ('127.0.0.1', 'localhost')
            or params.get('port', '5432') == '5432'
            or not params.get('dbname', '').startswith('mail_test_')):
        pytest.skip('Mail database tests require a mail_test_* database on localhost at a non-5432 port')
    return params


@pytest.fixture(scope='module')
def mail_test_database(request):
    admin_dsn = os.environ.get('DENCH_MAIL_TEST_ADMIN_DSN', DEFAULT_ADMIN_DSN)
    name = 'mail_test_' + uuid4().hex
    dsn = make_dsn(admin_dsn, dbname=name)
    guard_test_dsn(dsn)
    try:
        admin = psycopg2.connect(admin_dsn)
    except psycopg2.OperationalError:
        pytest.skip('Disposable mail test Postgres is unavailable; configure DENCH_MAIL_TEST_ADMIN_DSN')
    admin.autocommit = True
    created = False
    previous = {key: os.environ.get(key) for key in ('DENCH_MAIL_DSN', 'BULK_TRADES_TEST_DATABASE_URL', 'DENCH_MAIL_LIVE_SEND')}
    try:
        with admin.cursor() as cur:
            cur.execute(sql.SQL('create database {} template mail_pre_cutover_test').format(sql.Identifier(name)))
        created = True
        # The shared template may predate idempotent additions to 050.
        with psycopg2.connect(dsn) as db, db.cursor() as cur:
            cur.execute((MIGRATIONS / '050_mail_log.sql').read_text())
            if ROLE_MIGRATION.exists():
                cur.execute(ROLE_MIGRATION.read_text())
            cur.execute((MIGRATIONS / '053_mail_template_meta.sql').read_text())
            cur.execute((MIGRATIONS / '086_mail_identity_transactional_stream.sql').read_text())
        os.environ['DENCH_MAIL_DSN'] = dsn
        os.environ['BULK_TRADES_TEST_DATABASE_URL'] = dsn
        os.environ.pop('DENCH_MAIL_LIVE_SEND', None)
        # Existing caller tests cache their connection string at import time.
        if hasattr(request.module, 'TEST_URL'):
            request.module.TEST_URL = dsn
        yield dsn
    finally:
        for key, value in previous.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value
        if created:
            guard_test_dsn(dsn)
            with admin.cursor() as cur:
                cur.execute(sql.SQL('drop database {} with (force)').format(sql.Identifier(name)))
        admin.close()


@pytest.fixture(scope='module')
def db_pre_cutover(mail_test_database):
    """A clone through live migration 049 and mail log 050, before cutover 051."""
    return mail_test_database


@pytest.fixture(scope='module')
def db_after_cutover(db_pre_cutover):
    """A module's fresh database migrated to the final mail-log schema."""
    guard_test_dsn(db_pre_cutover)
    with psycopg2.connect(db_pre_cutover) as db, db.cursor() as cur:
        cur.execute(CUTOVER.read_text())
        if ROLE_MIGRATION.exists():
            cur.execute(ROLE_MIGRATION.read_text())
    return db_pre_cutover
