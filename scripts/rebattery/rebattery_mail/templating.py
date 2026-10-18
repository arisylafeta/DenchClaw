"""Deterministic rendering shared by drafts, campaigns and template reads."""
import html
import re

from .core import Refused

VARIABLE = re.compile(r"(?<!\{)\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}(?!\})")
POSTMARK = re.compile(r"\{\{\{\s*pm:[^{}]+\}\}\}")
RAW_NAMES = {'content', 'signature_html', 'unsubscribe_html', 'body_html'}
RESERVED = RAW_NAMES | {'signature_text', 'unsubscribe_text', 'preview'}
TOKEN = re.compile(r"\{\{\{(?:\s*pm:[^{}]+|[a-zA-Z_][a-zA-Z0-9_]*)\}\}\}|(?<!\{)\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}(?!\})")


def render_template(template: str, variables: dict, html_mode: bool = False) -> str:
    def replace(match):
        token = match.group(0)
        if POSTMARK.fullmatch(token):
            return token
        raw = token.startswith('{{{')
        name = token[3:-3] if raw else match.group(1)
        if raw and name not in RAW_NAMES:
            raise Refused('unresolved_merge_token')
        if name not in variables or variables[name] is None:
            raise Refused('missing_variable', variable=name)
        value = str(variables[name])
        return html.escape(value, quote=True) if html_mode and not raw else value
    rendered = TOKEN.sub(replace, template or '')
    unchecked = POSTMARK.sub('', rendered)
    if '{{' in unchecked or '}}' in unchecked:
        raise Refused('unresolved_merge_token')
    return rendered


def render_message(row, variables) -> dict:
    for name in row.get('required_variables', []):
        if name not in variables or variables[name] is None or not str(variables[name]).strip():
            raise Refused('missing_variable', variable=name)
    return {'subject': render_template(row.get('subject', ''), variables),
            'html': render_template(row.get('html', row.get('body_html', '')), variables, True),
            'text': render_template(row.get('text_body', row.get('text', row.get('body_text', ''))), variables)}


def template_variables(row, variables):
    values = {name: '' for name in (row.get('meta') or {}).get('optional_variables', [])}
    values.update(variables)
    if 'body_html' in values and not values['body_html'] and values.get('body_text'):
        values['body_html'] = html.escape(str(values['body_text']), quote=True).replace('\n', '<br>\n')
    return values


def compose(template_row, variables, identity_row, purpose, transport):
    """Render a stored shell/body with identity-owned, digest-bound footers."""
    from . import policy
    row = dict(template_row)
    meta = row.get('meta') or {}
    if not meta.get('sendable', row.get('sendable', True)):
        raise Refused('template_not_sendable')
    if purpose not in row.get('allowed_purposes', [purpose]):
        raise Refused('template_purpose_not_allowed')
    if row.get('allowed_identities') and identity_row.get('key') not in row['allowed_identities']:
        raise Refused('template_identity_not_allowed')
    values = template_variables(row, variables)
    # Reserved variables cannot override the sending identity or policy.
    unsubscribe_html, unsubscribe_text = policy.unsubscribe(identity_row, purpose, transport)
    values.update(signature_html=identity_row.get('signature_html') or '',
                  signature_text=identity_row.get('signature_text') or '',
                  unsubscribe_html=unsubscribe_html, unsubscribe_text=unsubscribe_text,
                  preview=variables.get('preview', ''))
    # Legacy DB templates have no shell slots; retain their signatures inside the
    # rendered copy, just as shell-backed templates do.
    if '{{{signature_html}}}' not in row.get('html', ''):
        row['html'] = row.get('html', '') + '{{{signature_html}}}'
    if '{{signature_text}}' not in row.get('text_body', ''):
        row['text_body'] = row.get('text_body', '') + '\n\n{{signature_text}}'
    if '{{{unsubscribe_html}}}' not in row['html']:
        row['html'] += '{{{unsubscribe_html}}}'
    if '{{unsubscribe_text}}' not in row['text_body']:
        row['text_body'] += '\n\n{{unsubscribe_text}}'
    return render_message(row, values)
