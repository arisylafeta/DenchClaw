"""Complete-line, account-locked local ingestion. Events and offsets commit together.

Malformed complete records become content-free quarantine events containing a digest,
file generation and byte position, never raw message text. Replaced/truncated files
restart at zero and event logical keys reconcile replay. Partial final lines wait.
"""
import hashlib
import json
import os
from pathlib import Path

from psycopg2.extras import Json

from . import identity
from .core import Refused, account_jid, connection, cursor, instant, lock_account, stable_id

KINDS = {'message', 'other', 'edit', 'revoke', 'reaction', 'membership', 'identity_alias'}


def validate(record):
    if not isinstance(record, dict) or record.get('schema') not in (1, 2):
        raise ValueError('unsupported_schema')
    try:
        account = account_jid(record.get('account'))
    except Refused as exc:
        raise ValueError('invalid_account') from exc
    if record.get('kind') not in KINDS:
        raise ValueError('unsupported_kind')
    instant(record.get('capturedAt'))
    if record.get('direction') not in (None, 'inbound', 'outbound'):
        raise ValueError('invalid_direction')
    for field in ('body', 'messageId', 'targetId', 'participant', 'participantAlt', 'chatAltId', 'quotedId'):
        if record.get(field) is not None and not isinstance(record[field], str):
            raise ValueError('invalid_field_type')
    for field in ('flags', 'attachment', 'provenance'):
        if record.get(field) is not None and not isinstance(record[field], dict):
            raise ValueError('invalid_metadata')
    if (record.get('flags') or {}).get('expiresAt'):
        instant(record['flags']['expiresAt'])
    if record.get('participants') is not None and not isinstance(record['participants'], list):
        raise ValueError('invalid_participants')
    kind = record['kind']
    if kind == 'identity_alias':
        if not isinstance(record.get('lid'), str) or not record['lid'].endswith('@lid') or not identity.phone_jid(record.get('pn'))[1]:
            raise ValueError('invalid_alias')
    else:
        chat = record.get('chatId', '')
        if not isinstance(chat, str) or not chat.endswith(('@s.whatsapp.net', '@lid', '@g.us')):
            raise ValueError('invalid_chat')
        if kind != 'membership' and not record.get('messageId') and not record.get('targetId'):
            raise ValueError('missing_message_key')
        if kind in ('edit', 'revoke', 'reaction') and not record.get('targetId'):
            raise ValueError('missing_mutation_target')
    if record.get('timestamp'):
        instant(record['timestamp'])
    if record.get('mutationTimestamp'):
        instant(record['mutationTimestamp'])
    return account


def sanitised(record):
    value = dict(record)
    flags = value.get('flags') or {}
    expires = flags.get('expiresAt')
    from datetime import datetime, timezone
    if flags.get('viewOnce') or (expires and instant(expires) <= datetime.now(timezone.utc)):
        value['body'] = None
        value['attachment'] = None
        value['contentRedacted'] = True
    return value


def logical_key(record):
    kind = record['kind']
    if kind in ('edit', 'revoke'):
        # Do not use target-key updates as the mutation ID. Equal content/time
        # delivered through upsert and update is one logical mutation.
        stamp = record.get('mutationTimestamp')
        if stamp:
            stamp = instant(stamp).isoformat()
        if stamp:
            return stable_id(kind, record.get('chatId'), record.get('targetId'), stamp,
                             record.get('body'), record.get('attachment'))
        return record.get('eventId') or stable_id(kind, record.get('chatId'), record.get('targetId'),
          record.get('messageId'), record.get('timestamp'), record.get('body'), record.get('attachment'))
    if record.get('eventId') and kind not in ('message', 'other'):
        return record['eventId']
    if kind == 'membership':
        provenance = record.get('provenance') or {}
        return stable_id(kind, record.get('chatId'), provenance or record)
    return stable_id(kind, record.get('chatId'), record.get('messageId'), record.get('targetId'),
                     record.get('body') if kind == 'reaction' else None)


def ensure_thread(cur, account, record):
    chat, _ = identity.phone_jid(record['chatId'])
    group = chat.endswith('@g.us')
    who = None if group else identity.ensure_identity(cur, account, chat)
    if who:
        cur.execute('select canonical_jid from whatsapp_identity where id=%s', (who,))
        chat = cur.fetchone()['canonical_jid']
    thread = stable_id(account, chat)
    captured = instant(record['capturedAt'])
    cur.execute('''insert into whatsapp_thread(id,account_id,canonical_chat_id,identity_id,kind,first_captured_at,last_captured_at,metadata)
      values(%s,%s,%s,%s,%s,%s,%s,%s) on conflict(account_id,canonical_chat_id) do update
      set last_captured_at=greatest(whatsapp_thread.last_captured_at,excluded.last_captured_at) returning id''',
      (thread, account, chat, who, 'group' if group else 'direct', captured, captured,
       Json({'history_complete': False, 'expiry_policy_unavailable': record['schema'] == 1})))
    thread = cur.fetchone()['id']
    participants = record.get('participants') or []
    if record.get('participant'):
        participants = [*participants, record['participant']]
    if who:
        participants = [*participants, chat]
    for jid in participants:
        jid = jid.get('id') if isinstance(jid, dict) else jid
        member = identity.ensure_identity(cur, account, jid)
        if member:
            cur.execute('''insert into whatsapp_thread_member(account_id,thread_id,identity_id,first_observed_at,last_observed_at,metadata)
              values(%s,%s,%s,%s,%s,%s) on conflict(thread_id,identity_id) do update set
              last_observed_at=greatest(whatsapp_thread_member.last_observed_at,excluded.last_observed_at),metadata=excluded.metadata''',
              (account, thread, member, captured, captured, Json({'observation_only': True, 'action': record.get('action')})))
    return thread


def project(cur, account, raw, provenance):
    # Canonicalise identity before correlating dual PN/LID deliveries.
    record = sanitised(raw)
    kind = record['kind']
    if kind == 'identity_alias':
        identity.pair_alias(cur, account, record['lid'], record['pn'], record.get('evidence') or {'method': 'paired_capture'})
        thread = None
    else:
        for pn_field, lid_field in (('chatAltId', 'chatId'), ('participantAlt', 'participant')):
            values = [record.get(pn_field), record.get(lid_field)]
            pn = next((v for v in values if identity.phone_jid(v)[1]), None)
            lid = next((v for v in values if isinstance(v, str) and v.endswith('@lid')), None)
            if pn and lid:
                identity.pair_alias(cur, account, lid, pn, {'method': 'paired_capture'})
        thread = ensure_thread(cur, account, record)
    canonical = dict(raw)
    if thread:
        canonical['chatId'] = thread
    key = logical_key(canonical)
    delivery = {**provenance, 'capture': record.get('provenance'), 'envelope_id': record.get('envelopeId'),
                'message_id': record.get('messageId')}
    captured = instant(record['capturedAt'])
    source = record.get('mutationTimestamp') or record.get('timestamp')
    source_at = instant(source) if source else captured
    target = record.get('targetId') if kind in ('edit', 'revoke', 'reaction') else record.get('messageId')
    message = stable_id(account, thread, target) if target and thread else None
    cur.execute('''insert into whatsapp_event(id,account_id,thread_id,message_id,kind,logical_key,envelope_id,target_provider_id,source_at,captured_at,payload,provenance)
      values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(account_id,logical_key) do nothing returning id''',
      (stable_id(account, key), account, thread, message, kind, key, record.get('envelopeId') or
       (record.get('messageId') if record.get('messageId') != target else None), target, source_at, captured, Json(record), Json({'deliveries': [delivery]})))
    if not cur.fetchone():
        cur.execute('''update whatsapp_event set provenance=jsonb_set(provenance,'{deliveries}',
          coalesce(provenance->'deliveries','[]'::jsonb) || %s::jsonb)
          where account_id=%s and logical_key=%s and not coalesce(provenance->'deliveries','[]'::jsonb) @> %s::jsonb''',
          (Json([delivery]), account, key, Json([delivery])))
        return False
    if kind in ('membership', 'identity_alias'):
        return True
    sender_jid = record.get('participant') or (record['account'] if record.get('direction') == 'outbound' else record['chatId'])
    sender = identity.ensure_identity(cur, account, sender_jid)
    metadata = {'flags': record.get('flags'), 'expiry_policy_unavailable': record['schema'] == 1,
                'content_not_downloaded': bool(record.get('attachment')), 'content_redacted': record.get('contentRedacted', False)}
    order = source_at.isoformat() + ':' + key
    cur.execute('''insert into whatsapp_message(id,account_id,thread_id,provider_message_id,sender_identity_id,direction,occurred_at,captured_at,timestamp_source,metadata)
      values(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict(account_id,thread_id,provider_message_id) do nothing''',
      (message, account, thread, target, sender, record.get('direction'), source_at, captured, 'provider' if source else 'capture', Json(metadata)))
    if kind in ('message', 'other'):
        cur.execute('''update whatsapp_message set original_seen=true,sender_identity_id=%s,direction=%s,occurred_at=%s,
          timestamp_source=%s,reply_to_provider_id=%s,metadata=metadata || %s::jsonb,
          body=case when edit_version=0 and deleted_at is null then %s else body end,
          attachment=case when edit_version=0 and deleted_at is null then %s else attachment end
          where id=%s''', (sender, record.get('direction'), source_at, 'provider' if source else 'capture',
          record.get('quotedId'), Json(metadata), record.get('body'), Json(record.get('attachment')), message))
    elif kind == 'edit':
        cur.execute('''update whatsapp_message set edit_version=edit_version+1,
          body=case when projection_order<%s and deleted_at is null then %s else body end,
          attachment=case when projection_order<%s and deleted_at is null then %s else attachment end,
          projection_order=greatest(projection_order,%s) where id=%s''',
          (order, record.get('body'), order, Json(record.get('attachment')), order, message))
    elif kind == 'revoke':
        cur.execute('update whatsapp_message set body=null,attachment=null,deleted_at=%s,projection_order=greatest(projection_order,%s) where id=%s', (source_at, order, message))
    elif kind == 'reaction':
        cur.execute('''update whatsapp_message set metadata=jsonb_set(metadata,'{reactions}',
          coalesce(metadata->'reactions','{}'::jsonb) || %s::jsonb) where id=%s
          and coalesce(metadata->'reactions'->%s->>'order','') < %s''',
          (Json({sender: {'text': record.get('body'), 'at': source_at.isoformat(), 'order': order}}), message, sender, order))
    # Resolve both forward and backwards references after every arrival.
    cur.execute('''update whatsapp_message reply set reply_to_message_id=target.id from whatsapp_message target
      where reply.account_id=%s and reply.thread_id=%s and target.account_id=reply.account_id
      and target.thread_id=reply.thread_id and target.provider_message_id=reply.reply_to_provider_id
      and reply.reply_to_message_id is distinct from target.id''', (account, thread))
    return True


def files_at(path):
    root = Path(path).expanduser().resolve()
    if not root.is_dir():
        raise Refused('local_directory_required')
    # Only capture JSONL, never credentials or status files.
    return sorted(p for p in root.glob('*.jsonl') if p.is_file())


def read_lines(path, offset=0):
    with path.open('rb') as handle:
        handle.seek(offset)
        while True:
            start = handle.tell()
            line = handle.readline()
            if not line or not line.endswith(b'\n'):
                break
            yield start, handle.tell(), line


def capture_status(path, expected):
    file = Path(path).expanduser().resolve() / 'status.json'
    if not file.exists():
        return {}
    try:
        status = json.loads(file.read_text())
        if account_jid(status.get('account')) != expected:
            raise Refused('unexpected_status_account')
        fields = ('state', 'heartbeatAt', 'gapSince', 'lastGap', 'reconnects', 'nextReconnectAt',
                  'diskAvailableBytes', 'diskError', 'appendError', 'statusError', 'updatedAt', 'lastMessageAt')
        return {key: status[key] for key in fields if key in status}
    except (ValueError, TypeError, OSError):
        return {'status_read_error': True}


def ingest(path, apply=False, expected_account=None, db=None, after_record=None):
    files = files_at(path)
    expected = account_jid(expected_account or os.environ['DENCH_WHATSAPP_ACCOUNT']) if (expected_account or os.environ.get('DENCH_WHATSAPP_ACCOUNT')) else None
    counts = {'records': 0, 'chats': 0, 'quarantined': 0, 'imported': 0, 'auto_link_candidates': 0, 'partial_files': 0, 'apply': apply}
    chats, accounts, phones = set(), set(), set()
    # Preflight the entire batch before making any database changes.
    parsed = []
    for file in files:
        stat = file.stat()
        generation = f'{stat.st_dev}:{stat.st_ino}'
        rows = []
        end = 0
        for start, finish, line in read_lines(file):
            end = finish
            try:
                record = json.loads(line)
                account = validate(record)
                if expected and account != expected:
                    raise Refused('unexpected_account')
                accounts.add(account)
                if record.get('chatId'):
                    chats.add((account, record['chatId']))
                    phone = identity.normalise_phone(identity.phone_jid(record['chatId'])[1])[0]
                    if phone:
                        phones.add(phone)
                counts['records'] += 1
                rows.append((start, finish, record, None))
            except Refused:
                raise
            except (ValueError, TypeError, OverflowError, KeyError):
                counts['quarantined'] += 1
                rows.append((start, finish, None, hashlib.sha256(line).hexdigest()))
        if end < stat.st_size:
            counts['partial_files'] += 1
        parsed.append((file, generation, rows))
    if len(accounts) > 1:
        raise Refused('multiple_accounts_in_batch')
    counts['chats'] = len(chats)
    if not apply:
        # Read only existing CRM phones. Dry run does not require migrated tables.
        owned = db is None
        try:
            db = db or connection(read_only=True)
            with cursor(db) as cur:
                cur.execute('select phone from crm_people where phone is not null')
                matches = {}
                for row in cur.fetchall():
                    phone, extension = identity.normalise_phone(row['phone'])
                    if phone and not extension:
                        matches[phone] = matches.get(phone, 0) + 1
                counts['auto_link_candidates'] = sum(matches.get(phone) == 1 for phone in phones)
        finally:
            if owned and db:
                db.close()
        return counts
    if not expected:
        raise Refused('expected_account_required', 'Set DENCH_WHATSAPP_ACCOUNT or --account before applying')
    health = capture_status(path, expected)
    owned = db is None
    db = db or connection()
    try:
        with db, cursor(db) as cur:
            lock_account(cur, expected)
            cur.execute('insert into whatsapp_account(id,account_jid) values(%s,%s) on conflict do nothing', (expected, expected))
            cur.execute('update whatsapp_account set metadata=metadata || %s::jsonb where id=%s',
                        (Json({'capture_status': health}), expected))
            for file, generation, rows in parsed:
                path_key = str(file)
                cur.execute('select * from whatsapp_ingest_cursor where account_id=%s and source_path=%s for update', (expected, path_key))
                checkpoint = cur.fetchone()
                offset = 0
                if checkpoint and checkpoint['generation'] == generation:
                    prior = checkpoint['byte_offset']
                    with file.open('rb') as handle:
                        fingerprint = hashlib.sha256(handle.read(prior)).hexdigest()
                    if file.stat().st_size >= prior and fingerprint == checkpoint['fingerprint']:
                        offset = prior
                imported = quarantined = 0
                complete = offset
                for start, finish, record, digest in rows:
                    if start < offset:
                        continue
                    provenance = {'path_hash': stable_id(path_key), 'generation': generation, 'offset': start}
                    if record is None:
                        key = stable_id('quarantine', path_key, generation, start, digest)
                        cur.execute('''insert into whatsapp_event(id,account_id,kind,logical_key,captured_at,payload,provenance)
                          values(%s,%s,'quarantine',%s,now(),%s,%s) on conflict do nothing''',
                          (stable_id(expected, key), expected, key, Json({'sha256': digest, 'reason': 'malformed_record'}), Json(provenance)))
                        quarantined += cur.rowcount
                    else:
                        imported += int(project(cur, expected, record, provenance))
                    complete = finish
                    if after_record:
                        after_record()
                with file.open('rb') as handle:
                    fingerprint = hashlib.sha256(handle.read(complete)).hexdigest()
                cur.execute('''insert into whatsapp_ingest_cursor(account_id,source_path,generation,fingerprint,byte_offset,record_count,quarantine_count)
                  values(%s,%s,%s,%s,%s,%s,%s) on conflict(account_id,source_path) do update set
                  generation=excluded.generation,fingerprint=excluded.fingerprint,byte_offset=excluded.byte_offset,
                  record_count=whatsapp_ingest_cursor.record_count+excluded.record_count,
                  quarantine_count=whatsapp_ingest_cursor.quarantine_count+excluded.quarantine_count,updated_at=now()''',
                  (expected, path_key, generation, fingerprint, complete, imported, quarantined))
                counts['imported'] += imported
            counts['auto_link_candidates'] = identity.auto_link(cur, expected)
        return counts
    finally:
        if owned:
            db.close()
