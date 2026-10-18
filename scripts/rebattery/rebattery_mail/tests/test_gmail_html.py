"""Synthetic MIME and disposable-database HTML ingestion/backfill regressions."""
import base64
from contextlib import contextmanager

import psycopg2
import pytest

from rebattery_mail import backfill, cli
from rebattery_mail.core import ProviderError
from rebattery_mail.gmail_body import extract_bodies
from rebattery_mail.gmail_sync import sync_gmail
from test_read_sync import FakeGmail, gmail


def part(text, mime='text/html', charset='utf-8', attachment=False):
    headers = [{'name': 'Content-Type', 'value': mime + '; charset=' + charset}]
    if attachment:
        headers.append({'name': 'Content-Disposition', 'value': 'attachment; filename="mail.html"'})
    return {'mimeType': mime, 'headers': headers, 'body': {'data': base64.urlsafe_b64encode(text.encode(charset)).decode().rstrip('=')}}


def full(payload, body=''):
    return {'body': body, 'message': {'payload': payload}}


@pytest.mark.parametrize('payload', [
    part('<p>Raw &amp; intact</p>'),
    {'mimeType': 'multipart/alternative', 'parts': [part('plain', 'text/plain'), part('<p>Raw &amp; intact</p>')]},
    {'mimeType': 'multipart/related', 'parts': [{'mimeType': 'multipart/alternative', 'parts': [part('<p>Raw &amp; intact</p>')]}]},
])
def test_html_mime_shapes(payload):
    assert extract_bodies(full(payload))[1] == '<p>Raw &amp; intact</p>'


def test_largest_html_ignores_attachment_subtrees():
    payload = {'parts': [part('<b>short</b>'), part('<p>Largest real body</p>'), part('attachment' * 100, attachment=True), {'headers': [{'name':'Content-Disposition','value':'attachment'}], 'parts':[part('nested attachment' * 100)]}]}
    assert extract_bodies(full(payload)) == ('', '<p>Largest real body</p>', True)


def test_charset_and_urlsafe_unpadded_bytes():
    html = '<p>caf\u00e9 \u00ff\u00fe</p>'
    assert '-' in part(html, charset='latin-1')['body']['data'] or '_' in part(html, charset='latin-1')['body']['data']
    assert extract_bodies(full(part(html, charset='latin-1')))[1] == html


def test_unknown_charset_falls_back_and_invalid_utf8_replaces():
    payload = part('synthetic')
    payload['headers'][0]['value'] = 'text/html; charset=unknown-charset'
    payload['body']['data'] = base64.urlsafe_b64encode(b'<p>\xff</p>').decode()
    assert extract_bodies(full(payload))[1] == '<p>\ufffd</p>'


@pytest.mark.parametrize('payload', [None, [], {'parts':'odd'}, {'mimeType':'text/html','body':[]}, {'mimeType':'text/html','body':{'data':'%%%'}}, part('plain', 'text/plain')])
def test_missing_and_odd_html(payload):
    assert extract_bodies(full(payload))[1] is None


def test_plain_fallback_and_provider_body_precedence():
    payload = {'parts': [part('fallback', 'text/plain'), part('<p>html</p>')]}
    assert extract_bodies(full(payload))[0] == 'fallback'
    assert extract_bodies(full(payload, 'provider text'))[0] == 'provider text'


@pytest.fixture
def db(db_after_cutover):
    conn = psycopg2.connect(db_after_cutover)
    with conn.cursor() as cur:
        cur.execute("insert into crm_users(email,password_hash) values('alex@rebattery.io','synthetic') returning id")
        owner = cur.fetchone()[0]
    yield conn, owner
    conn.rollback()
    conn.close()


def query(db, sql, params=()):
    with db.cursor() as cur:
        cur.execute(sql, params)
        return cur.fetchall()


def seed(db, owner, id, **values):
    fields = dict(id=id, mailbox_owner_id=owner, gmail_message_id=id, direction='inbound', transport='gmail', state='received', sent_at='2026-10-16T10:00:00Z', body_text='Original text')
    fields.update(values)
    with db.cursor() as cur:
        cur.execute('insert into mail_message('+','.join(fields)+') values('+','.join(['%s']*len(fields))+')',tuple(fields.values()))


def test_sync_gap_fill_raw_and_idempotence(db):
    conn, _ = db
    mail = gmail('html')
    mail['body'] = ''
    mail['message']['payload'] = {'parts':[part('plain fallback', 'text/plain'), part('<script>raw()</script>')]}
    driver = FakeGmail({'html':mail})
    assert sync_gmail(conn,'alex@rebattery.io',apply=True,driver=driver)['counts']['html_missing'] == 0
    assert query(conn,'select body_text,body_html from mail_message') == [('plain fallback','<script>raw()</script>')]
    mail['message']['payload'] = part('<p>changed</p>')
    sync_gmail(conn,'alex@rebattery.io',apply=True,driver=driver)
    assert query(conn,'select body_html from mail_message') == [('<script>raw()</script>',)]
    query(conn,"update mail_message set body_html='' returning id")
    sync_gmail(conn,'alex@rebattery.io',apply=True,driver=driver)
    assert query(conn,'select body_html from mail_message') == [('<p>changed</p>',)]
    mail['message']['payload'] = None
    assert sync_gmail(conn,'alex@rebattery.io',apply=True,driver=driver)['counts']['html_missing'] == 1
    assert query(conn,'select body_html from mail_message') == [('<p>changed</p>',)]


def test_outbound_frozen_html_preserved_and_missing_filled(db):
    conn, owner = db
    seed(conn,owner,'frozen',direction='outbound',purpose='personal',state='accepted',body_html='<p>Approved</p>',body_text='Approved text')
    seed(conn,owner,'gap',direction='outbound',purpose='personal',state='accepted')
    mails = {id:gmail(id,sender='alex@rebattery.io',labels=['SENT']) for id in ('frozen','gap')}
    for mail in mails.values():
        mail['message']['payload'] = part('<p>Provider</p>')
    sync_gmail(conn,'alex@rebattery.io',apply=True,driver=FakeGmail(mails))
    assert query(conn,'select id,body_html,body_text from mail_message order by id') == [('frozen','<p>Approved</p>','Approved text'),('gap','<p>Provider</p>','Original text')]


def test_backfill_dry_run_apply_ordering_and_resume(db):
    conn, owner = db
    seed(conn,owner,'private-new',crm_visible=False,sent_at='2026-10-18T10:00:00Z')
    seed(conn,owner,'crm-old',crm_visible=True,sent_at='2026-10-15T10:00:00Z')
    seed(conn,owner,'crm-new',crm_visible=True)
    seed(conn,owner,'already',body_html='<p>Existing</p>')
    query(conn,"insert into crm_users(email,password_hash) values('other@example.test','synthetic') returning id")
    other = query(conn,"select id from crm_users where email='other@example.test'")[0][0]
    seed(conn,other,'other')
    calls = []
    class Driver:
        def fetch(self,account,id):
            calls.append(id)
            return {**full(part('<p>Raw</p>')), 'attachments':[{'filename':'synthetic.pdf'}]}
    result = backfill.backfill_html(conn,'alex@rebattery.io',driver=Driver(),sleep=0)
    assert result['first_ids'] == ['crm-new','crm-old','private-new']
    assert calls == result['first_ids']
    assert result['would_update'] == 3 and result['updated'] == 0
    assert query(conn,"select body_html from mail_message where id='crm-new'") == [(None,)]
    result = backfill.backfill_html(conn,'alex@rebattery.io',apply=True,driver=Driver(),sleep=0)
    assert result['updated'] == 3
    assert query(conn,"select body_html,has_attachments,body_text from mail_message where id='crm-new'") == [('<p>Raw</p>',True,'Original text')]
    assert backfill.backfill_html(conn,'alex@rebattery.io',apply=True,driver=Driver(),sleep=0)['selected'] == 0
    assert query(conn,"select body_html from mail_message where id='other'") == [(None,)]


def test_backfill_filters_limit_no_html_and_retry(db):
    conn, owner = db
    for id in ('a','b','c'):
        seed(conn,owner,id,crm_visible=id!='c',sent_at='2026-10-16T10:00:00Z' if id!='b' else '2026-10-10T10:00:00Z')
    result = backfill.backfill_html(conn,'alex@rebattery.io',since=backfill.since_date('2026/10/15'),limit=1,crm_only=True,apply=True,sleep=0,driver=FakeGmail({'a':full(part('plain','text/plain'))}))
    assert result['first_ids'] == ['a'] and result['no_html_ids'] == ['a'] and result['no_html'] == 1
    assert query(conn,"select body_html from mail_message where id='a'") == [(None,)]


def test_backfill_provider_errors_continue_and_reset(db):
    conn, owner = db
    for index in range(10):
        seed(conn,owner,str(index),crm_visible=True)
    class Driver:
        def fetch(self,account,id):
            if id == '4':
                return full(part('<p>Success</p>'))
            raise ProviderError('synthetic')
    result = backfill.backfill_html(conn,'alex@rebattery.io',apply=True,sleep=0,driver=Driver())
    assert result['updated'] == 1 and result['errors'] == 9 and result['aborted']
    assert result['error_ids'] == list('012356789')


def test_backfill_cli_abort_exits_three_preserving_progress(db,monkeypatch,capsys):
    conn, owner = db
    for index in range(7):
        seed(conn,owner,str(index))
    class Driver:
        def fetch(self,account,id):
            if id == '0':
                return full(part('<p>Kept</p>'))
            raise RuntimeError('private provider diagnostics')
    @contextmanager
    def fake_connection(**kwargs):
        yield conn
    monkeypatch.setattr(backfill,'connection',fake_connection)
    monkeypatch.setattr(backfill,'GmailDriver',Driver)
    assert cli.main(['backfill-html','--account','alex@rebattery.io','--apply','--sleep','0']) == 3
    import json
    output = json.loads(capsys.readouterr().out)
    assert output['updated'] == 1 and output['errors'] == 5 and output['aborted']
    assert output['error_ids'] == list('12345')
    assert query(conn,"select body_html from mail_message where id='0'") == [('<p>Kept</p>',)]
    assert 'private provider diagnostics' not in str(output)
