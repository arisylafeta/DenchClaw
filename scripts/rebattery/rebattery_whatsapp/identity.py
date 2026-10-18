"""Validated phone identities and reversible, evidence-bearing CRM associations."""
import re
import uuid

import phonenumbers
from psycopg2.extras import Json

from .core import Refused, stable_id


def normalise_phone(raw, country=None):
    """Return (E.164, extension), or (None, None). Never assume a country."""
    if not raw or (not str(raw).lstrip().startswith('+') and not country):
        return None, None
    try:
        number = phonenumbers.parse(str(raw), country)
        if not phonenumbers.is_valid_number(number):
            return None, None
        return phonenumbers.format_number(number, phonenumbers.PhoneNumberFormat.E164), number.extension or None
    except phonenumbers.NumberParseException:
        return None, None


def phone_jid(jid):
    match = re.fullmatch(r'(\d+)(?::\d+)?@s\.whatsapp\.net', jid or '')
    return (match[1] + '@s.whatsapp.net', '+' + match[1]) if match else (jid, None)


def ensure_identity(cur, account, jid, display_name=None):
    if not jid:
        return None
    canonical, raw = phone_jid(jid)
    cur.execute('select identity_id from whatsapp_identity_alias where account_id=%s and jid=%s', (account, canonical))
    existing = cur.fetchone()
    if existing:
        return existing['identity_id']
    identity = stable_id(account, canonical)
    e164, extension = normalise_phone(raw)
    cur.execute('''insert into whatsapp_identity(id,account_id,canonical_jid,e164,raw_phone,extension,display_name)
      values(%s,%s,%s,%s,%s,%s,%s) on conflict(account_id,canonical_jid) do nothing''',
                (identity, account, canonical, e164, raw, extension, display_name))
    cur.execute('''insert into whatsapp_identity_alias(account_id,jid,identity_id,evidence)
      values(%s,%s,%s,%s) on conflict do nothing''', (account, canonical, identity, Json({'method': 'observed_jid'})))
    return identity


def pair_alias(cur, account, lid, pn, evidence):
    if not isinstance(lid, str) or not lid.endswith('@lid') or not phone_jid(pn)[1]:
        raise ValueError('invalid paired identity')
    # Both pre-existing identities may have histories. Repoint all account-scoped
    # references before retiring the alias, retaining the old identity as evidence.
    target = ensure_identity(cur, account, pn)
    cur.execute('select identity_id from whatsapp_identity_alias where account_id=%s and jid=%s', (account, lid))
    row = cur.fetchone()
    if row and row['identity_id'] != target:
        old = row['identity_id']
        cur.execute('select canonical_jid from whatsapp_identity where id=%s', (old,))
        if phone_jid(cur.fetchone()['canonical_jid'])[1]:
            raise Refused('conflicting_alias_merge')
        cur.execute('select 1 from whatsapp_identity_link where identity_id=%s and valid_to is null', (old,))
        if cur.fetchone():
            raise Refused('conflicting_alias_merge')
        cur.execute('''update whatsapp_identity target set shared=target.shared or old.shared
          from whatsapp_identity old where target.id=%s and old.id=%s''', (target, old))
        canonical_pn = phone_jid(pn)[0]
        cur.execute('''select 1 from whatsapp_thread old join whatsapp_thread paired
          on paired.account_id=old.account_id and paired.canonical_chat_id=%s and paired.id<>old.id
          where old.account_id=%s and old.identity_id=%s''', (canonical_pn, account, old))
        if cur.fetchone():
            raise Refused('conflicting_alias_merge', 'Both aliases already have independent threads; reconcile explicitly')
        cur.execute('''update whatsapp_thread set canonical_chat_id=%s
          where account_id=%s and identity_id=%s and kind='direct' ''', (canonical_pn, account, old))
        cur.execute('update whatsapp_message set sender_identity_id=%s where account_id=%s and sender_identity_id=%s', (target, account, old))
        cur.execute('''insert into whatsapp_thread_member(account_id,thread_id,identity_id,first_observed_at,last_observed_at,metadata)
          select account_id,thread_id,%s,first_observed_at,last_observed_at,metadata from whatsapp_thread_member where account_id=%s and identity_id=%s
          on conflict(thread_id,identity_id) do update set last_observed_at=greatest(whatsapp_thread_member.last_observed_at,excluded.last_observed_at)''', (target, account, old))
        cur.execute('delete from whatsapp_thread_member where account_id=%s and identity_id=%s', (account, old))
        cur.execute('update whatsapp_thread set identity_id=%s where account_id=%s and identity_id=%s', (target, account, old))
        cur.execute('update whatsapp_identity_alias set identity_id=%s,evidence=%s where account_id=%s and identity_id=%s', (target, Json(evidence), account, old))
    cur.execute('''insert into whatsapp_identity_alias(account_id,jid,identity_id,evidence) values(%s,%s,%s,%s)
      on conflict(account_id,jid) do update set evidence=excluded.evidence''', (account, lid, target, Json(evidence)))
    return target


def proposals(cur, account=None):
    cur.execute('select id,phone from crm_people where phone is not null')
    by_phone = {}
    for person in cur.fetchall():
        value, extension = normalise_phone(person['phone'])
        if value and not extension:
            by_phone.setdefault(value, []).append(person['id'])
    cur.execute('''select i.*, exists(select 1 from whatsapp_identity_link historical where historical.identity_id=i.id) as has_decision
      from whatsapp_identity i where (%s is null or account_id=%s)
      and not exists(select 1 from whatsapp_identity_link l where l.identity_id=i.id and l.valid_to is null)''', (account, account))
    return [{'identity_id': i['id'], 'account_id': i['account_id'], 'person_ids': by_phone.get(i['e164'], []),
             'auto_link': bool(i['e164'] and not i['extension'] and not i['shared'] and not i['has_decision']
                               and len(by_phone.get(i['e164'], [])) == 1)} for i in cur.fetchall()]


def link(cur, identity_id, person_id=None, company_id=None, actor='operator', auto=False, shared=False):
    if not person_id and not company_id:
        raise Refused('target_required')
    cur.execute('select * from whatsapp_identity where id=%s for update', (identity_id,))
    identity = cur.fetchone()
    if not identity:
        raise Refused('unknown_identity')
    if auto:
        candidate = next((p for p in proposals(cur, identity['account_id']) if p['identity_id'] == identity_id), None)
        if not candidate or not candidate['auto_link'] or candidate['person_ids'] != [person_id]:
            raise Refused('not_unique_exact_phone')
    cur.execute('select * from whatsapp_identity_link where identity_id=%s and valid_to is null', (identity_id,))
    active = cur.fetchall()
    same = next((l for l in active if l['person_id'] == person_id and l['company_id'] == company_id), None)
    if same:
        return same['id']
    if active and not (shared or identity['shared']):
        raise Refused('identity_already_linked', 'Unlink the previous decision or explicitly confirm a shared number')
    if shared or (company_id and not person_id):
        cur.execute('update whatsapp_identity set shared=true where id=%s', (identity_id,))
    identifier = uuid.uuid4().hex
    evidence = {'validated_e164': identity['e164'], 'exact_single_match': auto, 'confirmed': not auto, 'shared': shared}
    cur.execute('''insert into whatsapp_identity_link(id,account_id,identity_id,person_id,company_id,method,confidence,evidence,actor)
      values(%s,%s,%s,%s,%s,%s,%s,%s,%s)''', (identifier, identity['account_id'], identity_id, person_id, company_id,
      'auto_e164' if auto else 'manual', 'high' if auto else 'confirmed', Json(evidence), actor))
    return identifier


def auto_link(cur, account):
    candidates = [p for p in proposals(cur, account) if p['auto_link']]
    for candidate in candidates:
        link(cur, candidate['identity_id'], candidate['person_ids'][0], actor='local-importer', auto=True)
    return len(candidates)


def unlink(cur, link_id, actor='operator'):
    cur.execute('''update whatsapp_identity_link set valid_to=now(), evidence=evidence || %s::jsonb
      where id=%s and valid_to is null returning id''', (Json({'revoked_by': actor}), link_id))
    if not cur.fetchone():
        raise Refused('active_link_not_found')
    return link_id


def list_links(cur, account=None):
    cur.execute('select * from whatsapp_identity_link where (%s is null or account_id=%s) order by valid_from,id', (account, account))
    return [dict(row) for row in cur.fetchall()]
