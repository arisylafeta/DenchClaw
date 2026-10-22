"""Buyer identity, reputation and explicit demand ageing rules used by intake jobs."""
import datetime as dt
import json
import uuid

FREEMAIL = {'gmail', 'googlemail', 'yahoo', 'outlook', 'hotmail', 'icloud', 'proton', 'protonmail', 'aol', 'live', 'gmx', 'mail'}


def resolve_entity(cur, email=None, contact=None, company=None):
    """Reuse exact email/name identities; ambiguous names must not pick an arbitrary person."""
    cur.execute("""select p.id as person_id, p.company_id, p.email from crm_people p
        where (%s::text is not null and lower(p.email) = lower(%s))
           or (%s::text is null and %s::text is not null
               and (lower(p.full_name) = lower(%s) or lower(p.first_name) = lower(%s)))
        order by (lower(p.email) = lower(%s)) desc nulls last""", (email, email, email, contact, contact, contact, email))
    rows = cur.fetchall()
    exact = [r for r in rows if email and (r.get('email') or '').lower() == email.lower()]
    if exact or len(rows) == 1:
        return (exact or rows)[0]
    if company:
        cur.execute('select id from crm_companies where lower(name) = lower(%s)', (company,))
        rows = cur.fetchall()
        if len(rows) == 1:
            return {'person_id': None, 'company_id': rows[0]['id'], 'email': email}
    return {'person_id': None, 'company_id': None, 'email': email}


def reputation_for(cur, company_id=None, person_id=None, email=None, two_way=False, has_thread=False):
    """Observed commercial history wins over channel priors; never infer payment from interest."""
    cur.execute("""select
      exists(select 1 from crm_bulk_demand where company_id = %(company)s
        and status = 'closed' and closed_reason = 'bought_from_us')
      or exists(select 1 from crm_bulk_offers o left join crm_people p on p.id = o.person_id
        join crm_bulk_listings l on l.id = o.bulk_listing_id
        where coalesce(o.company_id, p.company_id) = %(company)s and o.stage = 'won' and l.status = 'closed') as paid,
      exists(select 1 from crm_bulk_offers o left join crm_people p on p.id = o.person_id
        where (coalesce(o.company_id, p.company_id) = %(company)s or o.person_id = %(person)s)
          and (exists(select 1 from crm_bulk_listing_activity a where a.offer_id = o.id and a.kind = 'quote'
                        and a.occurred_at >= now() - interval '60 days')
               or (o.last_touch_via = 'Call' and o.last_touch_on >= current_date - 60)))
      or exists(select 1 from crm_bulk_trade_proposals q where q.created_at >= now() - interval '60 days'
        and (q.proposed->>'company_id' = %(company)s or q.proposed->>'person_id' = %(person)s)
        and q.status in ('accepted', 'applied')) as active""", {'company': company_id, 'person': person_id})
    history = cur.fetchone() or {}
    if history.get('paid'):
        return 'paid'
    if history.get('active'):
        return 'active'
    if two_way:
        return 'email'
    if email and email.split('@')[-1].split('.')[0] in FREEMAIL and not has_thread:
        return 'anon'
    return 'inbound'


def family_key(value):
    return ' '.join(str(value or '').casefold().split())[:120]


def existing_demand(cur, entity, family):
    cur.execute("""select id from crm_bulk_demand where status in ('open', 'qualifying')
      and lower(product_family) = %s
      and ((%s::text is not null and company_id = %s)
        or (%s::text is not null and person_id = %s)
        or (%s::text is not null and lower(email) = lower(%s)))
      order by observed_on desc nulls last limit 1""",
      (family_key(family), entity.get('company_id'), entity.get('company_id'),
       entity.get('person_id'), entity.get('person_id'), entity.get('email'), entity.get('email')))
    row = cur.fetchone()
    return row['id'] if row else None


def expiry_transition(row, today):
    if row['status'] == 'qualifying':
        # Entry date explains the wait; only actually sending the question starts expiry.
        asked = row.get('qualify_asked_on') or row.get('qualify_entered_on')
        if row.get('qualify_asked_on') is None:
            return 'question_not_sent'
        confirmed = row.get('confirmed_on')
        if confirmed is not None and confirmed > asked:
            return None
        if (today - asked).days >= 21:
            return 'expired' if row['kind'] == 'request' else 'moved_to_profile'
        return None
    dates = [d for d in (row.get('observed_on'), row.get('confirmed_on')) if d is not None]
    if not dates:
        return None
    age = (today - max(dates)).days
    if row['kind'] == 'request':
        if (row.get('needed_by') and row['needed_by'] < today) or (not row.get('needed_by') and age > 90):
            return 'expired'
    elif age >= 60:
        return 'qualifying'
    return None


def merge_profile(cur, row, basis='stated'):
    """Company is the profile home; resolve/create it through intake before calling."""
    if not row.get('company_id'):
        return False
    cur.execute("select buyer_profile, buyer_profile_basis from crm_companies where id = %s for update", (row["company_id"],))
    current = cur.fetchone()
    if not current:
        return False
    existing = current.get("buyer_profile") or {}
    if basis == 'researched' and current.get('buyer_profile_basis') == 'stated':
        return False
    if current.get("buyer_profile_basis") == "stated":
        basis = "stated"
    profile = dict(existing)
    for key, value in (row.get('spec') or {}).items():
        profile[key] = list(dict.fromkeys([*existing.get(key, []), *value])) if isinstance(value, list) else value
    wants = list(dict.fromkeys([x for x in str(existing.get('wants') or '').split('\n') if x] + [row['wants']]))
    profile['wants'] = '\n'.join(wants)
    if row.get('source_url'):
        profile['evidence_url'] = row['source_url']
    if row.get('note'):
        evidence = list(existing.get('criteria_evidence') or [])
        item = {key: row[key] for key in ('source_kind', 'source_id', 'source_label', 'source_url', 'note') if row.get(key)}
        if item not in evidence:
            evidence.append(item)
        profile['criteria_evidence'] = evidence
    cur.execute("""update crm_companies set buyer_profile = %s::jsonb,
      buyer_profile_basis = %s, buyer_profiled_at = %s, updated_at = now()
      where id = %s and (buyer_profile is distinct from buyer_profile || %s::jsonb
        or buyer_profile_basis is distinct from %s) returning id""",
      (json.dumps(profile), basis, row.get('observed_on') or dt.date.today(), row['company_id'], json.dumps(profile), basis))
    return cur.fetchone() is not None


def expire_demand(cur, today=None):
    today = today or dt.date.today()
    cur.execute("""select * from crm_bulk_demand where status in ('open', 'qualifying') for update""")
    changes = []
    for row in cur.fetchall():
        action = expiry_transition(row, today)
        if action == 'question_not_sent':
            changes.append({'id': row['id'], 'action': action})
            continue
        if not action:
            continue
        if action == 'moved_to_profile':
            if not row.get('company_id'):
                entity = resolve_entity(cur, row.get('email'), row.get('contact'), row.get('buyer'))
                company_id = entity['company_id']
                if not company_id:
                    company_id = 'lead_' + str(uuid.uuid4())
                    cur.execute("insert into crm_companies (id, name, purpose, source) values (%s, %s, '{Buyer}', 'Inbound')",
                                (company_id, row['buyer']))
                row['company_id'] = company_id
                cur.execute("update crm_bulk_demand set company_id = %s where id = %s", (company_id, row['id']))
                person_id = row.get('person_id') or entity.get('person_id')
                if person_id:
                    cur.execute("update crm_people set company_id = coalesce(company_id, %s) where id = %s", (company_id, person_id))
            merge_profile(cur, row)
        if action == 'qualifying':
            cur.execute("""update crm_bulk_demand set status = 'qualifying', qualify_question = 'Still buying?',
                           qualify_entered_on = %s, qualify_asked_on = null,
                           match_hash = null, supply_match_hash = null, updated_at = now() where id = %s""", (today, row['id']))
        else:
            cur.execute("""update crm_bulk_demand set status = 'closed', closed_reason = %s,
              moved_to = %s, updated_at = now() where id = %s""",
              (action, 'company_profile' if action == 'moved_to_profile' else None, row['id']))
        changes.append({'id': row['id'], 'action': action})
    return changes
