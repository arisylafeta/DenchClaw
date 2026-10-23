#!/usr/bin/env python3
"""Copy the old Bulk Trades tables into the Trades Preview (bulk listing) tables, losslessly and idempotently.

Phase A of retiring Bulk Trades. The old tables are read only; nothing is deleted. One transaction.

  reconcile_bulk_trades.py              dry run: print the report, roll back
  reconcile_bulk_trades.py --apply      apply and commit
  reconcile_bulk_trades.py --report F   also write the per-listing report as JSON to F

Rules (reviewed plan, 22 Oct 2026):
- Facts: crm_bulk_trade_fields -> crm_bulk_listing_fields. Whole-record merge; the newer updated_at wins (old wins a tie,
  since the new table had no writes after the 18 Oct backfill). Alternatives from both sides are unioned and deduped on
  (value, source_label, source_date), and the losing value becomes an alternative.
- People: contacts without an offer become offers (role contact, person matched by email as in migration 059). Existing
  contact offers take the contact's name, phone and company. Buyers are already offers (same id); an offer stage never
  moves backwards, last touch takes the later date, and empty offer fields are filled from the buyer.
- History: crm_bulk_trade_events -> crm_bulk_listing_activity with data.legacy_event_id (idempotency key), the original
  kind, changes, actor and time. Buyer, file and proposal events are visible; trade, field, contact and bid edits are
  kind 'status' (hidden from Story; bids already have their own quote activity).
- Threads: inbox-check 'trade' verdicts and gmail evidence links become crm_bulk_thread_links 'proposed', only where
  the listing has no link for that thread yet. Verdicts whose Gmail thread is not in the mail log, WhatsApp-export
  evidence and other evidence become activity rows so nothing is dropped.
- Next steps that differ between lot and listing are reported, not changed.
"""
import argparse, json, sys
import psycopg2, psycopg2.extras

STAGE = {'To contact': 'candidate', 'Teaser sent': 'offered', 'NDA, specs sent': 'offered', 'Bid in': 'offered',
         'LOI or deposit': 'contract_out', 'Won': 'signed'}
RANK = {None: -1, 'candidate': 0, 'offered': 1, 'contract_out': 2, 'signed': 3, 'invoiced': 4, 'paid': 5, 'complete': 6, 'declined': 1, 'lost': 1}
VISIBLE = {'buyer_added': 'outreach', 'buyer_updated': 'outreach', 'file_added': 'document', 'email_drafted': 'mail',
           'proposal_accepted': 'note'}
HIDDEN = {'trade_created', 'trade_updated', 'field_updated', 'contact_added', 'bid_added'}
FIELD_COLS = ('value', 'status', 'visibility', 'source_label', 'source_url', 'source_date', 'alternatives')


def alt_key(a):
    return ((a.get('value') or '').strip(), a.get('source_label') or '', str(a.get('source_date') or ''))


def merge_alts(*lists):
    seen, out = set(), []
    for lst in lists:
        for a in lst or []:
            if not isinstance(a, dict) or not (a.get('value') or '').strip():
                continue
            k = alt_key(a)
            if k not in seen:
                seen.add(k)
                out.append({'value': a.get('value'), 'source_url': a.get('source_url'),
                            'source_date': str(a['source_date']) if a.get('source_date') else None,
                            'source_label': a.get('source_label')})
    return sorted(out, key=lambda a: (a['source_date'] or '', a['value']))


def as_alt(row):
    return {'value': row['value'], 'source_url': row['source_url'],
            'source_date': str(row['source_date']) if row['source_date'] else None, 'source_label': row['source_label']}


def reconcile(cur):
    report, counts = {}, {}

    def log(listing, what):
        report.setdefault(listing, []).append(what)

    def bump(k, n=1):
        counts[k] = counts.get(k, 0) + n

    # ---------- facts ----------
    cur.execute('select * from crm_bulk_trade_fields')
    old = {(r['lot_id'], r['field_key']): r for r in cur.fetchall()}
    cur.execute('select * from crm_bulk_listing_fields')
    new = {(r['bulk_listing_id'], r['field_key']): r for r in cur.fetchall()}
    for key, o in sorted(old.items()):
        n = new.get(key)
        if n is None:
            win, lose = o, None
        else:
            win, lose = (o, n) if o['updated_at'] >= n['updated_at'] else (n, o)
        loser_alt = [as_alt(lose)] if lose and (lose['value'] or '').strip() and (lose['value'] or '').strip() != (win['value'] or '').strip() else []
        alts = merge_alts(o['alternatives'], n['alternatives'] if n else [], loser_alt)
        alts = [a for a in alts if alt_key(a)[0] != (win['value'] or '').strip()]
        target = {'value': win['value'], 'status': win['status'], 'visibility': win['visibility'],
                  'source_label': win['source_label'], 'source_url': win['source_url'], 'source_date': win['source_date'],
                  'alternatives': alts}
        if n is not None and all((n[c] if c != 'alternatives' else merge_alts(n[c])) == target[c] for c in FIELD_COLS):
            continue
        cur.execute('''insert into crm_bulk_listing_fields (bulk_listing_id, field_key, value, status, visibility, source_label,
                         source_url, source_date, alternatives, updated_at)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
                       on conflict (bulk_listing_id, field_key) do update set value=excluded.value, status=excluded.status,
                         visibility=excluded.visibility, source_label=excluded.source_label, source_url=excluded.source_url,
                         source_date=excluded.source_date, alternatives=excluded.alternatives, updated_at=excluded.updated_at''',
                    (key[0], key[1], target['value'], target['status'], target['visibility'], target['source_label'],
                     target['source_url'], target['source_date'], json.dumps(alts), win['updated_at']))
        what = 'added' if n is None else ('updated from old' if win is o else 'alternatives merged')
        bump(f'fact {what}')
        log(key[0], {'fact': key[1], 'change': what, 'value': target['value'], 'status': target['status'],
                     'source': target['source_label'], 'date': str(target['source_date']) if target['source_date'] else None,
                     'previous': n['value'] if n and n['value'] != target['value'] else None})

    # ---------- contacts -> offers ----------
    cur.execute('''select c.*, o.id as offer_id, o.name as o_name, o.data as o_data from crm_bulk_trade_contacts c
                   left join crm_bulk_offers o on o.id = c.id''')
    for c in cur.fetchall():
        if c['offer_id'] is None:
            cur.execute('''insert into crm_bulk_offers (id, bulk_listing_id, role, person_id, company_id, name, contact, data, created_at)
                select %(id)s, %(lot)s, 'contact', p.id, p.company_id, %(name)s, %(email)s,
                  jsonb_strip_nulls(jsonb_build_object('company_text', %(company)s::text, 'phone', %(phone)s::text,
                    'sort_order', %(sort)s::int, 'source', 'crm_bulk_trade_contacts')), %(created)s
                from (select 1) one left join lateral (select min(id) id from crm_people where email is not null
                  and lower(email) = lower(%(email)s)) m on true left join crm_people p on p.id = m.id''',
                        {'id': c['id'], 'lot': c['lot_id'], 'name': c['name'], 'email': c['email'], 'company': c['company'],
                         'phone': c['phone'], 'sort': c['sort_order'], 'created': c['created_at']})
            bump('contact offer added')
            log(c['lot_id'], {'offer': c['id'], 'change': 'contact added', 'name': c['name'], 'contact': c['email']})
            continue
        data = dict(c['o_data'] or {})
        want = dict(data)
        for k, v in (('phone', c['phone']), ('company_text', c['company'])):
            if v:
                want[k] = v
        if c['name'] != c['o_name'] or want != data:
            cur.execute('update crm_bulk_offers set name=%s, data=%s, updated_at=now() where id=%s',
                        (c['name'], json.dumps(want), c['id']))
            bump('contact offer updated')
            log(c['lot_id'], {'offer': c['id'], 'change': 'contact details', 'name': [c['o_name'], c['name']]})

    # ---------- buyers -> offers ----------
    cur.execute('''select b.*, o.stage o_stage, o.last_touch_on o_touch, o.last_touch_via o_via, o.wants o_wants,
                     o.contact o_contact, o.counterpart_id o_cp from crm_bulk_trade_buyers b join crm_bulk_offers o on o.id = b.id''')
    for b in cur.fetchall():
        st = STAGE.get(b['status']) or ('declined' if (b['status'] or '').startswith('Declined') else None)
        sets = {}
        if st and RANK[st] > RANK[b['o_stage']] and b['o_stage'] not in ('declined', 'lost'):
            sets['stage'] = st
        if b['last_touch_on'] and (b['o_touch'] is None or b['last_touch_on'] > b['o_touch']):
            sets['last_touch_on'] = b['last_touch_on']; sets['last_touch_via'] = b['last_touch_via']
        for col, oc in (('wants', 'o_wants'), ('contact', 'o_contact')):
            if b[col] and not b[oc]:
                sets[col] = b[col]
        if b['demand_id'] and not b['o_cp']:
            sets['counterpart_id'] = b['demand_id']
        if sets:
            cur.execute(f"update crm_bulk_offers set {', '.join(k + '=%s' for k in sets)}, updated_at=now() where id=%s",
                        (*sets.values(), b['id']))
            bump('buyer offer updated')
            log(b['lot_id'], {'offer': b['id'], 'change': 'from buyer row', 'set': {k: str(v) for k, v in sets.items()}})

    # ---------- events -> activity ----------
    cur.execute('''select e.*, o.id offer_id, o.name offer_name, o.person_id from crm_bulk_trade_events e
                   left join crm_bulk_offers o on o.id = e.buyer_id
                   where not exists (select 1 from crm_bulk_listing_activity a where a.data->>'legacy_event_id' = e.id::text)
                   order by e.id''')
    for e in cur.fetchall():
        ch, k = e['changes'] or {}, e['kind']
        if k in VISIBLE:
            kind = VISIBLE[k]
        elif k in HIDDEN:
            kind = 'status'
        else:
            sys.exit(f'unmapped event kind {k} (event {e["id"]})')
        keys = [x for x in ch if x not in ('proposal_id', 'source', 'id')]
        title = {
            'buyer_added': f"Buyer added: {ch.get('name') or e['offer_name'] or 'buyer'}",
            'buyer_updated': f"Buyer updated: {e['offer_name'] or 'buyer'} ({', '.join(keys)})",
            'file_added': f"File added: {ch.get('file_name') or 'file'}",
            'email_drafted': 'Email drafted',
            'proposal_accepted': f"Proposal accepted: {(ch.get('summary') or ch.get('kind') or '')[:120]}",
            'trade_created': 'Trade created',
            'trade_updated': f"Trade updated: {', '.join(keys) or 'details'}",
            'field_updated': f"Fact updated: {ch.get('field') or ', '.join(keys)}",
            'contact_added': f"Contact added: {ch.get('name') or ch.get('email') or 'contact'}",
            'bid_added': f"Bid added: {ch.get('amount')} {ch.get('currency') or ''}/{ch.get('unit') or ''}".strip(),
        }[k]
        body = ch.get('wants') if k == 'buyer_added' else (ch.get('source') if isinstance(ch.get('source'), str) else None)
        cur.execute('''insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, body, data,
                         actor_user_id, occurred_at, created_at)
                       values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)''',
                    (e['lot_id'], e['offer_id'], e['person_id'], kind, title[:300], body, json.dumps(
                        {'legacy_event_id': str(e['id']), 'legacy_kind': k, 'changes': ch, 'source': 'crm_bulk_trade_events'},
                        default=str), e['actor_user_id'], e['occurred_at'], e['occurred_at']))
        bump(f'history {"visible" if kind != "status" else "hidden"}')
        if kind != 'status':
            log(e['lot_id'], {'history': title, 'at': str(e['occurred_at'])[:10]})

    # ---------- thread verdicts and evidence ----------
    def link_or_note(listing, gmail_hex, thread_id, reason, quote, labelled_by, legacy):
        if thread_id:
            cur.execute('''select 1 from crm_bulk_thread_links where channel='mail' and thread_id=%s and bulk_listing_id=%s''',
                        (thread_id, listing))
            if cur.fetchone():
                return
            cur.execute('''insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, confidence, state, reason, quote,
                             labelled_by) values ('mail', %s, %s, 'medium', 'proposed', %s, %s, %s)''',
                        (thread_id, listing, reason, quote, labelled_by))
            bump('thread link proposed')
            log(listing, {'thread': thread_id, 'change': 'proposed link', 'reason': reason})
            return
        cur.execute("select 1 from crm_bulk_listing_activity where data->>'legacy_ref' = %s and bulk_listing_id=%s", (legacy, listing))
        if cur.fetchone():
            return
        cur.execute('''insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, ref_kind, ref_id, data)
                       values (%s, 'mail', %s, %s, 'email', %s, %s)''',
                    (listing, 'Email thread linked by inbox check', reason, gmail_hex,
                     json.dumps({'legacy_ref': legacy, 'source': labelled_by})))
        bump('thread kept as activity')
        log(listing, {'thread': gmail_hex, 'change': 'kept as activity (not in mail log)'})

    cur.execute('''select t.*, (select m.thread_id from mail_message m where m.gmail_message_id = substr(t.thread_key, 7)
                     or m.provider_message_id = substr(t.thread_key, 7) limit 1) mail_thread
                   from crm_bulk_trade_threads t where t.verdict = 'trade' order by t.thread_key''')
    for t in cur.fetchall():
        hexid = t['thread_key'].split(':', 1)[1]
        link_or_note(t['lot_id'], t['thread_key'], t['mail_thread'], t['reason'], None, 'inbox-check verdict',
                     'thread:' + t['thread_key'])

    cur.execute('''select e.*, (select m.thread_id from mail_message m where m.gmail_message_id = e.evidence_id
                     or m.provider_message_id = e.evidence_id limit 1) mail_thread,
                     w.conversation, w.sender, w.body, w.occurred_at w_at
                   from crm_bulk_trade_evidence_links e
                   left join crm_trade_evidence_messages w on w.id = e.evidence_id and e.evidence_kind = 'whatsapp_message'
                   order by e.lot_id, e.evidence_id''')
    for e in cur.fetchall():
        legacy = f"evidence:{e['evidence_kind']}:{e['evidence_id']}"
        reason = f"Evidence ({e['relationship']})" + (f": {e['note']}" if e['note'] else '')
        if e['evidence_kind'] == 'gmail_thread':
            link_or_note(e['lot_id'], e['evidence_id'], e['evidence_id'], reason, None, 'evidence link', legacy)
            continue
        if e['evidence_kind'] == 'gmail_message':
            link_or_note(e['lot_id'], e['evidence_id'], e['mail_thread'], reason, None, 'evidence link', legacy)
            continue
        cur.execute("select 1 from crm_bulk_listing_activity where data->>'legacy_ref' = %s and bulk_listing_id=%s", (legacy, e['lot_id']))
        if cur.fetchone():
            continue
        if e['evidence_kind'] == 'whatsapp_message' and e['body']:
            kind, title, body, at = 'whatsapp', f"WhatsApp: {e['sender'] or e['conversation'] or 'message'}"[:300], e['body'], e['w_at']
        else:
            kind, title, body, at = 'note', f"Linked {e['evidence_kind'].replace('_', ' ')} {e['evidence_id']} ({e['relationship']})"[:300], e['note'], None
        cur.execute('''insert into crm_bulk_listing_activity (bulk_listing_id, kind, title, body, data, occurred_at)
                       values (%s,%s,%s,%s,%s,coalesce(%s, now()))''',
                    (e['lot_id'], kind, title, body, json.dumps({'legacy_ref': legacy, 'relationship': e['relationship'],
                                                                 'source': 'crm_bulk_trade_evidence_links'}), at))
        bump('evidence kept as activity')
        log(e['lot_id'], {'evidence': legacy, 'change': f'kept as {kind} activity'})

    # ---------- next steps (report only) ----------
    cur.execute('''select lot.id, l.status, lot.next_step, to_char(lot.next_step_due,'YYYY-MM-DD') step_due,
                     l.next_action, to_char(l.next_due,'YYYY-MM-DD') action_due
                   from crm_bulk_trade_lots lot join crm_bulk_listings l using (id)
                   where lot.next_step is distinct from l.next_action or lot.next_step_due is distinct from l.next_due''')
    next_diff = cur.fetchall()


    return counts, report, next_diff


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--apply', action='store_true')
    ap.add_argument('--report')
    ap.add_argument('--check-idempotent', action='store_true', help='run twice in the transaction; the second pass must change nothing')
    ap.add_argument('--dsn', default='dbname=denchclaw')
    args = ap.parse_args()
    conn = psycopg2.connect(args.dsn)
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    cur.execute("set local lock_timeout = '10s'")
    counts, report, next_diff = reconcile(cur)
    if args.check_idempotent:
        again, _, _ = reconcile(cur)
        print('second pass changes:', again or 'none')
        if again:
            conn.rollback(); sys.exit('NOT IDEMPOTENT')
    out = {'counts': counts, 'listings': report, 'next_step_differs': next_diff}
    print(json.dumps({'counts': counts, 'listings_touched': len(report), 'next_step_differs': next_diff}, indent=1, default=str))
    if args.report:
        with open(args.report, 'w') as f:
            json.dump(out, f, indent=1, default=str)
    if args.apply:
        conn.commit(); print('COMMITTED')
    else:
        conn.rollback(); print('DRY RUN: rolled back')


if __name__ == '__main__':
    main()
