"""Synthetic fixtures only. Storage is faked: no S3, rclone or WhatsApp access."""
import argparse
import hashlib
import json

import pytest

from rebattery_whatsapp import media_store
from rebattery_whatsapp.commands_read import attachment_get, register_attachment_command
from rebattery_whatsapp.core import ProviderError, Refused, cursor
from rebattery_whatsapp.retention import purge_media, stale_media
from test_whatsapp import ACCOUNT, apply, event, rows, save

DATA = b'synthetic safety data sheet'
SHA = hashlib.sha256(DATA).hexdigest()
REF = media_store.object_key(ACCOUNT, '447911123456@s.whatsapp.net', 'doc1', SHA)
ATTACHMENT = {'type': 'document', 'mime': 'application/pdf', 'filename': 'sds.pdf', 'size': len(DATA), 'sha256': SHA, 'seconds': None}


def media(status='stored', message='doc1', **extra):
    body = {'status': status, 'ref': REF if status == 'stored' else None, 'sha256': SHA, 'size': len(DATA), 'mime': 'application/pdf',
            'filename': 'sds.pdf', 'type': 'document', 'error': None if status == 'stored' else 'media_expired',
            'attempts': 1, 'retryAt': None, 'storedAt': '2023-11-14T23:00:05Z' if status == 'stored' else None}
    return event('media', message, targetId=message, body=None, media=body, eventId=f'media-{status}-{extra.get("n", 1)}')


def message(db):
    with cursor(db) as cur:
        cur.execute("select * from whatsapp_message where provider_message_id='doc1'")
        return cur.fetchone()


class FakeStore:
    def __init__(self, objects=None):
        self.objects = dict(objects or {})
        self.deleted = []

    def get(self, key, out, sha256=None):
        if key not in self.objects:
            raise media_store.StoreError('object_not_found')
        data = self.objects[key]
        if hashlib.sha256(data).hexdigest() != (sha256 or key[-64:]):
            raise media_store.StoreError('sha256_mismatch')
        try:
            handle = open(out, 'xb')
        except FileExistsError as exc:
            raise media_store.StoreError('output_exists') from exc
        with handle:
            handle.write(data)
        return {'path': out, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

    def delete(self, key):
        self.deleted.append(key)
        self.objects.pop(key, None)
        return {'ref': key, 'deleted': True}


def args(message_id, out):
    return argparse.Namespace(id=message_id, out=str(out))


def test_object_key_is_stable_hashed_and_content_addressed():
    assert REF == media_store.object_key('447700900000:3@s.whatsapp.net', '447911123456@s.whatsapp.net', 'doc1', SHA)
    assert '4479' not in REF and 'sds' not in REF
    assert REF.endswith('doc1-' + SHA)
    with pytest.raises(media_store.StoreError):
        media_store.object_key(ACCOUNT, 'chat', 'doc1', 'nothex')


def test_stored_media_is_projected_onto_the_attachment_and_survives_redelivery(db, tmp_path):
    save(tmp_path, [event(message='doc1', attachment=ATTACHMENT, body=None), media()])
    apply(tmp_path, db)
    row = message(db)
    assert row['attachment']['download_status'] == 'stored' and row['attachment']['ref'] == REF
    assert row['attachment']['sha256'] == SHA and row['metadata']['content_not_downloaded'] is False
    # A history re-delivery of the original line must not erase the storage ref.
    with (tmp_path / 'capture.jsonl').open('a') as handle:
        handle.write(json.dumps(event(message='doc1', attachment=ATTACHMENT, body=None, origin='history')) + '\n')
    apply(tmp_path, db)
    assert message(db)['attachment']['ref'] == REF


def test_failure_is_recorded_and_a_later_success_replaces_it_but_never_the_reverse(db, tmp_path):
    save(tmp_path, [event(message='doc1', attachment=ATTACHMENT, body=None), media('failed')])
    apply(tmp_path, db)
    row = message(db)
    assert row['attachment']['download_status'] == 'failed' and row['attachment']['download_error'] == 'media_expired'
    assert row['attachment']['ref'] is None and row['metadata']['content_not_downloaded'] is True
    with (tmp_path / 'capture.jsonl').open('a') as handle:
        handle.write(json.dumps(media('stored')) + '\n')
        handle.write(json.dumps(media('failed', n=2)) + '\n')
    apply(tmp_path, db)
    assert message(db)['attachment']['download_status'] == 'stored'


def test_media_for_view_once_or_revoked_messages_is_never_attached(db, tmp_path):
    flags = {'viewOnce': True, 'expiresAt': None}
    save(tmp_path, [event(message='doc1', attachment=ATTACHMENT, body=None, flags=flags), {**media(), 'flags': flags}])
    apply(tmp_path, db)
    row = message(db)
    assert row['attachment'] is None and row['metadata']['content_redacted'] is True
    # The ref is kept only so retention can delete the object; it is never exposed on the message.
    with db, cursor(db) as cur:
        assert [r['ref'] for r in stale_media(cur, ACCOUNT, [])] == [REF]


def test_revoked_message_drops_stored_ref_from_the_message_and_flags_the_object_for_purge(db, tmp_path):
    save(tmp_path, [event(message='doc1', attachment=ATTACHMENT, body=None), media(),
                    event('revoke', 'env1', targetId='doc1', mutationTimestamp=1700000100, body=None)])
    apply(tmp_path, db)
    row = message(db)
    assert row['deleted_at'] is not None and row['attachment'] is None
    with db, cursor(db) as cur:
        stale = stale_media(cur, ACCOUNT, [])
        assert [r['ref'] for r in stale] == [REF]
        fake = FakeStore({REF: DATA})
        original = media_store.delete
        media_store.delete = fake.delete
        try:
            assert purge_media(cur, stale) == 1
        finally:
            media_store.delete = original
        assert fake.deleted == [REF] and stale_media(cur, ACCOUNT, []) == []


def test_attachment_get_writes_the_verified_file(db, tmp_path):
    save(tmp_path, [event(message='doc1', attachment=ATTACHMENT, body=None), media()])
    apply(tmp_path, db)
    out = tmp_path / 'out'
    result = attachment_get(db, args('doc1', out), store=FakeStore({REF: DATA}))
    assert (out / 'sds.pdf').read_bytes() == DATA
    assert result['sha256'] == SHA and result['source_ref'].startswith('whatsapp:message:')
    again = attachment_get(db, args(message(db)['id'], out), store=FakeStore({REF: DATA}))
    assert again['path'].endswith('sds-1.pdf'), 'never overwrites an existing file'


def test_attachment_get_refuses_unstored_deleted_and_corrupt(db, tmp_path):
    save(tmp_path, [event(message='doc1', attachment=ATTACHMENT, body=None), media('failed')])
    apply(tmp_path, db)
    with pytest.raises(Refused) as exc:
        attachment_get(db, args('doc1', tmp_path / 'o'), store=FakeStore())
    assert exc.value.rule == 'attachment_not_stored'
    with pytest.raises(Refused) as exc:
        attachment_get(db, args('missing', tmp_path / 'o'), store=FakeStore())
    assert exc.value.rule == 'message_not_found'
    save(tmp_path, [event(message='doc2', attachment=ATTACHMENT, body=None), media(message='doc2')])
    apply(tmp_path, db)
    with pytest.raises(ProviderError) as exc:
        attachment_get(db, args('doc2', tmp_path / 'o'), store=FakeStore({REF: b'tampered'}))
    assert exc.value.rule == 'attachment_download_failed'
    with db, cursor(db) as cur:
        cur.execute("update whatsapp_message set deleted_at=now() where provider_message_id='doc2'")
    with pytest.raises(Refused) as exc:
        attachment_get(db, args('doc2', tmp_path / 'o'), store=FakeStore({REF: DATA}))
    assert exc.value.rule == 'attachment_unavailable'


def test_store_rejects_unsafe_keys_and_hash_mismatch_before_any_upload():
    with pytest.raises(media_store.StoreError) as exc:
        media_store.get('../../etc/passwd', '/tmp/x', None, env={})
    assert exc.value.code == 'invalid_key'
    with pytest.raises(media_store.StoreError) as exc:
        media_store.put(REF, b'other bytes', SHA, env={})
    assert exc.value.code == 'sha256_mismatch'


def test_attachment_subcommand_is_registered():
    parser = argparse.ArgumentParser()
    register_attachment_command(parser.add_subparsers(dest='command'))
    parsed = parser.parse_args(['attachment', 'get', 'abc', '--out', '/tmp/o'])
    assert (parsed.command, parsed.action, parsed.id) == ('attachment', 'get', 'abc')



class FakeRclone:
    """Stands in for rclone: an in-memory object store, with `cat` of a missing key exiting 0 and empty like the real one."""
    def __init__(self):
        self.objects, self.calls = {}, []

    def __call__(self, argv, env, stdin=None, stdout=None):
        verb, remote = argv[0], argv[1].split(':', 1)[1]
        self.calls.append(verb)
        result = argparse.Namespace(returncode=0, stdout=b'')
        if verb == 'rcat':
            self.objects[remote] = stdin
        elif verb == 'cat':
            result.stdout = self.objects.get(remote, b'')
        elif verb == 'lsf':
            result.stdout = b'x\n' if remote in self.objects else b''
        elif verb == 'deletefile':
            self.objects.pop(remote)
        return result


def test_store_put_get_delete_verify_and_are_idempotent(monkeypatch, tmp_path):
    fake = FakeRclone()
    monkeypatch.setattr(media_store, '_run', fake)
    assert media_store.put(REF, DATA, SHA, env={})['size'] == len(DATA)
    assert media_store.put(REF, DATA, SHA, env={})['size'] == len(DATA)
    assert fake.calls.count('rcat') == 1, 'existing identical object is not uploaded twice'
    got = media_store.get(REF, str(tmp_path / 'f'), SHA, env={})
    assert (tmp_path / 'f').read_bytes() == DATA and oct((tmp_path / 'f').stat().st_mode & 0o777) == '0o600' and got['sha256'] == SHA
    assert media_store.delete(REF, env={})['deleted'] and media_store.delete(REF, env={})['deleted']
    with pytest.raises(media_store.StoreError) as exc:
        media_store.get(REF, str(tmp_path / 'g'), SHA, env={})
    assert exc.value.code == 'object_not_found'


def test_store_readback_mismatch_is_an_error(monkeypatch):
    fake = FakeRclone()
    monkeypatch.setattr(media_store, '_run', fake)
    original = fake.__call__

    def corrupting(argv, env, stdin=None, stdout=None):
        result = original(argv, env, stdin, stdout)
        if argv[0] == 'cat' and result.stdout:
            result.stdout = b'corrupted'
        return result
    monkeypatch.setattr(media_store, '_run', corrupting)
    with pytest.raises(media_store.StoreError) as exc:
        media_store.put(REF, DATA, SHA, env={})
    assert exc.value.code == 'readback_mismatch'
