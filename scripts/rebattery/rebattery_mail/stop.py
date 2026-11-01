"""Postmark emergency stop: one file on this server that every Postmark sender checks before sending.

  rebattery-mail postmark-stop on --by Alex --reason "wrong price in the October campaign"
  rebattery-mail postmark-stop off --by Alex
  rebattery-mail postmark-stop status

While it is on, the mail tool and the CRM web app (platform-admin emails) refuse every Postmark send with
postmark_stopped; nothing reaches Postmark. Gmail sends are unaffected (they have GOG_GMAIL_NO_SEND).
"""
import json
import os
from datetime import datetime, timezone
from pathlib import Path

from .core import Refused

STOP_FILE = '/root/.hermes/workspace/mail-postmark-stop.json'


def stop_path() -> Path:
    return Path(os.environ.get('REBATTERY_MAIL_POSTMARK_STOP_FILE') or STOP_FILE)


def postmark_stop():
    """The stop record while sending is stopped, else None."""
    path = stop_path()
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding='utf-8') or '{}')
    except ValueError:
        return {'reason': 'stop file present (unreadable)'}


def check_postmark():
    stop = postmark_stop()
    if stop is not None:
        raise Refused('postmark_stopped', by=stop.get('by'), reason=stop.get('reason'), since=stop.get('stopped_at'))


def handle(args):
    path = stop_path()
    if args.action == 'status':
        stop = postmark_stop()
        return {'stopped': stop is not None, **(stop or {})}
    if not (args.by or '').strip():
        raise Refused('postmark_stop_needs_a_name')
    if args.action == 'on':
        record = {'stopped_at': datetime.now(timezone.utc).isoformat(), 'by': args.by.strip(), 'reason': (args.reason or '').strip()}
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix('.tmp')
        tmp.write_text(json.dumps(record), encoding='utf-8')
        os.chmod(tmp, 0o644)  # the web app reads it too
        tmp.replace(path)
        return {'stopped': True, **record}
    previous = postmark_stop()
    path.unlink(missing_ok=True)
    return {'stopped': False, 'resumed_by': args.by.strip(), 'was': previous}


def register(subparsers):
    parser = subparsers.add_parser('postmark-stop', help='Emergency stop for every Postmark send (on, off, status)')
    parser.add_argument('action', choices=['on', 'off', 'status'])
    parser.add_argument('--by', help='Who turns it on or off (a person)')
    parser.add_argument('--reason', help='Why it is on')
    parser.set_defaults(handler=handle)
