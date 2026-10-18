#!/usr/bin/env python3
"""Restore reviewed October audit losses as internal context, never open demand.

uv run --with 'psycopg[binary]' scripts/rebattery/restore_demand_context.py
Restore the pre-simplify dump into a scratch database first. Default: dry-run
(exact writes/read-back rolled back). --apply commits one atomic repair.
Every source row receives a printed decision; later manual notes are never overwritten.
"""
import argparse
import json
import re
from collections import Counter

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

# Human-reviewed exceptions after comparison with live profiles, demands, buyers and bids.
# Keys are immutable demand UUID prefixes. None means use factual source fields below.
RESTORE = {
    '423ccd34': ('note', 'Historical Citroën LFP first-order discussion: trial at EUR 15/kWh versus EUR 10/kWh buyer target; added one 44 kWh pack on 26 January. Wanted first order completed before buying more; by 4 February found a EUR 2,000 truck and proposed payment after signing/shipping documents. No completed payment established; not current demand.'),
    '2aaef7bc': ('preference', None),
    '025b0b1d': ('offer_reply', 'Asked for EXW/FOB pricing and a full included/excluded BOM for offered 40ft BYD containerised BESS. Original June offer: UK C15 units, 1.33–1.58 MWh; not the US 1.75 MWh lot.'),
    '03fd43cf': ('offer_reply', None),
    '085ff945': ('bid', None),
    '19336ffe': ('bid', None),
    '21af7d49': ('offer_reply', None),
    '3911b73b': ('offer_reply', None),
    '3a7eb975': ('offer_reply', 'Dmytro replied “Yes, we are interested in these packs!” to the 2 Oct teaser: 70 Stellantis 50 kWh CATL NMC packs and 12 MG ZS EV 44.5 kWh packs; asked to negotiate on WhatsApp +380960294444. Interest is not an order.'),
    '70579f38': ('ask', 'Serhii Popov asked availability of 1 Kia EV6 77.4 kWh pack, part 37501-CV050, seen on rebattery.io. Needs pack/module label photos, condition/damage and SoH results; ships to Ukraine. Internal listing reference: kia-ev6-77-4kwh-nmc-cb0b.'),
    '99611cc7': ('offer_reply', None),
    '9c1fa103': ('offer_reply', 'Fergal: “The team has interest in the SK cells, where would they be shipped from and at what unit price?” The 5 Oct quoted offer identifies SK On E603 pouch cells, 61.2 Ah (80,000 offered, not a buyer order quantity). No model-matched trade exists; do not substitute Kokam.'),
    'b00f374f': ('offer_reply', None),
    'd1ac1d6e': ('offer_reply', None),
    'da552358': ('offer_reply', 'Interested in two complete 60–80 kWh Proterra Onyx Strata packs for experimental high-voltage integration/control, retaining original BMS and safety functions; quantity conditional on standalone-operation checks. Not an additional order on top of the existing two-pack R&D requirement.'),
    'f1d613c0': ('bid', None),
    'f283863e': ('ask', 'Conditional 23-pack selection: 3 Ioniq 5 77.4 kWh (2023–24), 2 Zoe 41 kWh (2017), 14 VW MEB 82 kWh and 4 STLA PHEV 12.44 kWh (STLA-EMP2V2/BVH2, part 9856273280), subject to aligned bulk pricing. The 14 MEB packs overlap the existing 10–20-pack requirement, not additional volume.'),
    'ca3a1c9c': ('project', 'Markus Nolden (markusnld123@gmail.com), H. Nolden Investment GmbH: stationary BESS project in Germany, ideally ~10 MW / 20 MWh; wants stationary LFP or other suitable packs. Buyer-stated target, reconfirmed 6 Oct 2026, not a committed purchase order; 24-pack pilot is part of this project, not additive rollout volume.'),
    'dcbdf4ec': ('preference', 'Dmytro stated broad standing interest on WhatsApp: “almost everything” in EV batteries — packs, modules and cells — beyond the named Kona, Kia and Mach-E packs. No quantity commitment.'),
    '44b6ce60': ('ask', None),
    '1405f111': ('past_deal', 'Wanted 2 Hyundai Kona 64 kWh packs (would take 1); requested unit price, condition and origin. Closed 14 Oct 2026 because our packs sold before purchase; standing Kona/Niro preference is separate.'),
    '5bc4ad61': ('preference', None),
    '61d38b9c': ('preference', None),
    '0ec41c50': ('preference', None),
    '13784c12': ('preference', None),
    '1aacffe3': ('project', None),
    '1cb9831b': ('preference', None),
    '24467951': ('ask', None),
    '313a64bb': ('bid', None),
    '673b1c80': ('preference', None),
    '76a906d7': ('offer_reply', None),
    '7bdcfa6a': ('ask', None),
    '929795e0': ('project', None),
    '9f3553cc': ('preference', None),
    'ac2d42c2': ('preference', None),
    'ad76daa3': ('preference', None),
    'cd6d5031': ('ask', None),
    'dd03c09e': ('preference', None),
    'e4b39854': ('preference', None),
    'e6ab82b3': ('preference', None),
    'ebeed1b7': ('preference', None),
    'f8121eeb': ('preference', None),
    '79019447': ('preference', None),
    '3ab695cd': ('project', None),
    '70b75a0e': ('bid', None),
    'ae9d8b7a': ('bid', None),
    '51eae5e3': ('bid', None),
}
# Exact auction identities in the original 2 Oct teaser, not generic MG matches.
EV_CELL_LOTS = [
    'bulk-70-stellantis-50kwh-catl-nmc-prismatic-battery-packs-0320-c57c',
    'bulk-mg-zs-ev-44-5kwh-nmc-ffe3-f564',
]


def normalized(value):
    return re.sub(r'[^a-z0-9]+', ' ', str(value).casefold()).strip()


def summary(row):
    pieces = [row['wants']]
    if row.get('quantity'):
        pieces.append('Quantity: ' + row['quantity'])
    if row.get('max_price') is not None:
        pieces.append(f"Price offered: {row.get('price_currency') or 'currency unspecified'} {row['max_price']} per {row.get('price_unit') or 'unspecified unit'}")
    # Audit bookkeeping is not customer evidence. Keep the original factual qualifiers.
    detail = (row.get('note') or '').split('Demand audit')[0].strip()
    if detail:
        pieces.append(detail)
    if row.get('source_quote') and not detail:
        pieces.append('Source: ' + row['source_quote'].strip())
    return '\n'.join(pieces)


def run(source, live):
    old = source.execute('select * from crm_bulk_trade_demand order by id').fetchall()
    current = live.execute('select * from crm_bulk_trade_demand').fetchall()
    companies = {r['id']: r for r in live.execute('select id, name, buyer_profile from crm_companies')}
    people = {r['id']: r for r in live.execute('select id, company_id, email from crm_people')}
    notes = live.execute('select * from crm_company_context_notes').fetchall()
    existing = {r['id'] for r in current}
    counts = Counter()
    decisions = []
    for row in old:
        key = row['id'].split('_', 1)[1][:8]
        company_id = row.get('company_id') or people.get(row.get('person_id'), {}).get('company_id')
        if not company_id:
            matches = [c['id'] for c in companies.values() if c['name'].casefold() == row['buyer'].casefold()]
            if len(matches) == 1:
                company_id = matches[0]
        if row['id'] in existing:
            decision = 'retained_live'
        elif key in RESTORE and company_id in companies:
            category, text = RESTORE[key]
            note_id = 'ccn_restore_' + row['id']
            text = text or summary(row)
            inserted = live.execute('''insert into crm_company_context_notes
                (id, company_id, category, note, source_kind, source_ref, source_url, observed_on)
                values (%s,%s,%s,%s,%s,%s,%s,%s) on conflict (id) do nothing returning id''',
                (note_id, company_id, category, text, row.get('source_kind') or 'demand_restore',
                 row['id'] + ' | ' + (row.get('source_label') or 'unlabelled source'), row.get('source_url'), row['observed_on'])).fetchone()
            readback = live.execute('select * from crm_company_context_notes where id=%s', (note_id,)).fetchone()
            assert readback and readback['company_id'] == company_id
            counts[category] += bool(inserted)
            decision = 'restored' if inserted else 'already_restored'
        elif not company_id or company_id not in companies:
            decision = 'unresolved_company_no_fabricated_identity'
        else:
            corpus = json.dumps(companies[company_id].get('buyer_profile') or {}, default=str)
            corpus += json.dumps([r for r in current if r['company_id'] == company_id], default=str)
            corpus += json.dumps([r for r in notes if r['company_id'] == company_id], default=str)
            if normalized(row['wants']) in normalized(corpus):
                decision = 'covered_live_profile_or_demand'
            elif row['closed_reason'] in ('supply', 'other') and 'Estimated from web research' in (row.get('note') or ''):
                decision = 'superseded_research_or_supply_not_buyer_statement'
            elif (row.get('moved_to') or '').startswith('lot:'):
                decision = 'covered_existing_lot_buyer_or_bid'
            elif row['closed_reason'] == 'duplicate':
                decision = 'reviewed_duplicate_no_unique_buying_detail'
            else:
                decision = 'reviewed_no_additional_decision_value'
        decisions.append({'id': row['id'], 'buyer': row['buyer'], 'cohort': row['closed_reason'], 'decision': decision})

    # Populate company project metadata without replacing later unrelated profile keys.
    project = next(r for r in old if r['id'].startswith('btd_ca3a1c9c-'))
    profile = dict(companies[project['company_id']]['buyer_profile'] or {})
    project_data = {'use_case': 'Stationary BESS in Germany', 'chemistry': 'LFP or other suitable packs',
                    'target_mw': 10, 'target_mwh': 20, 'contact': 'Markus Nolden',
                    'email': 'markusnld123@gmail.com', 'basis': 'stated', 'observed_on': '2026-10-06',
                    'source_ref': project['id'], 'source_url': project['source_url'],
                    'commitment': 'Aspirational project target; pilot is not additive'}
    profile.setdefault('stationary_project', project_data)
    live.execute('''update crm_companies set buyer_profile=%s, buyer_profile_basis='stated',
        buyer_profiled_at=%s, updated_at=now() where id=%s and buyer_profile is distinct from %s''',
        (Jsonb(profile), project['observed_on'], project['company_id'], Jsonb(profile)))
    assert live.execute('select buyer_profile from crm_companies where id=%s', (project['company_id'],)).fetchone()['buyer_profile']['stationary_project']

    reply = next(r for r in old if r['id'].startswith('btd_3a7eb975-'))
    added = []
    for lot in EV_CELL_LOTS:
        assert live.execute('select id from crm_bulk_trade_lots where id=%s', (lot,)).fetchone(), lot
        found = live.execute('''select b.id from crm_bulk_trade_buyers b
            left join crm_people p on p.id=b.person_id
            left join crm_bulk_trade_demand d on d.id=b.demand_id
            where b.lot_id=%s and (p.company_id=%s or d.company_id=%s
              or lower(b.name)=lower(%s) or lower(b.contact) like %s
              or exists(select 1 from crm_people member where member.company_id=%s
                and (member.id=b.person_id or lower(b.name)=lower(member.full_name)
                  or position(lower(member.email) in lower(coalesce(b.contact,'')))>0)))''',
            (lot, reply['company_id'], reply['company_id'], reply['buyer'], '%' + reply['email'].lower() + '%', reply['company_id'])).fetchone()
        if not found:
            buyer_id = 'btb_restore_evcell_' + ('stellantis50' if 'stellantis' in lot else 'mg445')
            live.execute('''insert into crm_bulk_trade_buyers
                (id,lot_id,name,person_id,contact,wants,status,last_touch_on,demand_id)
                values (%s,%s,%s,%s,%s,%s,'To contact',%s,null)''',
                (buyer_id, lot, reply['buyer'], reply['person_id'], reply['email'], reply['source_quote'], reply['observed_on']))
            assert live.execute('select demand_id from crm_bulk_trade_buyers where id=%s', (buyer_id,)).fetchone()['demand_id'] is None
            added.append(buyer_id)
    # R3 already records the 14-pack overlap in its live note. Do not change 10–20
    # standing quantity, volume or fee inputs based on a conditional offered basket.
    return {'examined': len(old), 'deleted_or_merged': sum(r['id'] not in existing for r in old),
            'restored_by_category': dict(counts), 'lot_buyers_added': added,
            'decisions': decisions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-db', default='audit_old')
    parser.add_argument('--database', default='denchclaw')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.source_db == args.database:
        parser.error('Source must be a separate scratch database')
    with psycopg.connect(dbname=args.source_db, row_factory=dict_row) as source:
        source.execute('set transaction read only')
        with psycopg.connect(dbname=args.database, row_factory=dict_row) as live:
            result = run(source, live)
            result['applied'] = args.apply
            print(json.dumps(result, default=str, indent=2))
            if not args.apply:
                live.rollback()


if __name__ == '__main__':
    main()
