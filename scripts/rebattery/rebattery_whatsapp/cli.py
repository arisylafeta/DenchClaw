"""Local-file import and identity CLI. Mutations are dry-run unless --apply."""
import argparse
import json
import sys

import psycopg2

from . import identity, read
from .core import Refused, connection, cursor
from .ingest import ingest
from .commands_read import COMMANDS, dispatch_read_command, register_read_commands
from .screening import register_screen_command, screen

from .retention import retain

def parser():
    root = argparse.ArgumentParser(prog='rebattery-whatsapp')
    commands = root.add_subparsers(dest='command', required=True)
    ingest_parser = commands.add_parser('ingest')
    ingest_parser.add_argument('--path', required=True)
    ingest_parser.add_argument('--account')
    ingest_parser.add_argument('--apply', action='store_true')
    commands.add_parser('status')
    register_read_commands(commands)
    register_screen_command(commands)
    retention = commands.add_parser('retention')
    retention.add_argument('--path', required=True)
    retention.add_argument('--account', required=True)
    retention.add_argument('--apply', action='store_true')
    identities = commands.add_parser('identity').add_subparsers(dest='action', required=True)
    for action in ('propose', 'list', 'link', 'unlink'):
        sub = identities.add_parser(action)
        sub.add_argument('--account')
        if action in ('link', 'unlink'):
            sub.add_argument('--apply', action='store_true')
            sub.add_argument('--actor', default='operator')
        if action == 'link':
            sub.add_argument('--identity', required=True)
            sub.add_argument('--person')
            sub.add_argument('--company')
            sub.add_argument('--shared', action='store_true')
        if action == 'unlink':
            sub.add_argument('--link', required=True)
    return root


def dispatch(args):
    if args.command == 'retention':
        return retain(args.path, args.account, args.apply)
    if args.command == 'ingest':
        return ingest(args.path, args.apply, args.account)
    if args.command == 'screen':
        with connection() as db:
            return screen(db, args.apply, args.limit)
    if args.command in COMMANDS:
        with connection(read_only=True) as db:
            return dispatch_read_command(args, db)
    with connection(read_only=args.command == 'status' or args.action in ('list', 'propose')) as db:
        if args.command == 'status':
            return read.status(db)
        with cursor(db) as cur:
            if args.action == 'propose':
                return {'candidates': identity.proposals(cur, args.account)}
            if args.action == 'list':
                return {'links': identity.list_links(cur, args.account)}
            if args.action == 'link':
                result = {'link_id': identity.link(cur, args.identity, args.person, args.company, args.actor, shared=args.shared)}
            else:
                result = {'link_id': identity.unlink(cur, args.link, args.actor)}
            result['apply'] = args.apply
            if not args.apply:
                db.rollback()
            return result


def main(argv=None):
    try:
        result = dispatch(parser().parse_args(argv))
        print(json.dumps(result, default=str))
        return 0
    except Refused as exc:
        print(json.dumps({'refused': exc.rule, 'message': str(exc)}))
        return exc.exit_code
    except psycopg2.Error:
        # Database diagnostics can contain customer values. Do not print them.
        print(json.dumps({'refused': 'database_error', 'message': 'Local database operation failed'}))
        return 3
    except (OSError, ValueError) as exc:
        print(json.dumps({'refused': 'local_input_error', 'message': type(exc).__name__}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
