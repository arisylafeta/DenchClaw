"""Synthetic-only isolated database cloned from the disposable mail harness."""
import os
import sys
from pathlib import Path
from uuid import uuid4

import psycopg2
from psycopg2 import sql
from psycopg2.extensions import make_dsn, parse_dsn
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
MIGRATION = Path(__file__).resolve().parents[4] / 'apps/web/lib/crm-postgres/migrations/055_whatsapp_context.sql'


@pytest.fixture
def db(monkeypatch):
    admin_dsn = os.environ.get('DENCH_MAIL_TEST_ADMIN_DSN', 'dbname=postgres host=127.0.0.1 port=55470 user=postgres password=test')
    params = parse_dsn(admin_dsn)
    if params.get('host') not in ('localhost', '127.0.0.1') or params.get('port', '5432') == '5432':
        pytest.fail('Disposable localhost non-production database required')
    admin = psycopg2.connect(admin_dsn)
    admin.autocommit = True
    name = 'mail_test_whatsapp_' + uuid4().hex
    with admin.cursor() as cur:
        cur.execute(sql.SQL('create database {} template mail_pre_cutover_test').format(sql.Identifier(name)))
    dsn = make_dsn(admin_dsn, dbname=name)
    monkeypatch.setenv('DENCH_WHATSAPP_DSN', dsn)
    connection = psycopg2.connect(dsn)
    with connection, connection.cursor() as cur:
        cur.execute(MIGRATION.read_text())
    try:
        yield connection
    finally:
        connection.close()
        with admin.cursor() as cur:
            cur.execute(sql.SQL('drop database {} with (force)').format(sql.Identifier(name)))
        admin.close()
