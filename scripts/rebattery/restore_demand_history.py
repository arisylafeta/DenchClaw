#!/usr/bin/env python3
"""Restore all missing pre-audit demand as closed History; dry-run by default.

Restore pre-simplify-20261016T141045Z.dump into a separate scratch database first.
Run with uv run --with 'psycopg[binary]' scripts/rebattery/restore_demand_history.py
--source-db audit_history_20261018 [--database denchclaw] [--apply].
The exact insert, buyer relink and read-back run in one transaction; dry-run rolls back.
"""
import argparse
import json
from collections import Counter

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg.types.json import Jsonb


def run(source, target):
    target.execute('lock table crm_bulk_trade_demand, crm_bulk_trade_buyers in share row exclusive mode')
    current = target.execute('select * from crm_bulk_trade_demand').fetchall()
    existing = {r['id'] for r in current}
    sources = {(r['source_kind'], r['source_id']) for r in current if r['source_kind'] and r['source_id'] is not None}
    columns = [r['column_name'] for r in target.execute("select column_name from information_schema.columns where table_schema='public' and table_name='crm_bulk_trade_demand' order by ordinal_position")]
    identities = {column: {r['id'] for r in target.execute(sql.SQL('select id from {}').format(sql.Identifier(table)))}
                  for column, table in [('company_id', 'crm_companies'), ('person_id', 'crm_people'), ('created_by', 'crm_users')]}
    counts, restored, collisions, relinked = Counter(), [], [], []
    before = Counter(r['status'] for r in current)
    for original in source.execute('select * from crm_bulk_trade_demand order by id'):
        if original['id'] in existing:
            continue
        key = (original.get('source_kind'), original.get('source_id'))
        if key[0] and key[1] is not None and key in sources:
            collisions.append({'id': original['id'], 'source_kind': key[0], 'source_id': key[1]})
            continue
        row = {k: v for k, v in original.items() if k in columns}
        reason = original.get('closed_reason') if original['status'] == 'closed' else 'other'
        reason = reason or 'other'
        if reason == 'moved_to_profile' and original.get('source_kind') == 'research':
            reason = 'research_profile'
        elif reason == 'moved_to_lot':
            reason = 'offer_reply'
        row.update(status='closed', closed_reason=reason, moved_to=None, match_hash=None, supply_match_hash=None, priority=False)
        row['note'] = '\n'.join(filter(None, [original.get('note'),
            f"Restored to History 18 Oct from the 16 Oct audit (was: {original.get('closed_reason')}/{original.get('moved_to')})"]))
        for column, ids in identities.items():
            if row.get(column) is not None and row[column] not in ids:
                row[column] = None
        keys = list(row)
        values = [Jsonb(row[k]) if isinstance(row[k], (dict, list)) else row[k] for k in keys]
        target.execute(sql.SQL('insert into crm_bulk_trade_demand ({}) values ({})').format(
            sql.SQL(',').join(map(sql.Identifier, keys)), sql.SQL(',').join(sql.Placeholder() for _ in keys)), values)
        readback = target.execute('select * from crm_bulk_trade_demand where id=%s', (row['id'],)).fetchone()
        for key, value in row.items():
            assert readback[key] == value, (row['id'], key, value, readback[key])
        restored.append(row['id'])
        counts[reason] += 1
        sources.add((row.get('source_kind'), row.get('source_id')))
    restored_set = set(restored)
    for buyer in source.execute('select id, demand_id from crm_bulk_trade_buyers where demand_id is not null'):
        if buyer['demand_id'] not in restored_set:
            continue
        result = target.execute('update crm_bulk_trade_buyers set demand_id=%s where id=%s and demand_id is null returning id',
                                (buyer['demand_id'], buyer['id'])).fetchone()
        if result:
            assert target.execute('select demand_id from crm_bulk_trade_buyers where id=%s', (buyer['id'],)).fetchone()['demand_id'] == buyer['demand_id']
            relinked.append(buyer['id'])
    after = Counter(r['status'] for r in target.execute('select status from crm_bulk_trade_demand'))
    assert after['open'] == before['open'] and after['qualifying'] == before['qualifying']
    assert after['closed'] == before['closed'] + len(restored)
    assert not target.execute("select id from crm_bulk_trade_demand where id=any(%s) and (status<>'closed' or priority or match_hash is not null or supply_match_hash is not null or moved_to is not null)", (restored,)).fetchall()
    return dict(before=dict(before), after=dict(after), restored=len(restored), categories=dict(counts),
                source_collisions=collisions, already_live=len(existing), buyer_relinks=relinked)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-db', default='audit_history_20261018')
    parser.add_argument('--database', default='denchclaw')
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    if args.source_db == args.database:
        parser.error('Source must be a separate scratch database')
    with psycopg.connect(dbname=args.source_db, row_factory=dict_row) as source:
        source.execute('set transaction read only')
        with psycopg.connect(dbname=args.database, row_factory=dict_row) as target:
            result = run(source, target)
            result['applied'] = args.apply
            print(json.dumps(result, default=str, indent=2))
            if not args.apply:
                target.rollback()


if __name__ == '__main__':
    main()
