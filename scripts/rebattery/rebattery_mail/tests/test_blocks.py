"""Synthetic semantic mail coverage; no provider calls or production writes."""
import json
import shutil
from pathlib import Path
from types import SimpleNamespace as NS

import pytest
from rebattery_mail import blocks, draft, template
from rebattery_mail.core import Refused, connection
from rebattery_mail.digest import digest
from rebattery_mail.catalogue import load_catalogue
from rebattery_mail.templating import compose

BASE = Path(__file__).parent / 'fixtures' / 'block-base'
ALL = [
    {'type': 'heading', 'text': 'An update'},
    {'type': 'paragraph', 'text': 'Plain & useful <copy>.'},
    {'type': 'section_label', 'text': 'Details'},
    {'type': 'bullets', 'items': ['First', 'Second']},
    {'type': 'numbered', 'items': ['Check', 'Reply']},
    {'type': 'fact_box', 'rows': [{'label': 'Status', 'value': 'Confirmed'}]},
    {'type': 'key_values', 'rows': [{'label': 'Next', 'value': 'Review'}]},
    {'type': 'cta', 'label': 'Review details', 'url': 'https://example.test/review?a=1&b=2'},
    {'type': 'note', 'text': 'For reference.'},
    {'type': 'divider'},
    {'type': 'signoff', 'text': 'Best,'},
]


@pytest.fixture(autouse=True)
def local_helpers(monkeypatch, tmp_path):
    shutil.copytree(BASE, tmp_path / 'base')
    monkeypatch.setattr(blocks, 'CATALOGUE', tmp_path)
    return tmp_path


def test_all_blocks_golden():
    result = blocks.compose_blocks({'greeting': 'Hi {{first_name}},', 'blocks': ALL})
    assert result['body_html'] == (BASE.parent / 'blocks-golden.html').read_text()
    assert result['body_text'] == (BASE.parent / 'blocks-golden.txt').read_text()
    assert result['variables_used'] == ['first_name']
    assert result['warnings'] == []


@pytest.mark.parametrize('document,rule', [
    (None, 'invalid_block_schema'), ({'blocks': []}, 'invalid_block_schema'),
    ([{'type': 'raw', 'html': '<b>x</b>'}], 'unknown_block_type'),
    ([{'type': 'paragraph', 'text': 'x', 'extra': True}], 'invalid_block_schema'),
    ([{'type': 'paragraph', 'text': 2}], 'invalid_block_schema'),
    ([{'type': 'bullets', 'items': 'x'}], 'invalid_block_schema'),
    ([{'type': 'key_values', 'rows': [{'label': 'x'}]}], 'invalid_block_schema'),
    ([{'type': 'cta', 'label': 'Go'}], 'invalid_block_schema'),
])
def test_schema(document, rule):
    with pytest.raises(Refused, match=rule):
        blocks.compose_blocks(document)


@pytest.mark.parametrize('url', ['javascript:alert(1)', 'http://example.test', '//example.test', 'https://', 'https://example.test/\n', 'https://example.test/{{url}}'])
def test_unsafe_links(url):
    with pytest.raises(Refused, match='unsafe_block_url'):
        blocks.compose_blocks([{'type': 'cta', 'label': 'Go', 'url': url}])


@pytest.mark.parametrize('url', ['https://example.test', 'mailto:team@example.test', 'tel:+441234567890'])
def test_allowed_links(url):
    result = blocks.compose_blocks([{'type': 'cta', 'label': 'Contact', 'url': url}])
    assert url in result['body_text'] and url in result['body_html']


def test_hostile_text_and_tokens():
    result = blocks.compose_blocks([{'type': 'paragraph', 'text': '<script>alert("x")</script> {{{ x }}} {{signature_html}} {% x %} {{name}}'}])
    assert '<script>' not in result['body_html']
    assert '&lt;script&gt;' in result['body_html']
    assert '{{{' not in result['body_html'] and '{{signature_html}}' not in result['body_html']
    assert '｛｛｛ x ｝｝｝' in result['body_text']
    assert result['variables_used'] == ['name']
    row = blocks.oneoff_template(result, 'Update', 'alex')
    rendered = compose(row, {'name': '<img src=x>'}, {'key': 'alex'}, 'personal', 'gmail')
    assert '<img src=x>' not in rendered['html']
    assert '&lt;img src=x&gt;' in rendered['html']


def test_one_ask_and_warnings():
    cta = {'type': 'cta', 'label': 'https://example.test', 'url': 'https://example.test'}
    with pytest.raises(Refused, match='multiple_ctas'):
        blocks.compose_blocks([cta, cta])
    assert blocks.compose_blocks([cta, cta], allow_multiple_cta=True)
    result = blocks.compose_blocks([{'type': 'paragraph', 'text': 'word ' * 121 + '—!'}, cta])
    assert {w['code'] for w in result['warnings']} == {'no_greeting', 'missing_signoff', 'long_paragraph', 'em_dash', 'exclamation_mark', 'bare_url_label'}


def test_identity_restriction():
    doc = {'allowed_identities': ['ari'], 'blocks': ALL}
    with pytest.raises(Refused, match='template_identity_not_allowed'):
        blocks.compose_blocks(doc, identity='alex')


def test_draft_digest_signature_and_policy(db_after_cutover):
    with connection() as db:
        with db.cursor() as cur:
            cur.execute("update mail_identity set signature_html='<p>Synthetic signature</p>',signature_text='Synthetic signature' where key='alex'")
        doc = {'greeting': 'Hi {{name}},', 'blocks': ALL}
        row, _ = draft.prepare(db, 'alex', ['synthetic@example.test'], subject='Update', variables={'name': 'Reader'}, oneoff_blocks=doc)
        assert 'Hi Reader,' in row['body_text']
        assert row['body_text'].count('Synthetic signature') == 1
        assert row['body_html'].count('Synthetic signature') == 1
        before = digest([row])
        changed, _ = draft.prepare(db, 'alex', ['synthetic@example.test'], subject='Update', variables={'name': 'Reader'}, oneoff_blocks=[{'type': 'paragraph', 'text': 'Different body'}], message_id=row['id'])
        assert before != digest([changed])
        with db.cursor() as cur:
            cur.execute("update mail_identity set signature_text='Changed signature' where key='alex'")
        changed, _ = draft.prepare(db, 'alex', ['synthetic@example.test'], subject='Update', variables={'name': 'Reader'}, oneoff_blocks=doc, message_id=row['id'])
        assert before != digest([changed])
        marketing, _ = draft.prepare(db, 'alex', ['synthetic@example.test'], purpose='marketing', transport='gmail', subject='Update', variables={'name': 'Reader'}, oneoff_blocks=doc)
        assert 'Unsubscribe:' in marketing['body_text']
        assert '>Unsubscribe</a>' in marketing['body_html']
        with pytest.raises(Refused, match='template_identity_not_allowed'):
            draft.prepare(db, 'alex', ['synthetic@example.test'], subject='Update', oneoff_blocks={'allowed_identities': ['ari'], 'blocks': ALL})
        with pytest.raises(Refused, match='identity_unavailable'):
            draft.prepare(db, 'missing', ['synthetic@example.test'], subject='Update', oneoff_blocks=ALL)
        draft.insert(db, row)
    preview = draft.preview(NS(target=row['id']))
    assert preview['sha256'] == before
    assert preview['messages'][0]['body_html'] == row['body_html']


def test_compose_and_save_commands(local_helpers):
    args = NS(action='compose', blocks=json.dumps({'greeting': 'Hi,', 'blocks': ALL}), identity='alex', allow_multiple_cta=False, out_dir=str(local_helpers / 'out'))
    result = template.handle(args)
    assert (local_helpers / 'out/body.html').read_text() == result['body_html']
    args.action, args.name, args.subject, args.purpose, args.apply = 'save-oneoff', 'saved-update', 'An update', 'personal', False
    planned = template.handle(args)
    assert len(planned['files']) == 3
    assert not (local_helpers / 'custom/oneoff').exists()
    args.apply = True
    template.handle(args)
    assert all(Path(path).exists() for path in planned['files'])
    # A normal indexed catalogue and saved unindexed one-off load together.
    original = local_helpers / 'custom' / 'original'
    for ext, content in [('json', next(v for k,v in planned['files'].items() if k.endswith('.json'))), ('html', '<p>Hello</p>'), ('txt', 'Hello')]:
        if ext == 'json':
            meta = json.loads(content)
            meta['name'] = 'original'
            content = json.dumps(meta)
        original.with_suffix('.' + ext).write_text(content)
    (local_helpers / 'index.json').write_text('["original"]')
    rows, _ = load_catalogue(local_helpers)
    assert [r['name'] for r in rows] == ['original', 'saved-update']
    assert rows[1]['meta']['category'] == 'oneoff'
    with pytest.raises(Refused, match='oneoff_template_exists'):
        template.handle(args)
