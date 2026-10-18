"""All capture records and contacts below are synthetic fixtures."""
import json
import os
from pathlib import Path

import psycopg2
import pytest

from rebattery_whatsapp.core import Refused, cursor
from rebattery_whatsapp.identity import ensure_identity, link, list_links, normalise_phone, proposals, unlink
from rebattery_whatsapp.ingest import ingest
from rebattery_whatsapp.read import thread_messages, threads_for_company, threads_for_person

ACCOUNT = '447700900000@s.whatsapp.net'
PHONE = '447911123456@s.whatsapp.net'


def event(kind='message', message='original', **extra):
    return {'schema': 2, 'account': ACCOUNT, 'chatId': PHONE, 'kind': kind, 'messageId': message,
      'direction': 'inbound', 'timestamp': 1700000000, 'capturedAt': '2023-11-14T23:00:00Z',
      'body': 'synthetic message', **extra}


def save(root, records):
    file = root / 'capture.jsonl'
    file.write_text(''.join(json.dumps(record) + '\n' for record in records))
    return file


def apply(root, db, **kwargs):
    return ingest(root, apply=True, expected_account=ACCOUNT, db=db, **kwargs)


def rows(db, table):
    with cursor(db) as cur:
        cur.execute('select * from ' + table)
        return cur.fetchall()


def person(db, identifier='person-one', phone='+44 7911 123456', company=None):
    with db, cursor(db) as cur:
        if company:
            cur.execute('insert into crm_companies(id,name) values(%s,%s) on conflict do nothing', (company, 'Synthetic Company'))
        cur.execute('insert into crm_people(id,full_name,phone,company_id) values(%s,%s,%s,%s)', (identifier, 'Synthetic Person', phone, company))
    return identifier


def test_replay_dual_edit_and_delete(db, tmp_path):
    original = event()
    edit = event('edit', 'edit-envelope', targetId='original', mutationTimestamp=1700000010, body='changed')
    update = {**edit, 'messageId': 'original', 'envelopeId': None, 'eventId': 'different-delivery'}
    delete = event('revoke', 'delete-envelope', targetId='original', mutationTimestamp=1700000020, body=None)
    save(tmp_path, [original, edit, update, delete])
    assert apply(tmp_path, db)['imported'] == 3
    assert apply(tmp_path, db)['imported'] == 0
    messages = rows(db, 'whatsapp_message')
    assert len(messages) == 1
    assert messages[0]['edit_version'] == 1 and messages[0]['deleted_at'] and messages[0]['body'] is None
    assert len(rows(db, 'whatsapp_event')) == 3


def test_before_original_reactions_and_reply(db, tmp_path):
    save(tmp_path, [event('edit', 'edit', targetId='original', mutationTimestamp=1700000010, body='edited'),
      event('message', 'reply', quotedId='original'), event('reaction', 'reaction', targetId='original', body='👍'), event()])
    apply(tmp_path, db)
    messages = {m['provider_message_id']: m for m in rows(db, 'whatsapp_message')}
    assert messages['original']['body'] == 'edited'
    assert messages['reply']['reply_to_message_id'] == messages['original']['id']
    assert messages['original']['metadata']['reactions']
    save(tmp_path, [event('revoke', 'delete', targetId='future', mutationTimestamp=1700000020, body=None), event(message='future')])
    apply(tmp_path, db)
    future = next(m for m in rows(db, 'whatsapp_message') if m['provider_message_id'] == 'future')
    assert future['deleted_at'] and future['body'] is None


def test_crash_partial_quarantine_truncation_rotation(db, tmp_path):
    file = save(tmp_path, [event()])
    with file.open('ab') as handle:
        handle.write(b'not-json\n{"schema":')
    def crash():
        raise RuntimeError('synthetic crash')
    with pytest.raises(RuntimeError):
        apply(tmp_path, db, after_record=crash)
    assert rows(db, 'whatsapp_message') == []
    assert rows(db, 'whatsapp_ingest_cursor') == []
    result = apply(tmp_path, db)
    assert result['quarantined'] == 1 and result['partial_files'] == 1
    checkpoint = rows(db, 'whatsapp_ingest_cursor')[0]
    assert checkpoint['byte_offset'] < file.stat().st_size
    file.write_text(json.dumps(event(message='second')) + '\n')
    apply(tmp_path, db)
    replacement = tmp_path / 'replacement'
    replacement.write_text(json.dumps(event(message='third')) + '\n')
    os.replace(replacement, file)
    apply(tmp_path, db)
    assert len(rows(db, 'whatsapp_message')) == 3
    assert sum(e['kind'] == 'quarantine' for e in rows(db, 'whatsapp_event')) == 1


def test_concurrent_import_refuses(db, tmp_path):
    save(tmp_path, [event()])
    other = psycopg2.connect(os.environ['DENCH_WHATSAPP_DSN'])
    try:
        with other.cursor() as cur:
            cur.execute('select pg_advisory_xact_lock(hashtextextended(%s,0))', ('whatsapp:' + ACCOUNT,))
        with pytest.raises(Refused, match='import_in_progress'):
            apply(tmp_path, db)
    finally:
        other.rollback()
        other.close()
    assert rows(db, 'whatsapp_message') == []


def test_exact_single_and_two_numbers_one_person(db, tmp_path):
    pid = person(db, company='company-one')
    save(tmp_path, [event(), event(message='second', chatId='447911123457@s.whatsapp.net')])
    assert apply(tmp_path, db)['auto_link_candidates'] == 1
    links = rows(db, 'whatsapp_identity_link')
    assert len(links) == 1 and links[0]['person_id'] == pid and links[0]['method'] == 'auto_e164'
    second = next(i for i in rows(db, 'whatsapp_identity') if i['canonical_jid'] == '447911123457@s.whatsapp.net')
    with db, cursor(db) as cur:
        link(cur, second['id'], pid)
    assert len(threads_for_person(db, pid)['threads']) == 2
    assert len(threads_for_company(db, 'company-one')['threads']) == 2
    assert len(rows(db, 'crm_people')) == 1


def test_ambiguity_confirm_shared_company_unknown_and_undo(db, tmp_path):
    first = person(db, 'person-one', company='company-one')
    second = person(db, 'person-two')
    save(tmp_path, [event(), event(message='lid-message', chatId='123456789@lid')])
    assert apply(tmp_path, db)['auto_link_candidates'] == 0
    identities = rows(db, 'whatsapp_identity')
    pn = next(i for i in identities if i['canonical_jid'] == PHONE)
    lid = next(i for i in identities if i['canonical_jid'].endswith('@lid'))
    assert lid['e164'] is None
    with db, cursor(db) as cur:
        candidates = proposals(cur, ACCOUNT)
        assert next(p for p in candidates if p['identity_id'] == pn['id'])['person_ids'] == [first, second]
        wrong = link(cur, pn['id'], first)
    assert threads_for_person(db, first)['threads']
    with db, cursor(db) as cur:
        unlink(cur, wrong, 'synthetic-operator')
        link(cur, pn['id'], second)
    assert not threads_for_person(db, first)['threads']
    assert threads_for_person(db, second)['threads']
    with db, cursor(db) as cur:
        link(cur, pn['id'], first, shared=True)
        link(cur, lid['id'], company_id='company-one')
    assert len(rows(db, 'crm_people')) == 2
    assert len(threads_for_company(db, 'company-one')['threads']) == 2
    assert next(l for l in rows(db, 'whatsapp_identity_link') if l['id'] == wrong)['valid_to']


def test_group_member_context_and_expiry(db, tmp_path):
    pid = person(db, company='company-one')
    save(tmp_path, [event(chatId='12345@g.us', participant=PHONE),
      event(message='view-once', flags={'viewOnce': True}),
      event(message='expired', flags={'expiresAt': '2020-01-01T00:00:00Z'})])
    apply(tmp_path, db)
    threads = threads_for_person(db, pid)['threads']
    assert any(t['shared_context'] for t in threads)
    for message in rows(db, 'whatsapp_message'):
        if message['provider_message_id'] in ('view-once', 'expired'):
            assert message['body'] is None
    group = next(t for t in threads if t['kind'] == 'group')
    assert len(thread_messages(db, group['id'])['messages']) == 1


def test_no_cross_account_and_dry_run(db, tmp_path):
    person(db)
    save(tmp_path, [event()])
    assert ingest(tmp_path, db=db)['auto_link_candidates'] == 1
    assert rows(db, 'whatsapp_message') == []
    save(tmp_path, [event(account='447700900001@s.whatsapp.net')])
    with pytest.raises(Refused, match='unexpected_account'):
        apply(tmp_path, db)
    ingest(tmp_path, True, expected_account='447700900001@s.whatsapp.net', db=db)
    save(tmp_path, [event()])
    apply(tmp_path, db)
    assert len(rows(db, 'whatsapp_thread')) == 2
    assert len({i['account_id'] for i in rows(db, 'whatsapp_identity')}) == 2


def test_membership_occurrences_and_legacy(db, tmp_path):
    records = [event('membership', None, chatId='12345@g.us', action=action, participants=[PHONE],
      provenance={'captureRunId': 'synthetic-run', 'sequence': sequence}) for sequence, action in enumerate(('add', 'remove', 'add'))]
    records.append(event(schema=1))
    save(tmp_path, records)
    assert apply(tmp_path, db)['imported'] == 4
    assert apply(tmp_path, db)['imported'] == 0
    assert len([e for e in rows(db, 'whatsapp_event') if e['kind'] == 'membership']) == 3
    assert rows(db, 'whatsapp_message')[0]['metadata']['expiry_policy_unavailable']


def test_phone_validation_never_guesses_country():
    assert normalise_phone('07911123456') == (None, None)
    assert normalise_phone('+44 7911 123456')[0] == '+447911123456'
    assert normalise_phone('+44 7911 123456 ext 42')[1] == '42'
    assert normalise_phone('+123') == (None, None)


def test_later_trusted_alias_preserves_thread_and_mutation_identity(db, tmp_path):
    lid = '123456789@lid'
    edit = event('edit', 'edit-envelope', chatId=lid, targetId='original',
                 mutationTimestamp=1700000010, body='edited')
    original = event(chatId=lid)
    save(tmp_path, [original, edit])
    apply(tmp_path, db)
    original_thread = rows(db, 'whatsapp_thread')[0]['id']
    alias = event('identity_alias', None, lid=lid, pn=PHONE, eventId='paired-alias')
    update = {**edit, 'chatId': PHONE, 'messageId': 'original'}
    save(tmp_path, [original, edit, alias, update])
    apply(tmp_path, db)
    assert len(rows(db, 'whatsapp_thread')) == 1
    assert rows(db, 'whatsapp_thread')[0]['id'] == original_thread
    assert rows(db, 'whatsapp_message')[0]['edit_version'] == 1
    mutation = next(e for e in rows(db, 'whatsapp_event') if e['kind'] == 'edit')
    assert len(mutation['provenance']['deliveries']) == 2
    save(tmp_path, [event('identity_alias', None, lid=lid, pn='447911123457@s.whatsapp.net')])
    with pytest.raises(Refused, match='conflicting_alias_merge'):
        apply(tmp_path, db)


def test_uncertain_edits_and_out_of_order_projection(db, tmp_path):
    save(tmp_path, [event(), event('edit', 'newer', targetId='original',
      mutationTimestamp=1700000030, body='latest'),
      event('edit', 'older', targetId='original', mutationTimestamp=1700000020, body='earlier'),
      event('edit', 'unknown-one', targetId='original', eventId='uncertain-one', body='uncertain'),
      event('edit', 'unknown-two', targetId='original', eventId='uncertain-two', body='uncertain')])
    apply(tmp_path, db)
    message = rows(db, 'whatsapp_message')[0]
    assert message['body'] == 'latest'
    assert message['edit_version'] == 4
    assert apply(tmp_path, db)['imported'] == 0


def test_undo_is_not_reversed_by_next_import(db, tmp_path):
    person(db)
    save(tmp_path, [event()])
    apply(tmp_path, db)
    linked = rows(db, 'whatsapp_identity_link')[0]
    with db, cursor(db) as cur:
        unlink(cur, linked['id'])
    save(tmp_path, [event(), event(message='later')])
    assert apply(tmp_path, db)['auto_link_candidates'] == 0
    assert not any(linked['valid_to'] is None for linked in rows(db, 'whatsapp_identity_link'))


def test_reaction_order_and_capture_health(db, tmp_path):
    save(tmp_path, [event(), event('reaction', 'recent', targetId='original', body='👍', timestamp=1700000030),
                   event('reaction', 'older', targetId='original', body='👎', timestamp=1700000020)])
    (tmp_path / 'status.json').write_text(json.dumps({
      'account': ACCOUNT, 'state': 'connected', 'heartbeatAt': '2023-11-14T23:00:00Z',
      'lastGap': {'since': '2023-11-14T22:00:00Z', 'until': '2023-11-14T23:00:00Z', 'catchUpVerified': False},
      'private_unrecognised_field': 'must not import'}))
    apply(tmp_path, db)
    reaction = next(iter(rows(db, 'whatsapp_message')[0]['metadata']['reactions'].values()))
    assert reaction['text'] == '👍'
    health = rows(db, 'whatsapp_account')[0]['metadata']['capture_status']
    assert health['state'] == 'connected' and health['lastGap']['catchUpVerified'] is False
    assert 'private_unrecognised_field' not in health


def test_write_connections_require_explicit_dsn(monkeypatch):
    from rebattery_whatsapp.core import connection
    monkeypatch.delenv('DENCH_WHATSAPP_DSN', raising=False)
    with pytest.raises(Refused) as refused:
        connection()
    assert refused.value.rule == 'explicit_database_required'
