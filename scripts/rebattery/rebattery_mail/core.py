"""Shared plumbing: DB connection, JSON output, stable exit codes, refusals.

Exit codes: 0 ok, 1 refused (a named rule), 2 usage, 3 provider error, 4 unknown outcome needing recover.
Every command prints one JSON document on stdout; human text goes to stderr.
Mutations are dry-run unless --apply.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor

OK, REFUSED, USAGE, PROVIDER, UNKNOWN = 0, 1, 2, 3, 4
PURPOSES = ("personal", "marketing", "transactional")
TRANSPORTS = ("gmail", "postmark-broadcast", "postmark-transactional")


class MailError(Exception):
    exit_code = REFUSED

    def __init__(self, rule, message=None, **detail):
        super().__init__(message or rule)
        self.rule, self.detail = rule, detail

    def payload(self):
        return {"refused": self.rule, "message": str(self), **self.detail}


class Refused(MailError):
    exit_code = REFUSED


class UsageError(MailError):
    exit_code = USAGE


class ProviderError(MailError):
    exit_code = PROVIDER


class UnknownOutcome(MailError):
    exit_code = UNKNOWN


def connection(read_only=False):
    db = psycopg2.connect(os.environ.get("DENCH_MAIL_DSN", os.environ.get("DENCH_CAMPAIGN_DSN", "dbname=denchclaw")))
    db.set_session(readonly=read_only)
    return db


GOG_KEYRING_FILE = Path('/root/.hermes/workspace/.secrets/gog-keyring-password')


def gog_env():
    """Environment every gog call runs with, whoever the caller is. The keyring password never leaves this process."""
    env = os.environ.copy()
    env['HOME'] = '/root'
    if not env.get('GOG_KEYRING_PASSWORD') and GOG_KEYRING_FILE.exists():
        env['GOG_KEYRING_PASSWORD'] = GOG_KEYRING_FILE.read_text().strip()
    return env


def dict_cursor(db):
    return db.cursor(cursor_factory=RealDictCursor)


def emit(payload):
    print(json.dumps(payload, indent=2, default=str))


def run(handler, args):
    """Run a command handler, map MailError to JSON on stdout + exit code."""
    try:
        emit(handler(args))
        return OK
    except MailError as exc:
        emit(exc.payload())
        print(f"rebattery-mail: {exc.rule}: {exc}", file=sys.stderr)
        return exc.exit_code
