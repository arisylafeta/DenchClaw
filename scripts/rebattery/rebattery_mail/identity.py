"""Configured sender identities, without inferring provider verification."""
from .core import connection, dict_cursor, Refused


def identities(db, key=None):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_identity' + (' where key=%s' if key else '') + ' order by key', (key,) if key else ())
        rows = [dict(r) for r in cur.fetchall()]
    for row in rows:
        row['transports'] = (['gmail'] if row['gmail_account'] else []) + (['postmark-transactional' if row['postmark_stream'] == 'outbound' else 'postmark-broadcast'] if row['postmark_stream'] else [])
        row['verified'] = None
        row['verification_basis'] = 'Configuration only; provider verification has not been checked'
    if key and not rows:
        raise Refused('identity_not_found', identity=key)
    return rows[0] if key else rows


def handle(args):
    with connection(read_only=True) as db:
        return {'identity': identities(db, args.key)} if args.action == 'show' else {'identities': identities(db)}


def register(subparsers):
    parser = subparsers.add_parser('identity')
    actions = parser.add_subparsers(dest='action', required=True)
    actions.add_parser('list').set_defaults(handler=handle)
    show = actions.add_parser('show')
    show.add_argument('key')
    show.set_defaults(handler=handle)
