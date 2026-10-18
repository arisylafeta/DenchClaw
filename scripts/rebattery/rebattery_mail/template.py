"""Versioned template catalogue."""
import json
from .core import connection, dict_cursor, Refused, UsageError
from .templating import render_template, render_message


def find_template(db, name):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_template where id=%s or name=%s order by version desc, id limit 1', (name, name))
        row = cur.fetchone()
    if not row:
        raise Refused('template_not_found', template=name)
    return dict(row)


def handle(args):
    with connection(read_only=True) as db:
        if args.action == 'list':
            with dict_cursor(db) as cur:
                cur.execute('select * from mail_template order by name, version desc, id')
                return {'templates': [dict(r) for r in cur.fetchall()]}
        row = find_template(db, args.name)
        if args.action == 'show':
            return {'template': row}
        try:
            variables = json.loads(args.vars)
        except ValueError as exc:
            raise UsageError('invalid_variables_json') from exc
        if not isinstance(variables, dict):
            raise UsageError('variables_must_be_object')
        return {'template_id': row['id'], 'version': row['version'], **render_message(row, variables)}


def register(subparsers):
    actions = subparsers.add_parser('template').add_subparsers(dest='action', required=True)
    actions.add_parser('list').set_defaults(handler=handle)
    for action in ('show', 'render'):
        parser = actions.add_parser(action)
        parser.add_argument('name')
        if action == 'render':
            parser.add_argument('--vars', default='{}')
        parser.set_defaults(handler=handle)
