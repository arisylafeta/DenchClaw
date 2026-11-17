"""Buyer identity, reputation and explicit demand ageing rules used by intake jobs."""
import datetime as dt
import hashlib
import json
import re
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
        where coalesce(o.company_id, p.company_id) = %(company)s and o.stage in ('paid', 'complete') and l.status = 'closed') as paid,
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


# The stale list is a short working queue for a person, not a log: keep the newest reasons.
STALE_REASONS_MAX = 50


def _stale_key(entry):
    """Stable identity for one stale reason, so a re-import of the same evidence never adds a second.

    A source id when the evidence has one, else the stored key (a demand row's own id on first write),
    else a digest of the dated reason. Nightly imports of the same survey answer or saved search keep
    the list at one entry per source.
    """
    if entry.get('key'):
        return str(entry['key'])
    if entry.get('source_id'):
        return str(entry['source_id'])
    digest = hashlib.sha1(f"{entry.get('date')}|{entry.get('reason')}".encode('utf-8')).hexdigest()[:16]
    return f'intake:{digest}'


def _mark_dossier_stale(cur, row, today):
    """A company with a dossier keeps its text: intake only flags it for a person to review.

    The earliest stale date is kept and each source is recorded once, keyed by its stable id (see
    `_stale_key`), so a nightly re-import of the same survey answer or saved search does not grow the
    list. The list is capped at the newest `STALE_REASONS_MAX` reasons.
    """
    observed = row.get('observed_on') or today
    source_id = row.get('source_id')
    label = row.get('source_label') or row.get('source_kind') or 'intake'
    reason = ' '.join(f"{label}: {row.get('wants') or 'new evidence'}".split())[:200]
    entry = {'date': str(observed)[:10], 'reason': reason, 'source_id': source_id}
    entry['key'] = f"demand:{row['id']}" if source_id is None and row.get('id') else _stale_key(entry)

    cur.execute("""select buyer_dossier_stale_since::text as stale_since, buyer_dossier_stale_reasons as reasons
                   from crm_companies where id = %s for update""", (row['company_id'],))
    current = cur.fetchone() or {}
    reasons = [item for item in (current.get('reasons') or []) if isinstance(item, dict)]
    if any(_stale_key(item) == entry['key'] for item in reasons):
        return False
    reasons = [*reasons, entry][-STALE_REASONS_MAX:]
    cur.execute("""update crm_companies set
        buyer_dossier_stale_since = coalesce(buyer_dossier_stale_since, %s::date),
        buyer_dossier_stale_reasons = %s::jsonb,
        updated_at = now()
      where id = %s returning id""",
      (str(observed)[:10], json.dumps(reasons), row['company_id']))
    return cur.fetchone() is not None


def _record_saved_search(cur, row):
    """A dossier company's saved search also becomes a dated context note: the Buyer tab lists it as an alert.

    Idempotent on the platform's search id, so the nightly import adds each alert once and updates the
    note in place when the buyer's filters change.
    """
    search_id = str(row.get('source_id') or '').split(':', 1)[-1]
    if not search_id:
        return False
    summary = []
    for key, value in (row.get('spec') or {}).items():
        if isinstance(value, list) and value:
            summary.append(f"{key.replace('_', ' ').capitalize()}: {', '.join(str(item) for item in value)}")
        elif value not in (None, '', {}, []):
            summary.append(f"{key.replace('_', ' ').capitalize()}: {value}")
    summary += [line for line in str(row.get('note') or '').split('\n')
                if line and not line.startswith('Saved search on rebattery.io')]
    label = str(row.get('wants') or 'Saved search').strip()
    note = f"{label} — {' · '.join(summary)}" if summary else label
    confirmed = row.get('observed_on') or dt.date.today()
    cur.execute("""insert into crm_company_context_notes
        (id, company_id, note, category, source_kind, source_ref, observed_on, source_url)
      values (%s, %s, %s, 'saved_search', 'saved_search', %s, %s::date, %s)
      on conflict (id) do update set note = excluded.note
        where crm_company_context_notes.note is distinct from excluded.note
      returning id""",
      (f"ccn_savedsearch_{search_id}"[:200], row['company_id'], note, row.get('source_id'),
       str(confirmed)[:10], row.get('source_url')))
    return cur.fetchone() is not None


INTEREST_KINDS = ('standing', 'interest', 'inferred')
INTEREST_EXPIRY_DAYS = {'standing': 90, 'interest': 180, 'inferred': 180}
# One source may hold this many lines; a longer list is truncated and recorded, never dropped silently.
INTEREST_FACT_COMBINATIONS = 12


def interest_table_ready(cur):
    """False on a database that predates migration 112, so an importer can run before the migration lands."""
    cur.execute("select to_regclass('public.buyer_interest') as name")
    row = cur.fetchone()
    name = row.get('name') if isinstance(row, dict) else (row[0] if row else None)
    return bool(name)


def _stated_values(values, *singles):
    """Every value a spec states for one fact, ordered like buyer_interest_stated_list() in SQL."""
    stated = [str(value).strip() for value in values if str(value or '').strip()] if isinstance(values, list) else []
    if not stated:
        stated = [str(value).strip() for value in singles if str(value or '').strip()]
    return sorted(dict.fromkeys(stated), key=str.casefold) or [None]


# "BMW / Volvo" and "MG, Stellantis, Tesla" are separate makes; "Hyundai or Kia" is one group name.
MAKE_SEPARATORS = re.compile(r'\s*(?:,|/|&|\band\b)\s*', re.IGNORECASE)


def split_makes(values):
    """Every make a stated list names, split like buyer_interest_make_list() in SQL. Empty in, empty out."""
    makes = {}
    for value in values or []:
        if value is None:
            continue
        for piece in MAKE_SEPARATORS.split(str(value)):
            piece = piece.strip()
            if piece:
                makes[piece] = None
    return sorted(makes, key=str.casefold)


def _make_values(spec):
    """The stated makes, split; one 'not stated' slot when the spec names none."""
    return split_makes(_stated_values(spec.get('makes'), spec.get('make'))) or [None]


def interest_facts(spec):
    """One fact dict per stated make x chemistry x format, capped at INTEREST_FACT_COMBINATIONS.

    A want that names two makes or two chemistries keeps all of them: the demand trigger fans out the same
    way through buyer_interest_fact_sets() in migration 112, so importer and trigger lines agree.
    """
    spec = spec or {}

    def single(*keys):
        for key in keys:
            value = spec.get(key)
            if isinstance(value, list):
                value = value[0] if value else None
            if value not in (None, '', {}, []):
                return value
        return None

    base = {
        'model': single('model'),
        'kwh': single('kwh', 'capacity_kwh'), 'kwh_min': spec.get('kwh_min') or spec.get('kwhMin'),
        'kwh_max': spec.get('kwh_max') or spec.get('kwhMax'), 'cell_maker': single('cell_makers', 'cell_maker'),
    }
    facts = []
    for make in _make_values(spec):
        for chemistry in _stated_values(spec.get('chemistries'), spec.get('chemistry')):
            for fmt in _stated_values(spec.get('formats'), spec.get('format')):
                if len(facts) >= INTEREST_FACT_COMBINATIONS:
                    return facts
                facts.append({**base, 'make': make, 'chemistry': chemistry, 'format': fmt})
    return facts


def model_interest_facts(spec, model):
    """One fact dict for a saved search that names a vehicle model: `model:kia-ev3`, whatever pack size.

    `model` is {make, model} as the search names them (the platform's own manufacturer name, not the buy-box group, so
    the key is the one a \"Kia EV3\" lot rolls up to). A format or chemistry is kept only when the search states exactly
    one, because the model key says nothing about either and two formats would collapse into one line. kWh is only what
    the search's own filter states; it is never filled in from the model.
    """
    spec = spec or {}
    formats = _stated_values(spec.get('formats'), spec.get('format'))
    chemistries = _stated_values(spec.get('chemistries'), spec.get('chemistry'))
    return {'make': model['make'], 'model': model['model'],
            'format': formats[0] if len(formats) == 1 else None,
            'chemistry': chemistries[0] if len(chemistries) == 1 else None,
            'kwh_min': spec.get('kwh_min') or spec.get('kwhMin'), 'kwh_max': spec.get('kwh_max') or spec.get('kwhMax')}


def sql_fact_sets(cur, spec, independent=False):
    """(fact dicts, stated total) from buyer_interest_fact_sets() of migration 115, the one builder the triggers use:
    products stay paired (R1), no vehicle make on a system (R5), nothing repeated (R4), stated detail kept (R6).
    independent: a buy box's lists are criteria, so make x chemistry x format multiply out (as before 115)."""
    cur.execute("select fs.facts as fact_sets, fs.stated_total as stated from buyer_interest_fact_sets(%s::jsonb, '{}'::jsonb, '{}'::jsonb, %s, null, %s) fs",
                (json.dumps(spec or {}), INTEREST_FACT_COMBINATIONS, bool(independent)))
    row = cur.fetchone()
    row = row if isinstance(row, dict) else {'fact_sets': row[0], 'stated': row[1]}
    return list(row['fact_sets'] or []), int(row['stated'] or 0)


def interest_fact_total(spec):
    """How many combinations the spec states before the cap, for the truncation note."""
    spec = spec or {}
    return (len(_make_values(spec))
            * len(_stated_values(spec.get('chemistries'), spec.get('chemistry')))
            * len(_stated_values(spec.get('formats'), spec.get('format'))))


def _record_truncation(cur, source_id, stated_total):
    """A truncated fan-out is visible in buyer_interest_sync_errors instead of disappearing."""
    if stated_total <= INTEREST_FACT_COMBINATIONS or not interest_table_ready(cur):
        return
    cur.execute("savepoint buyer_interest_truncated")
    try:
        cur.execute("""insert into buyer_interest_sync_errors (source_table, source_id, operation, message)
                       values ('buyer_interest_import', %s, 'truncated', %s)""",
                    (str(source_id or '') or None,
                     f'kept {INTEREST_FACT_COMBINATIONS} of {stated_total} stated combinations'))
        cur.execute("release savepoint buyer_interest_truncated")
    except Exception:
        cur.execute("rollback to savepoint buyer_interest_truncated")


def upsert_interest(cur, *, company_id, kind, facts, first_seen, last_seen, person_id=None, expires_on=None,
                    saved_search_id=None, quantity=None, quantity_unit=None, quantity_basis=None, price=None,
                    price_currency=None, price_unit=None, price_basis=None, source_refs=(), decline_reason=None):
    """Upserts one buyer_interest line and returns its id (None when it cannot or need not be written).

    Mastered kinds merge on (company, product key, kind); synced kinds merge on their source id. The product key
    is computed by the same SQL function the triggers use, so importer and trigger lines agree.
    """
    if not company_id or not interest_table_ready(cur):
        return None
    # A line that cannot be written must never abort its importer's transaction.
    cur.execute("savepoint buyer_interest_line")
    try:
        # R5: a vehicle make is never paired with a battery system; R6: what the source states rides on the line.
        cur.execute("""with raw as (select %s::jsonb as f),
                            facts as (select buyer_interest_facts(case when buyer_interest_format(f->>'format') = 'system'
                                and buyer_interest_is_vehicle_make(f->>'make')
                                and coalesce(f->>'model', '') !~* '\\y(megapack|powerwall|powerpack|bess|container|cabinet|rack|ess)\\y'
                              then f - 'make' - 'makes' else f end) as facts, f->'stated' as stated from raw),
                            keyed as (select facts, stated, buyer_interest_product_key(facts) as key from facts)
                       select key, buyer_interest_key_level(key) as level, facts->>'make' as make, facts->>'model' as model,
                         buyer_interest_format(facts->>'format') as format, buyer_interest_chemistry(facts->>'chemistry') as chemistry,
                         buyer_interest_number(facts->'kwh_min') as kwh_min, buyer_interest_number(facts->'kwh_max') as kwh_max,
                         stated
                       from keyed where key <> 'broad:any-batteries'""", (json.dumps(facts or {}),))
        keyed = cur.fetchone()
        if not keyed:
            cur.execute("release savepoint buyer_interest_line")
            return None  # nothing stated that names a product: do not invent a broad bucket
        values = keyed if isinstance(keyed, dict) else dict(zip(
            ('key', 'level', 'make', 'model', 'format', 'chemistry', 'kwh_min', 'kwh_max', 'stated'), keyed))
        mastered = kind in INTEREST_KINDS
        if kind == 'saved_search' and saved_search_id:
            # One line per company and product key: a second alert for the same product merges into the first line
            # (earliest first_seen, latest last_seen, every source ref); an active alert keeps the line open.
            cur.execute("""update buyer_interest set
                             first_seen = least(first_seen, %s::date), last_seen = greatest(last_seen, %s::date),
                             expires_on = case when expires_on is null or %s::date is null then null
                                          else greatest(expires_on, %s::date) end,
                             person_id = coalesce(person_id, %s),
                             stated = coalesce(%s::jsonb, stated),
                             source_refs = coalesce((select array_agg(distinct ref order by ref)
                                           from unnest(source_refs || %s::text[]) ref), '{}'),
                             updated_at = now()
                           where id = (select id from buyer_interest
                                        where company_id = %s and kind = 'saved_search' and product_key = %s
                                          and saved_search_id <> %s
                                        order by first_seen, id limit 1)
                           returning id""",
                        (first_seen, last_seen, expires_on, expires_on, person_id,
                         json.dumps(values['stated']) if values['stated'] else None,
                         list(source_refs or []), company_id, values['key'], saved_search_id))
            merged = cur.fetchone()
            if merged:
                # This search's own earlier line for the same product is the duplicate now.
                cur.execute("delete from buyer_interest where company_id = %s and kind = 'saved_search' \
                            and product_key = %s and saved_search_id = %s", (company_id, values['key'], saved_search_id))
                cur.execute("release savepoint buyer_interest_line")
                return merged['id'] if isinstance(merged, dict) else merged[0]
        conflict = ("on conflict (company_id, product_key, kind) where ownership = 'mastered'"
                    if mastered else "on conflict (kind, saved_search_id, product_key) where saved_search_id is not null")
        refresh = ("last_seen = greatest(buyer_interest.last_seen, excluded.last_seen), person_id = coalesce(excluded.person_id, buyer_interest.person_id), "
                   "expires_on = greatest(buyer_interest.expires_on, excluded.expires_on), "
                   if mastered else
                   "last_seen = greatest(buyer_interest.last_seen, excluded.last_seen), person_id = coalesce(excluded.person_id, buyer_interest.person_id), "
                   "expires_on = coalesce(excluded.expires_on, buyer_interest.expires_on), ")
        cur.execute(f"""insert into buyer_interest (id, company_id, person_id, kind, ownership, product_key, product_key_level,
                         make, model, format, chemistry, kwh_min, kwh_max, first_seen, last_seen, quantity, quantity_unit,
                         quantity_basis, price, price_currency, price_unit, price_basis, source_refs, expires_on,
                         saved_search_id, decline_reason, stated)
                       values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s::date, %s::date, %s, %s, %s, %s, %s, %s, %s,
                         %s::text[], %s::date, %s, %s, %s::jsonb)
                       {conflict} do update set {refresh}
                         stated = coalesce(excluded.stated, buyer_interest.stated),
                         source_refs = coalesce((select array_agg(distinct ref order by ref)
                           from unnest(buyer_interest.source_refs || excluded.source_refs) ref), '{{}}'),
                         updated_at = now()
                       returning id""",
                    (f'bi_{uuid.uuid4().hex}', company_id, person_id, kind, 'mastered' if mastered else 'synced',
                     values['key'], values['level'], values['make'], values['model'], values['format'], values['chemistry'],
                     values['kwh_min'], values['kwh_max'], first_seen, last_seen, quantity, quantity_unit,
                     quantity_basis or ('not_stated' if quantity is None else 'stated'), price, price_currency, price_unit,
                     price_basis, list(source_refs or []), expires_on, saved_search_id, decline_reason,
                     json.dumps(values['stated']) if values['stated'] else None))
        row = cur.fetchone()
        cur.execute("release savepoint buyer_interest_line")
        return row['id'] if isinstance(row, dict) else (row[0] if row else None)
    except Exception:
        cur.execute("rollback to savepoint buyer_interest_line")
        return None


def upsert_profile_interest(cur, row, basis='stated', independent=False):
    """A profile merge (survey answer or research) is also a mastered want: standing when the buyer said it, inferred otherwise.

    Every stated make and chemistry is written, and the survey row's quantity and price are kept on the line.
    """
    if not row.get('company_id'):
        return None
    kind = 'standing' if basis == 'stated' else 'inferred'
    observed = row.get('observed_on') or dt.date.today().isoformat()
    expires = (dt.date.fromisoformat(str(observed)[:10]) + dt.timedelta(days=INTEREST_EXPIRY_DAYS[kind])).isoformat()
    spec = row.get('spec') or {}
    quantity = row.get('volume') if row.get('volume') is not None else spec.get('volume')
    price = row.get('max_price') if row.get('max_price') is not None else spec.get('max_price')
    fact_list, stated_total = sql_fact_sets(cur, spec, independent)
    lines = [upsert_interest(
        cur, company_id=row['company_id'], kind=kind, facts=facts,
        person_id=row.get('person_id'), first_seen=str(observed)[:10], last_seen=str(observed)[:10],
        expires_on=expires, source_refs=[row.get('source_id') or f"crm:{row['company_id']}"],
        quantity=quantity, quantity_unit=(row.get('volume_unit') or spec.get('volume_unit')) if quantity is not None else None,
        quantity_basis='stated' if quantity is not None else 'not_stated',
        price=price, price_currency=(row.get('price_currency') or spec.get('price_currency')) if price is not None else None,
        price_unit=(row.get('price_unit') or spec.get('price_unit')) if price is not None else None,
        price_basis='target' if price is not None else None)
        for facts in fact_list]
    _record_truncation(cur, row.get('source_id'), stated_total)
    return next((line for line in lines if line), None)


def upsert_saved_search_interest(cur, row, unsubscribed=False, today=None):
    """A confirmed saved search is a synced want: open while alerts are on, expired when unsubscribed."""
    day = today or dt.date.today()
    today_iso = day.isoformat() if isinstance(day, dt.date) else str(day)[:10]
    confirmed = str(row.get('observed_on') or today_iso)[:10]
    last_seen = str(row.get('unsubscribed_on') or today_iso)[:10] if unsubscribed else today_iso
    search_id = str(row.get('source_id') or '').removeprefix('saved_search:') or None
    spec = row.get('spec') or {}
    named = row.get('interest_model')
    # A search for a known model is that model's line, not every pack of its maker's group.
    fact_list, stated_total = ([model_interest_facts(spec, named)], 0) if named else sql_fact_sets(cur, spec)
    lines = [upsert_interest(cur, company_id=row.get('company_id'), kind='saved_search', facts=facts,
                             person_id=row.get('person_id'), first_seen=confirmed, last_seen=last_seen,
                             expires_on=last_seen if unsubscribed else None, saved_search_id=search_id,
                             source_refs=[f'saved_search:{search_id}'] if search_id else [])
             for facts in fact_list]
    written = [line for line in lines if line]
    if named and written and search_id and row.get('company_id') and interest_table_ready(cur):
        # The lines this search wrote before it was read as a model are replaced, not left beside the new one.
        cur.execute("delete from buyer_interest where kind = 'saved_search' and saved_search_id = %s and company_id = %s "
                    "and id <> all(%s::text[])", (search_id, row['company_id'], written))
    if not named:
        _record_truncation(cur, row.get('source_id'), stated_total)
    return written[0] if written else None


def merge_profile(cur, row, basis='stated'):
    """Company is the profile home; resolve/create it through intake before calling.

    A company with a buyer dossier is not merged into: the dossier owns the buy box, so intake only
    marks it stale (with a dated reason) and records a saved search as an alert note. Companies
    without a dossier keep the old behaviour until they get one.
    """
    if not row.get('company_id'):
        return False
    cur.execute("select buyer_profile, buyer_profile_basis, buyer_dossier from crm_companies where id = %s for update",
                (row["company_id"],))
    current = cur.fetchone()
    if not current:
        return False
    if current.get("buyer_dossier"):
        changed = _mark_dossier_stale(cur, row, dt.date.today())
        if str(row.get('source_id') or '').startswith('saved_search:'):
            changed = _record_saved_search(cur, row) or changed
        return changed
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
    changed = cur.fetchone() is not None
    # The same answer is a mastered want, so matching can read it before buyer_profile is retired. A saved search
    # is its own synced kind, written by the saved-search importer, not a standing want. A dossier buyer's answer
    # is only a proposal (Alex approves it), so the dossier branch above writes no line.
    if not str(row.get('source_id') or '').startswith('saved_search:'):
        upsert_profile_interest(cur, row, basis)
    return changed


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
