"""Synthetic-only catalogue coverage; no providers or real customer copy."""
import json
from copy import deepcopy
from types import SimpleNamespace as NS
import pytest
from rebattery_mail import draft, policy, campaign
from rebattery_mail.core import connection, Refused
from rebattery_mail.templating import compose, render_template
from rebattery_mail.template import sync_catalogue, find_template
from rebattery_mail.catalogue import load_catalogue, validate_catalogue, preview_catalogue
from rebattery_mail.digest import digest


@pytest.fixture
def catalogue(tmp_path):
    for folder in ('base', 'presets/synthetic', 'snapshots', 'signatures'):
        (tmp_path / folder).mkdir(parents=True)
    (tmp_path / 'base/layout.html').write_text('<html><title>{{preview}}</title><body>{{{content}}}</body></html>')
    (tmp_path / 'base/layout.txt').write_text('{{{content}}}')
    for key in ('alex', 'ari', 'support'):
        (tmp_path / 'signatures' / (key + '.html')).write_text('<p>' + key + ' signature</p>')
        (tmp_path / 'signatures' / (key + '.txt')).write_text(key + ' signature')
    meta = dict(name='synthetic-template', version=1, category='synthetic', purpose='personal',
                description='Synthetic only', subject='Hello {{name}}', required_variables=['name', 'url'],
                optional_variables=[], allowed_identities=[], allowed_purposes=['personal', 'marketing', 'transactional'],
                sendable=True, sample_vars={'name': 'Synthetic', 'url': 'https://www.rebattery.io/synthetic'})
    path = tmp_path / 'presets/synthetic/synthetic-template'
    path.with_suffix('.json').write_text(json.dumps(meta))
    path.with_suffix('.html').write_text('<p>{{name}}</p><a href="{{url}}">View</a>')
    path.with_suffix('.txt').write_text('{{name}}\n{{url}}')
    snapshot = {**meta, 'name': 'synthetic-snapshot', 'sendable': False}
    (tmp_path / 'snapshots/synthetic-snapshot.json').write_text(json.dumps(snapshot))
    (tmp_path / 'snapshots/synthetic-snapshot.html').write_text('<p>Rendered reference</p>')
    (tmp_path / 'index.json').write_text(json.dumps([meta, snapshot]))
    return tmp_path


@pytest.mark.parametrize('purpose,transport', [('personal', 'gmail'), ('transactional', 'gmail'), ('transactional', 'postmark-transactional'), ('marketing', 'gmail'), ('marketing', 'postmark-broadcast')])
@pytest.mark.parametrize('identity', ['alex', 'hello'])
def test_compose_catalogue(catalogue, purpose, transport, identity):
    rows, signatures = load_catalogue(catalogue)
    author = {'key': identity, 'address': identity + '@example.test', **signatures.get(identity, {})}
    rendered = compose(rows[0], {**rows[0]['meta']['sample_vars'], 'name': '<Synthetic>'}, author, purpose, transport)
    assert '<html>' in rendered['html'] and '&lt;Synthetic&gt;' in rendered['html']
    assert ('alex signature' in rendered['html']) == (identity == 'alex')
    assert ('Unsubscribe' in rendered['text'] or policy.UNSUBSCRIBE in rendered['text']) == (purpose == 'marketing')
    policy.content(dict(body_html=rendered['html'], body_text=rendered['text'], purpose=purpose, transport=transport))
    if purpose == 'marketing' and transport == 'postmark-broadcast':
        assert policy.UNSUBSCRIBE in rendered['html'] and policy.UNSUBSCRIBE in rendered['text']


@pytest.mark.parametrize('name', ['content', 'signature_html', 'unsubscribe_html', 'body_html'])
def test_reserved_raw(name):
    assert render_template('{{{' + name + '}}}', {name: '<b>safe</b>'}, True) == '<b>safe</b>'


@pytest.mark.parametrize('token', ['{{{name}}}', '{{{ signature_html }}}', '{{broken', '{{name}}'])
def test_raw_restrictions_and_literal_values(token):
    with pytest.raises(Refused, match='unresolved_merge_token'):
        render_template(token, {'name': '{{literal}}'}, True)
    assert render_template('{{{ pm:unsubscribe }}}', {}) == policy.UNSUBSCRIBE


def test_compose_refusals(catalogue):
    rows, _ = load_catalogue(catalogue)
    author = {'key': 'alex', 'address': 'alex@example.test'}
    with pytest.raises(Refused, match='template_not_sendable'):
        compose(rows[1], {}, author, 'personal', 'gmail')
    row = deepcopy(rows[0])
    row['allowed_identities'] = ['ari']
    with pytest.raises(Refused, match='template_identity_not_allowed'):
        compose(row, {}, author, 'personal', 'gmail')
    row['allowed_identities'] = []
    row['allowed_purposes'] = ['marketing']
    with pytest.raises(Refused, match='template_purpose_not_allowed'):
        compose(row, {}, author, 'personal', 'gmail')
    with pytest.raises(Refused, match='missing_variable'):
        compose(rows[0], {}, author, 'personal', 'gmail')


def test_validation_and_preview(catalogue, tmp_path):
    rows, signatures = load_catalogue(catalogue)
    assert validate_catalogue(rows, signatures) == {'valid': True, 'templates': 2, 'sendable': 1}
    output = tmp_path / 'rendered'
    assert preview_catalogue(rows, signatures, output)['templates'] == 2
    sheet = (output / 'sheet.html').read_text()
    assert 'synthetic-template' in sheet and 'synthetic-snapshot' in sheet and 'reference only' in sheet
    assert 'alex signature' in (output / 'synthetic-template.html').read_text()


@pytest.mark.parametrize('change,rule', [('undeclared', 'template_variable_mismatch'), ('unused', 'template_variable_mismatch'), ('dash', 'template_em_dash'), ('links', 'template_link_mismatch'), ('raw', 'unresolved_merge_token'), ('unsubscribe', 'marketing_requires_unsubscribe')])
def test_validation_failures(catalogue, change, rule, monkeypatch):
    rows, signatures = load_catalogue(catalogue)
    if change == 'undeclared': rows[0]['html'] += '{{unknown}}'
    if change == 'unused': rows[0]['meta']['optional_variables'].append('unused')
    if change == 'dash': rows[0]['subject'] += '—'
    if change == 'links': rows[0]['html'] += '<a href="https://example.test/extra">Extra</a>'
    if change == 'raw': rows[0]['html'] += '{{{unknown}}}'
    if change == 'unsubscribe': monkeypatch.setattr(policy, 'unsubscribe', lambda *a: ('', ''))
    with pytest.raises(Refused, match=rule):
        validate_catalogue(rows, signatures)


def test_sync_and_digest(catalogue, db_after_cutover):
    rows, signatures = load_catalogue(catalogue)
    with connection() as db:
        before = sync_catalogue(db, rows, signatures)
        assert before['dry_run'] and before['inserted'] == 2
        with db.cursor() as cur:
            cur.execute('select count(*) from mail_template where name like %s', ('synthetic-%',))
            assert cur.fetchone()[0] == 0
            cur.execute("update mail_identity set signature_html='Keep support', signature_text='Keep support' where key='support'")
        assert sync_catalogue(db, rows, signatures, True)['inserted'] == 2
        assert sync_catalogue(db, rows, signatures, True)['unchanged'] == 2
        assert sync_catalogue(db, rows, signatures, True)['signatures_updated'] == 0
        with db.cursor() as cur:
            cur.execute("select signature_text from mail_identity where key='support'")
            assert cur.fetchone()[0] == 'Keep support'
        changed = deepcopy(rows)
        changed[0]['subject'] += ' changed'
        with pytest.raises(Refused, match='template_version_conflict'):
            sync_catalogue(db, changed, signatures, True)
        changed[0]['version'] = 2
        assert sync_catalogue(db, changed, signatures, True)['inserted'] == 1
        row, _ = draft.prepare(db, 'alex', ['synthetic@example.test'], template='synthetic-template', variables=rows[0]['meta']['sample_vars'])
        assert 'alex signature' in row['body_text']
        sha = digest([row])
        with db.cursor() as cur:
            cur.execute("update mail_identity set signature_text='Changed signature' where key='alex'")
        second, _ = draft.prepare(db, 'alex', ['synthetic@example.test'], template='synthetic-template', variables=rows[0]['meta']['sample_vars'], message_id=row['id'])
        assert digest([second]) != sha
        campaign.validate_links(row, [{'key': 'view', 'url': 'https://www.rebattery.io/synthetic'}])
        with pytest.raises(Refused, match='template_not_sendable'):
            draft.prepare(db, 'alex', ['synthetic@example.test'], template='synthetic-snapshot')


def test_freeform_text_body_is_escaped():
    row = {'subject': '{{subject}}', 'html': '{{{body_html}}}', 'text_body': '{{body_text}}',
           'required_variables': ['subject', 'body_text'], 'meta': {'optional_variables': ['body_html']}}
    rendered = compose(row, {'subject': 'Synthetic', 'body_text': '<Unsafe>\nNext'},
                       {'key': 'hello', 'address': 'hello@example.test'}, 'personal', 'gmail')
    assert '&lt;Unsafe&gt;<br>\nNext' in rendered['html']
    assert '<Unsafe>\nNext' in rendered['text']


def test_campaign_freeze_composes_signature_and_footers(catalogue, db_after_cutover):
    rows, signatures = load_catalogue(catalogue)
    rows[0]['name'] = 'synthetic-freeze-template'
    with connection() as db, db.cursor() as cur:
        sync_catalogue(db, rows, signatures, True)
        cur.execute("insert into crm_people(id,full_name,first_name,email) values ('synthetic-freeze-person','Synthetic','Synthetic','synthetic-freeze@example.test')")
    args = NS(identity='alex', purpose='marketing', transport='gmail', template=rows[0]['name'],
              vars=json.dumps(rows[0]['meta']['sample_vars']), subject=None, body=None, html=None,
              verification=json.dumps({'synthetic-freeze@example.test': {'status': 'valid'}}),
              id='synthetic-freeze-campaign', name='Synthetic campaign', person_ids='synthetic-freeze-person',
              cohort_sql=None, links=json.dumps([{'key': 'view', 'url': 'https://www.rebattery.io/synthetic'}]),
              personalization='{}', listing_id=None, auction_url=None, type='marketing', pilot_cap=1, apply=True)
    campaign.create(args)
    class FakeProvider:
        def preflight(self, *args):
            return {}
    result = campaign.freeze(NS(target=args.id, apply=True), FakeProvider())
    message = result['messages'][0]
    assert 'alex signature' in message['body_html'] and 'alex signature' in message['body_text']
    assert 'Unsubscribe: mailto:alex@rebattery.io?subject=unsubscribe' in message['body_text']
    assert result['sha256'] == digest(result['messages'])
    assert message['links'][0]['cta_key'] == 'view'


def test_visible_html_urls_match_text_and_campaign_tracking():
    from rebattery_mail.catalogue import links
    content = {'html': '<p>https://www.rebattery.io/synthetic</p>', 'text': 'https://www.rebattery.io/synthetic'}
    assert links(content) == ({content['text']}, {content['text']})
    message = {'body_html': '<p>Shared shell</p>', 'body_text': 'Shared shell',
               'personalization': {'template_link_scope': content}}
    campaign.validate_links(message, [{'key': 'view', 'url': content['text']}])


def test_text_only_draft_gets_html_body(monkeypatch):
    author = {'address': 'alex@example.test', 'signature_text': 'Alex', 'signature_html': '<p>sig</p>'}
    monkeypatch.setattr(draft.policy, 'identity', lambda db, key, purpose, transport: (author, 'gmail'))
    monkeypatch.setattr(draft.policy, 'content', lambda row: None)
    row, _ = draft.prepare(None, 'alex', ['synthetic@example.test'], subject='Hi', body='Hello <b>there</b>\nline two\n\nSecond paragraph')
    assert row['body_html'].startswith('<p')
    assert 'Hello &lt;b&gt;there&lt;/b&gt;<br>\nline two' in row['body_html']
    assert '<p style="margin:0 0 14px;font-size:15px;line-height:1.6;">Second paragraph</p>' in row['body_html']
    assert row['body_html'].endswith('<p>sig</p>')
    assert row['body_text'].startswith('Hello <b>there</b>') and row['body_text'].endswith('Alex')
