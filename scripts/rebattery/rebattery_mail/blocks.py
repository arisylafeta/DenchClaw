"""Safe semantic bodies for one-off mail; catalogue helpers own the styling."""
import html
import json
import re
from pathlib import Path
from urllib.parse import urlsplit

from .core import Refused
from .templating import VARIABLE, RESERVED

CATALOGUE = Path('/root/.hermes/profiles/mailvin/workspace/email-templates')


def read_blocks(value):
    try:
        return json.loads(Path(value[1:]).read_text() if value.startswith('@') else value)
    except (OSError, ValueError) as exc:
        raise Refused('invalid_blocks_json') from exc


def _schema(condition, path):
    if not condition:
        raise Refused('invalid_block_schema', path=path)


def compose_blocks(document, identity=None, allow_multiple_cta=False, base=None):
    """Return escaped body fragments, not a signature or policy-owned footer.

    Input is a block list or {greeting, blocks, allowed_identities}. Only ordinary
    double-brace variables survive. All other brace sequences become literal
    full-width braces in both alternatives, never renderer instructions.
    """
    base = Path(base) if base is not None else CATALOGUE / 'base'
    if isinstance(document, list):
        document = {'blocks': document}
    _schema(isinstance(document, dict), '$')
    _schema(not (document.keys() - {'blocks', 'greeting', 'allowed_identities'}), '$')
    blocks = document.get('blocks')
    _schema(isinstance(blocks, list) and bool(blocks), 'blocks')
    allowed = document.get('allowed_identities', ['alex', 'ari', 'hello'])
    _schema(isinstance(allowed, list) and bool(allowed) and all(isinstance(x, str) and x for x in allowed), 'allowed_identities')
    if identity is not None and identity not in allowed:
        raise Refused('template_identity_not_allowed', identity=identity)
    variables, warnings, output, plain = set(), [], [], []

    def warn(code, path):
        warnings.append({'code': code, 'path': path})

    def text(value, path):
        _schema(isinstance(value, str) and bool(value.strip()), path)
        if '—' in value:
            warn('em_dash', path)
        if '!' in value:
            warn('exclamation_mark', path)
        # Protect only valid non-reserved tokens; neutralise everything else.
        parts, last = [], 0
        for match in VARIABLE.finditer(value):
            parts.append(value[last:match.start()].replace('{', '｛').replace('}', '｝'))
            name = match.group(1)
            if name in RESERVED:
                parts.append(match.group().replace('{', '｛').replace('}', '｝'))
            else:
                variables.add(name)
                parts.append('{{' + name + '}}')
            last = match.end()
        parts.append(value[last:].replace('{', '｛').replace('}', '｝'))
        return ''.join(parts)

    def helper(name, values):
        try:
            source = (base / (name + '.html')).read_text()
        except OSError as exc:
            raise Refused('block_helper_missing', helper=name) from exc
        return re.sub(r'\{\{([a-z_]+)\}\}', lambda m: html.escape(values[m[1]], quote=True).replace('\n', '<br>\n'), source)

    greeting = document.get('greeting')
    if greeting is not None:
        greeting = text(greeting, 'greeting')
        output.append(helper('para', {'text': greeting}))
        plain.append(greeting)
    else:
        warn('no_greeting', '$')
    ctas, signoff = 0, False
    for index, block in enumerate(blocks):
        path = 'blocks[' + str(index) + ']'
        _schema(isinstance(block, dict), path)
        kind = block.get('type')
        fields = {
            'paragraph': {'text'}, 'heading': {'text'}, 'section_label': {'text'},
            'bullets': {'items'}, 'numbered': {'items'}, 'fact_box': {'rows'},
            'key_values': {'rows'}, 'cta': {'label', 'url'}, 'note': {'text'},
            'divider': set(), 'signoff': {'text'},
        }
        if not isinstance(kind, str) or kind not in fields:
            raise Refused('unknown_block_type', path=path)
        _schema(set(block) == fields[kind] | {'type'}, path)
        if kind in ('paragraph', 'heading', 'section_label', 'note', 'signoff'):
            value = text(block['text'], path + '.text')
            if kind == 'paragraph' and len(value.split()) > 120:
                warn('long_paragraph', path)
            name = {'paragraph': 'para', 'section_label': 'sectionLabel', 'signoff': 'para'}.get(kind, kind)
            output.append(helper(name, {'text': value}))
            plain.append(value)
            signoff = signoff or kind == 'signoff'
        elif kind in ('bullets', 'numbered'):
            items = block['items']
            _schema(isinstance(items, list) and bool(items), path + '.items')
            items = [text(item, path + '.items[' + str(i) + ']') for i, item in enumerate(items)]
            tag = 'ul' if kind == 'bullets' else 'ol'
            output.append('<' + tag + ' style="margin:0 0 22px;padding-left:24px;font-size:15px;line-height:1.7;color:#3D3D3D;max-width:540px;">' + ''.join('<li>' + html.escape(item, quote=True).replace('\n', '<br>\n') + '</li>' for item in items) + '</' + tag + '>\n')
            plain.append('\n'.join(('- ' if kind == 'bullets' else str(i + 1) + '. ') + item for i, item in enumerate(items)))
        elif kind in ('fact_box', 'key_values'):
            rows = block['rows']
            _schema(isinstance(rows, list) and bool(rows), path + '.rows')
            rendered, lines = [], []
            for i, row in enumerate(rows):
                rp = path + '.rows[' + str(i) + ']'
                _schema(isinstance(row, dict) and set(row) == {'label', 'value'}, rp)
                values = {k: text(row[k], rp + '.' + k) for k in ('label', 'value')}
                rendered.append(helper('kv', values))
                lines.append(values['label'] + ': ' + values['value'])
            content = ''.join(rendered)
            if kind == 'fact_box':
                # Reuse the exact catalogue wrapper, replacing its single example row.
                source = (base / 'factBox.html').read_text()
                start = source.index('      <table')
                end = source.index('</table>', start) + len('</table>')
                content = source[:start] + content + source[end:]
            output.append(content)
            plain.append('\n'.join(lines))
        elif kind == 'cta':
            ctas += 1
            if ctas > 1 and not allow_multiple_cta:
                raise Refused('multiple_ctas')
            label = text(block['label'], path + '.label')
            url = block['url']
            _schema(isinstance(url, str) and bool(url), path + '.url')
            try:
                parsed = urlsplit(url)
                valid = parsed.scheme in ('https', 'mailto', 'tel') and (bool(parsed.hostname) if parsed.scheme == 'https' else bool(parsed.path))
            except ValueError:
                valid = False
            if not valid or any(c.isspace() or ord(c) < 32 for c in url) or any(c in url for c in '{}<>"'):
                raise Refused('unsafe_block_url', path=path + '.url')
            if label == url or re.match(r'^(https://|mailto:|tel:|www\.)', label):
                warn('bare_url_label', path)
            output.append(helper('cta', {'cta_label': label, 'cta_url': url}))
            plain.append(label + ': ' + url)
        else:
            output.append(helper('divider', {}))
            plain.append('')
    if not signoff:
        warn('missing_signoff', '$')
    return {'body_html': ''.join(output), 'body_text': '\n\n'.join(plain), 'variables_used': sorted(variables), 'warnings': warnings}


def oneoff_template(result, subject, identity_key, purpose='personal', base=None):
    """Feed generated fragments into the same catalogue shell and composer."""
    base = Path(base) if base is not None else CATALOGUE / 'base'
    body, text = result['body_html'], result['body_text']
    layout, text_layout = (base / 'layout.html').read_text(), (base / 'layout.txt').read_text()
    if layout.count('{{{content}}}') != 1 or text_layout.count('{{{content}}}') != 1:
        raise Refused('invalid_template_layout')
    return {'subject': subject, 'html': layout.replace('{{{content}}}', body),
            'text_body': text_layout.replace('{{{content}}}', text),
            'required_variables': result['variables_used'], 'allowed_identities': [identity_key],
            'allowed_purposes': [purpose], 'meta': {'category': 'oneoff', 'sendable': True,
                'source_body_html': body, 'source_body_text': text}}
