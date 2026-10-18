"""Local source-of-truth catalogue loading, validation and previews."""
import html
import json
import re
from pathlib import Path
from html.parser import HTMLParser

from .core import Refused
from .templating import VARIABLE, POSTMARK, RESERVED, RAW_NAMES, compose
from . import policy

REQUIRED = {'name', 'version', 'category', 'purpose', 'description', 'subject',
            'required_variables', 'optional_variables', 'allowed_identities',
            'allowed_purposes', 'sendable', 'sample_vars'}
FIELDS = ('subject', 'html', 'text_body', 'required_variables', 'allowed_identities', 'allowed_purposes', 'meta')


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, ValueError) as exc:
        raise Refused('invalid_template_json', path=str(path)) from exc


def load_catalogue(directory):
    root = Path(directory)
    index = read_json(root / 'index.json')
    entries = index if isinstance(index, list) else index.get('templates', [])
    if not isinstance(entries, list) or not entries:
        raise Refused('invalid_template_index')
    oneoffs = sorted(root.glob('custom/oneoff/*.json'))
    files = list(root.glob('presets/**/*.json')) + list(root.glob('custom/*.json')) + list(root.glob('snapshots/*.json')) + oneoffs
    by_name = {}
    for path in files:
        meta = read_json(path)
        if not isinstance(meta, dict) or REQUIRED - meta.keys():
            raise Refused('template_metadata_missing', path=str(path), keys=sorted(REQUIRED - meta.keys()) if isinstance(meta, dict) else sorted(REQUIRED))
        name = meta['name']
        if not isinstance(name, str) or not re.fullmatch(r'[a-zA-Z0-9][a-zA-Z0-9_-]*', name) or name in by_name:
            raise Refused('invalid_template_name', template=name)
        if type(meta['version']) is not int or meta['version'] < 1 or type(meta['sendable']) is not bool:
            raise Refused('invalid_template_metadata', template=name)
        for key in ('required_variables', 'optional_variables', 'allowed_identities', 'allowed_purposes'):
            if not isinstance(meta[key], list) or any(not isinstance(v, str) for v in meta[key]):
                raise Refused('invalid_template_metadata', template=name, key=key)
        if not isinstance(meta['sample_vars'], dict) or meta['purpose'] not in ('personal', 'marketing', 'transactional') or meta['purpose'] not in meta['allowed_purposes']:
            raise Refused('invalid_template_metadata', template=name)
        try:
            body = path.with_suffix('.html').read_text()
            text = path.with_suffix('.txt').read_text() if meta['sendable'] else ''
        except OSError as exc:
            raise Refused('template_body_missing', template=name) from exc
        row = {key: meta[key] for key in ('name', 'version', 'subject', 'required_variables', 'allowed_identities', 'allowed_purposes')}
        row.update(html=body, text_body=text, meta=meta)
        row['meta'] = {**meta, 'source_body_html': body, 'source_body_text': text}
        if meta['sendable']:
            layout = (root / 'base/layout.html').read_text()
            text_layout = (root / 'base/layout.txt').read_text()
            if layout.count('{{{content}}}') != 1 or text_layout.count('{{{content}}}') != 1:
                raise Refused('invalid_template_layout')
            for token in ('{{{signature_html}}}', '{{{unsubscribe_html}}}'):
                if token not in layout:
                    body += '\n' + token
            for token in ('{{signature_text}}', '{{unsubscribe_text}}'):
                if token not in text_layout:
                    text += '\n\n' + token
            row['html'] = layout.replace('{{{content}}}', body)
            row['text_body'] = text_layout.replace('{{{content}}}', text)
        by_name[name] = row
    names = [entry if isinstance(entry, str) else entry.get('name') for entry in entries]
    # Saved one-offs are opt-in files, not edits to the curated catalogue index.
    names += [read_json(path)['name'] for path in oneoffs if read_json(path)['name'] not in names]
    if len(names) != len(set(names)) or set(names) != set(by_name):
        raise Refused('template_index_mismatch')
    signatures = {}
    for key in ('alex', 'ari'):
        paths = [root / 'signatures' / (key + ext) for ext in ('.html', '.txt')]
        if any(p.exists() for p in paths):
            if not all(p.exists() for p in paths):
                raise Refused('signature_pair_missing', identity=key)
            signatures[key] = {'signature_html': paths[0].read_text(), 'signature_text': paths[1].read_text()}
    return [by_name[name] for name in names], signatures


def sample_identity(key, signatures):
    return {'key': key, 'address': key + '@example.test', **signatures.get(key, {})}


def links(message):
    def plain_urls(text):
        return {url.rstrip('.,);') for url in re.findall(r'(?:https?://|mailto:)[^\s<>]+', text)}

    class Destinations(HTMLParser):
        def __init__(self):
            super().__init__(convert_charrefs=True)
            self.urls = set()

        def handle_starttag(self, tag, attrs):
            if tag.lower() == 'a':
                self.urls.update(value for key, value in attrs if key.lower() == 'href' and value)

        def handle_data(self, data):
            self.urls.update(plain_urls(data))

    parser = Destinations()
    parser.feed(message['html'])
    return parser.urls, plain_urls(message['text'])


def validate_catalogue(rows, signatures):
    for row in rows:
        meta = row['meta']
        if not meta['sendable']:
            continue
        source = '\n'.join(row[key] for key in ('subject', 'html', 'text_body'))
        if '—' in source:
            raise Refused('template_em_dash', template=row['name'])
        unchecked = POSTMARK.sub('', source)
        for name in re.findall(r'\{\{\{([^{}]*)\}\}\}', unchecked):
            if name not in RAW_NAMES:
                raise Refused('unresolved_merge_token', template=row['name'])
        used = set(VARIABLE.findall(source)) | set(re.findall(r'\{\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}\}', unchecked))
        declared = set(meta['required_variables']) | set(meta['optional_variables'])
        if used - declared - RESERVED or declared - used:
            raise Refused('template_variable_mismatch', template=row['name'], undeclared=sorted(used - declared - RESERVED), unused=sorted(declared - used))
        keys = meta['allowed_identities'] or ['alex', 'hello']
        for key in keys:
            for purpose in meta['allowed_purposes']:
                transports = ('gmail', 'postmark-broadcast') if purpose == 'marketing' else ('gmail', 'postmark-transactional')
                for transport in transports:
                    rendered = compose(row, meta['sample_vars'], sample_identity(key, signatures), purpose, transport)
                    if any('—' in value for value in rendered.values()):
                        raise Refused('template_em_dash', template=row['name'])
                    policy.content({'body_html': rendered['html'], 'body_text': rendered['text'], 'subject': rendered['subject'], 'purpose': purpose, 'transport': transport})
                    if links(rendered)[0] != links(rendered)[1]:
                        raise Refused('template_link_mismatch', template=row['name'], identity=key)
    return {'valid': True, 'templates': len(rows), 'sendable': sum(r['meta']['sendable'] for r in rows)}


def preview_catalogue(rows, signatures, output, identity='alex'):
    out = Path(output)
    out.mkdir(parents=True, exist_ok=True)
    entries = []
    for row in rows:
        meta = row['meta']
        if meta['sendable']:
            key = identity
            if row['allowed_identities'] and key not in row['allowed_identities']:
                key = row['allowed_identities'][0]
            transport = 'postmark-broadcast' if meta['purpose'] == 'marketing' else 'gmail'
            rendered = compose(row, meta['sample_vars'], sample_identity(key, signatures), meta['purpose'], transport)
            content = rendered['html']
        else:
            content = row['html']
        filename = row['name'] + '.html'
        (out / filename).write_text(content)
        label = ' / '.join((row['name'], meta['category'], meta['purpose'], 'sendable' if meta['sendable'] else 'reference only'))
        variables = ', '.join(meta['required_variables'] + meta['optional_variables'])
        entries.append('<section><h2><a href="' + filename + '">' + html.escape(label) + '</a></h2><p>Variables: ' + html.escape(variables) + '</p><iframe title="' + html.escape(row['name']) + '" src="' + filename + '"></iframe></section>')
    (out / 'sheet.html').write_text('<!doctype html><html><head><meta charset="utf-8"><title>ReBattery email templates</title><style>iframe{width:100%;height:600px;border:1px solid #ddd}body{font:16px sans-serif;max-width:1000px;margin:auto}</style></head><body><h1>ReBattery email templates</h1>' + ''.join(entries) + '</body></html>')
    return {'templates': len(rows), 'output': str(out), 'sheet': str(out / 'sheet.html')}
