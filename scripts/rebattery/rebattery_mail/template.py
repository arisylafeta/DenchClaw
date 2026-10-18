"""Versioned template catalogue and local source-of-truth tooling."""
import json
from uuid import uuid4
from .core import connection, dict_cursor, Refused, UsageError
from .templating import compose
from .catalogue import load_catalogue, validate_catalogue, preview_catalogue, FIELDS


def find_template(db, name):
    with dict_cursor(db) as cur:
        cur.execute('select * from mail_template where id=%s or name=%s order by version desc, id limit 1', (name, name))
        row = cur.fetchone()
    if not row:
        raise Refused('template_not_found', template=name)
    return dict(row)


def sync_catalogue(db, rows, signatures, apply=False):
    changes, inserts, unchanged = [], [], 0
    with dict_cursor(db) as cur:
        # Plan everything before writing, so a version conflict is atomic even
        # for callers that catch the refusal inside their transaction.
        for row in rows:
            cur.execute('select * from mail_template where name=%s order by version desc', (row['name'],))
            existing = [dict(r) for r in cur.fetchall()]
            same = next((r for r in existing if r['version'] == row['version']), None)
            if same:
                changed = [key for key in FIELDS if same[key] != row[key]]
                if changed:
                    raise Refused('template_version_conflict', template=row['name'], version=row['version'], changed_fields=changed)
                unchanged += 1
            else:
                if existing and row['version'] <= existing[0]['version']:
                    raise Refused('template_version_conflict', template=row['name'], version=row['version'])
                inserts.append(row)
                changes.append({'template': row['name'], 'version': row['version'], 'action': 'insert', 'changed_fields': list(FIELDS) if not existing else [key for key in FIELDS if existing[0][key] != row[key]]})
        signature_changes = []
        for key, signature in signatures.items():
            if key not in ('alex', 'ari'):
                continue
            cur.execute('select signature_html,signature_text from mail_identity where key=%s', (key,))
            old = cur.fetchone()
            if not old:
                raise Refused('identity_unavailable', identity=key)
            if any(old[field] != signature[field] for field in signature):
                signature_changes.append({'identity': key, 'changed_fields': [field for field in signature if old[field] != signature[field]]})
        if apply:
            for row in inserts:
                cur.execute('insert into mail_template (id,name,version,' + ','.join(FIELDS) + ') values (' + ','.join(['%s'] * (3 + len(FIELDS))) + ')',
                            [uuid4().hex, row['name'], row['version']] + [json.dumps(row[key]) if key == 'meta' else row[key] for key in FIELDS])
            for change in signature_changes:
                signature = signatures[change['identity']]
                cur.execute('update mail_identity set signature_html=%s,signature_text=%s,updated_at=now() where key=%s', (signature['signature_html'], signature['signature_text'], change['identity']))
    return {'dry_run': not apply, 'templates': len(rows), 'inserted': len(inserts), 'unchanged': unchanged, 'signatures_updated': len(signature_changes), 'diffs': changes, 'signature_diffs': signature_changes}


def handle(args):
    if args.action in ('sync', 'validate', 'preview'):
        rows, signatures = load_catalogue(args.dir)
        result = validate_catalogue(rows, signatures)
        if args.action == 'validate':
            return result
        if args.action == 'preview':
            return preview_catalogue(rows, signatures, args.out, args.identity)
        with connection(read_only=not args.apply) as db:
            return sync_catalogue(db, rows, signatures, args.apply)
    with connection(read_only=True) as db:
        if args.action == 'list':
            with dict_cursor(db) as cur:
                cur.execute('select * from mail_template order by name, version desc, id')
                rows = [dict(r) for r in cur.fetchall()]
            return {'templates': [{**r, 'category': r['meta'].get('category'), 'sendable': r['meta'].get('sendable', True), 'variables': {'required': r['required_variables'], 'optional': r['meta'].get('optional_variables', [])}} for r in rows]}
        row = find_template(db, args.name)
        if args.action == 'show':
            return {'template': row}
        try:
            variables = json.loads(args.vars)
        except ValueError as exc:
            raise UsageError('invalid_variables_json') from exc
        if not isinstance(variables, dict):
            raise UsageError('variables_must_be_object')
        from .policy import identity
        author, transport = identity(db, args.identity, args.purpose, args.transport)
        return {'template_id': row['id'], 'version': row['version'], **compose(row, variables, author, args.purpose, transport)}


def register(subparsers):
    actions = subparsers.add_parser('template').add_subparsers(dest='action', required=True)
    actions.add_parser('list').set_defaults(handler=handle)
    for action in ('show', 'render'):
        parser = actions.add_parser(action)
        parser.add_argument('name')
        if action == 'render':
            parser.add_argument('--vars', default='{}')
            parser.add_argument('--identity', default='alex')
            parser.add_argument('--purpose', choices=('personal', 'marketing', 'transactional'), default='personal')
            parser.add_argument('--transport', choices=('gmail', 'postmark-broadcast', 'postmark-transactional'))
        parser.set_defaults(handler=handle)
    for action in ('sync', 'validate', 'preview'):
        parser = actions.add_parser(action)
        parser.add_argument('--dir', required=True)
        if action == 'sync':
            parser.add_argument('--apply', action='store_true')
        if action == 'preview':
            parser.add_argument('--out', required=True)
            parser.add_argument('--identity', default='alex')
        parser.set_defaults(handler=handle)
