#!/usr/bin/env python3
"""Apply the approved October demand audit, never sending mail or touching Storage.

Run with uv run --with 'psycopg[binary]' scripts/rebattery/demand_recategorize.py.
Inputs are private audit artifacts in ignored .tmp/, not repository fixtures.
Each bucket is independently transactional and read back before commit; dry-run
executes the exact writes and assertions, then rolls back each bucket.
"""
import argparse
import json
from collections import Counter
from pathlib import Path
from uuid import uuid4

import psycopg
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb

ROOT = Path(__file__).resolve().parents[2]
# fee EUR, budget basis, reputation, product-specific asked_on (not account activity)
SHORTLIST = {
    '7d7d7c92': (50000, 'estimate', 'active', '2026-10-15'),
    '36920bc9': (10000, 'buyer', 'active', '2026-10-14'),
    'fcbebcc3': (4600, 'estimate', 'paid', '2026-09-30'),
    '018ec5a1': (2500, 'buyer', 'active', '2026-10-14'),
    '9e5cb949': (2800, 'estimate', 'paid', '2026-10-07'),
    '4bd6dcbe': (3200, 'estimate', 'active', '2026-10-06'),
    'd2a528cc': (350, 'estimate', 'active', '2026-10-07'),
    'ce903293': (260, 'estimate', 'active', '2026-10-15'),
}
R3_LINES = [
    ('ioniq5', 'Ioniq 5', '8 Ioniq 5 77.4 kWh packs; highest priority confirmed Oct 14.', 1400, '2026-10-14'),
    ('stla-hybrid', 'STLA hybrid', '48 STLA hybrid 12.44 kWh packs.', 1300, '2026-09-30'),
    ('zoe', 'Zoe', '4 Renault Zoe 41 kWh packs.', 400, '2026-09-30'),
]
QUESTIONS = {
    '5db68731': 'How many Leaf ZE1 packs, and which PHEV models? (Alex asked Oct 14.)',
    '185e8af3': 'What quantity, condition and Lucid Air 92/118 kWh version do you need?',
    '580f8084': 'Who is buying? Confirm the exact model, format and count of "Ig chem e101Ah".',
    '8f67e71e': 'Still buying the initial 1 MWh of LFP 100Ah batteries at USD 21/kWh?',
    '718e6f5d': 'Still buying five packs, preferably 40 kWh or above?',
    '39dca7b0': 'Still buying twelve Zoe Phase 1 41 kWh packs?',
    '67d1406e': 'Do you accept second-life batteries, or only new branded systems?',
    '876253c9': 'Can you reconfirm the 5 MWh requirement for 2026?',
}
# Explicit lot identities from audit/source evidence and existing lot buyer records.
# Do not guess a different capacity/brand lot when the offered lot no longer exists.
LOTS = {
    '7289c517': 'bt_8f712304-fec1-4935-a37a-ad5a1a98a5d0',
    'd3e68116': 'bt_8f712304-fec1-4935-a37a-ad5a1a98a5d0',
    '8fd5cf09': 'bt_b2214ecd-77c4-41a6-81c7-70ba47861a3f',
    '416ee0a9': 'bulk-fpt-ebs69-200',
    '8bcfc2b6': 'bulk-panasonic-oklahoma',
    '00934b96': 'bulk-kokam-kcl255103en1-50000',
    '2d8d0b5c': 'bulk-iveco-fabio-ebs37-complete-161',
    '69dcd005': 'bulk-stellantis-fiat-500e-600',
    '886fa7e4': 'bulk-fpt-ebs69-200',
    '71260c76': 'bulk-iveco-fabio-ebs37-complete-161',
    'f568527f': 'bt_3bd8df46-ff27-40e6-ae56-02cda64cdfbd',
}
ARCHIVE_REASON = {'duplicate': 'duplicate', 'stale_or_done': 'expired',
                  'consumer_one_off': 'not_demand', 'not_demand': 'not_demand', 'supply_misfiled': 'supply'}


def update(conn, row_id, **patch):
    keys = list(patch)
    # Keys are solely internal constants, never input column names.
    conn.execute('update crm_bulk_trade_demand set ' + ', '.join(k + ' = %s' for k in keys)
                 + ', updated_at = now() where id = %s', [patch[k] for k in keys] + [row_id])
    result = conn.execute('select * from crm_bulk_trade_demand where id = %s', [row_id]).fetchone()
    for key, value in patch.items():
        assert str(result[key]) == str(value) or result[key] == value, (row_id, key, result[key], value)
    return result


def annotate(row, text):
    note = row.get('note') or ''
    return note if text in note else '\n\n'.join(filter(None, [note, text]))


def profile(conn, row, audit):
    if not row['company_id']:
        print('NO COMPANY', row['id'], row['buyer'])
        return False
    company = conn.execute('select * from crm_companies where id = %s for update', [row['company_id']]).fetchone()
    basis = 'researched' if row['source_kind'] == 'research' else 'stated'
    if company['buyer_profile_basis'] == 'stated' and basis == 'researched':
        return True
    incoming = dict(audit.get('research_spec') or row['spec'] or {})
    incoming['wants'] = audit.get('research_wants') or row['wants']
    if row['source_url']:
        incoming['evidence_url'] = row['source_url']
    merged = dict(company['buyer_profile'])
    for key, value in incoming.items():
        if isinstance(value, list):
            merged[key] = list(dict.fromkeys((merged.get(key) or []) + value))
        elif key == 'wants' and merged.get(key) and value not in merged[key]:
            merged[key] += '\n' + value
        else:
            merged[key] = value
    profiled_at = row['observed_on'] or row['confirmed_on'] or row['created_at'].date()
    conn.execute('update crm_companies set buyer_profile=%s, buyer_profile_basis=%s, buyer_profiled_at=%s where id=%s',
                 [Jsonb(merged), basis, profiled_at, row['company_id']])
    actual = conn.execute('select buyer_profile, buyer_profile_basis from crm_companies where id=%s', [row['company_id']]).fetchone()
    assert actual == {'buyer_profile': merged, 'buyer_profile_basis': basis}
    # The existing buyer_* audit trigger writes crm_buyer_profile_changes atomically.
    return True


def lot_interest(conn, row, item):
    short = row['id'][4:12]
    lot_id = LOTS.get(short)
    if not lot_id:
        print('UNRESOLVED LOT', row['id'], item.get('product_family'))
        return 'lot:unknown'
    assert conn.execute('select id from crm_bulk_trade_lots where id=%s', [lot_id]).fetchone(), lot_id
    existing = conn.execute('select * from crm_bulk_trade_buyers where lot_id=%s and '
                            '(demand_id=%s or (person_id is not null and person_id=%s) or lower(name)=lower(%s)) '
                            'order by (demand_id=%s) desc limit 1',
                            [lot_id, row['id'], row['person_id'], row['buyer'], row['id']]).fetchone()
    # Preserve separate line attribution if a buyer row already belongs to another demand.
    if existing and existing['demand_id'] not in (None, row['id']):
        existing = None
    buyer_id = existing['id'] if existing else 'btb_' + str(uuid4())
    status = 'Bid in' if row['max_price'] is not None else 'To contact'
    if existing:
        conn.execute('update crm_bulk_trade_buyers set demand_id=%s, wants=%s, '
                     'person_id=coalesce(person_id,%s), status=case when %s and status in '
                     '(\'To contact\',\'Teaser sent\',\'No reply\',\'NDA, specs sent\') then %s else status end where id=%s',
                     [row['id'], row['wants'], row['person_id'], row['max_price'] is not None, status, buyer_id])
    else:
        conn.execute('insert into crm_bulk_trade_buyers (id,lot_id,name,person_id,contact,wants,demand_id,status) '
                     'values (%s,%s,%s,%s,%s,%s,%s,%s)', [buyer_id,lot_id,row['buyer'],row['person_id'],
                                                          row['contact'],row['wants'],row['id'],status])
    if row['max_price'] is not None:
        assert row['price_currency'] and row['price_unit']
        conn.execute('insert into crm_bulk_trade_bids (lot_id,buyer_id,amount,unit,currency,firmness) '
                     'select %s,%s,%s,%s,%s,\'indicative\' where not exists '
                     '(select 1 from crm_bulk_trade_bids where buyer_id=%s and amount=%s and unit=%s and currency=%s)',
                     [lot_id,buyer_id,row['max_price'],row['price_unit'],row['price_currency'],
                      buyer_id,row['max_price'],row['price_unit'],row['price_currency']])
    actual = conn.execute('select demand_id from crm_bulk_trade_buyers where id=%s', [buyer_id]).fetchone()
    assert actual['demand_id'] == row['id']
    return 'lot:' + lot_id


def run_bucket(conn, bucket, items, audits):
    for item in items:
        row = conn.execute('select * from crm_bulk_trade_demand where id=%s for update', [item['id']]).fetchone()
        assert row, item['id']
        short = row['id'][4:12]
        note = annotate(row, 'Demand audit 2026-10-16: ' + item.get('notes', ''))
        family = item.get('product_family')
        if bucket == 'Demand':
            if short in ('ca3a1c9c', '172d61b0'):
                target = '4bd6dcbe' if short == 'ca3a1c9c' else 'fcbebcc3'
                update(conn,row['id'],status='closed',closed_reason='duplicate',note=note + '\nConsolidated into ' + target)
                continue
            fee, basis, reputation, asked = SHORTLIST[short]
            if short == 'fcbebcc3':
                family = 'STLA-M'
                note = annotate({'note': note}, 'Original sourcing matrix: ' + row['wants'])
                for key, line_family, wants, line_fee, line_asked in R3_LINES:
                    line_id = row['id'] + ':' + key
                    conn.execute('insert into crm_bulk_trade_demand '
                                 '(id,buyer,company_id,person_id,contact,email,wants,kind,basis,source_kind,source_id,source_label,source_url,source_quote,note) '
                                 'select %s,buyer,company_id,person_id,contact,email,%s,kind,basis,\'import\',%s,source_label,source_url,source_quote,%s '
                                 'from crm_bulk_trade_demand where id=%s on conflict (id) do nothing',
                                 [line_id,wants,line_id,'Line item from primary sourcing matrix ' + row['id'],row['id']])
                    update(conn,line_id,status='open',closed_reason=None,product_family=line_family,fee_eur=line_fee,
                           price_basis='estimate',reputation='paid',observed_on=line_asked,confirmed_on=line_asked)
                note += '\nPrimary sourcing matrix; ranked fee covers only STLA-M x22. Ioniq5, Zoe and STLA hybrid have linked line items; MEB is 9e5cb949. Explorer/Soul quantities unknown, no additional fee assumed.'
            if short == '4bd6dcbe':
                note += '\nMarkus is H. Nolden. 24-pack pilot only; 10 MW / 20 MWh project is conditional upside, not an additional order. Buyer asked for stationary LFP alternatives Oct 6.'
            update(conn,row['id'],status='open',closed_reason=None,product_family=family,fee_eur=fee,
                   price_basis=basis,reputation=reputation,observed_on=asked,confirmed_on=asked,note=note)
            if short == 'fcbebcc3':
                update(conn,row['id'],wants='22 Stellantis STLA-M 81.6/105 kWh packs from the Sep 30 sourcing matrix.',
                       quantity='22 packs',volume=22,volume_unit='packs')
            if short == '7d7d7c92':
                people = conn.execute("select p.id,p.company_id from crm_people p join crm_companies c on c.id=p.company_id "
                                      "where c.name ilike '%battery partners%' and p.full_name ilike '%piotr%'").fetchall()
                assert len(people) == 1, people
                update(conn,row['id'],person_id=people[0]['id'],company_id=people[0]['company_id'])
        elif bucket == 'Qualify':
            update(conn,row['id'],status='qualifying',closed_reason=None,qualify_question=QUESTIONS[short],
                   product_family=family or 'Stationary storage',fee_eur=None,reputation='anon' if short=='580f8084' else 'email',note=note)
        elif bucket == 'Lot interest':
            moved = lot_interest(conn,row,item)
            update(conn,row['id'],status='closed',closed_reason='moved_to_lot',moved_to=moved,
                   note=note + ('\nOffered lot cannot be uniquely identified in the current CRM; preserve original evidence for manual linking.' if moved=='lot:unknown' else ''))
        elif bucket == 'Buyer profile':
            linked = profile(conn,row,audits.get(row['id'],{}))
            update(conn,row['id'],status='closed',closed_reason='moved_to_profile',moved_to='company_profile',
                   note=note + ('' if linked else '\nNo linked company: purchasing context retained here, company profile not created.'))
        elif bucket == 'Archive':
            if row['source_kind']=='research' and item['class'] not in ('supply_misfiled','not_demand'):
                profile(conn,row,audits.get(row['id'],{}))
            update(conn,row['id'],status='closed',closed_reason=ARCHIVE_REASON[item['class']],note=note)
        elif bucket == 'Archive/recycling':
            update(conn,row['id'],status='closed',closed_reason='recycling',note=note)
        else:
            raise ValueError(bucket)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--database-url', default='dbname=denchclaw')
    parser.add_argument('--input', type=Path, default=ROOT / '.tmp/demand-recategorization.json')
    parser.add_argument('--audit', type=Path, default=ROOT / '.tmp/demand-audit.json')
    args = parser.parse_args()
    items = json.loads(args.input.read_text())
    audits = json.loads(args.audit.read_text())
    assert len(items)==536 and len({x['id'] for x in items})==536
    print('APPLY' if args.apply else 'DRY RUN (each bucket rolled back)', Counter(x['bucket'] for x in items))
    with psycopg.connect(args.database_url, row_factory=dict_row, autocommit=True) as conn:
        print('BEFORE',conn.execute('select status,count(*) from crm_bulk_trade_demand group by status order by status').fetchall())
        for bucket in ['Demand','Qualify','Lot interest','Buyer profile','Archive','Archive/recycling']:
            with conn.transaction(force_rollback=not args.apply):
                selected = [x for x in items if x['bucket']==bucket]
                run_bucket(conn,bucket,selected,audits)
                print('BUCKET',bucket,len(selected),'read-back OK',conn.execute('select status,count(*) from crm_bulk_trade_demand group by status order by status').fetchall())
        print('AFTER',conn.execute('select status,count(*) from crm_bulk_trade_demand group by status order by status').fetchall())
        print('PROFILES',conn.execute('select buyer_profile_basis,count(*) from crm_companies where buyer_profile <> \'{}\'::jsonb group by buyer_profile_basis').fetchall())
        print('SCORES',conn.execute('select id,buyer,product_family,bulk_demand_score(fee_eur,price_basis,reputation,greatest(observed_on,confirmed_on)) as score from crm_bulk_trade_demand where status=\'open\' order by score desc').fetchall())


if __name__ == '__main__':
    main()
