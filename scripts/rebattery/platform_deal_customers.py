#!/usr/bin/env python3
"""Mark CRM companies that transacted on the marketplace as customers; dry-run unless --apply.

Reads production `deals` (GET only) and sets crm_companies.customer = true for our customers on every deal that
completed or whose payment was confirmed: the buyer of a marketplace sale and the supplier of a recycling deal.
Marketplace sellers and recyclers are suppliers to us, not customers (Alex, 23 Nov 2026), so they are not marked. Platform accounts map to CRM
companies through crm_platform_accounts -> crm_people.company_id (kept current by platform_account_sync).
Test traffic is skipped: deals under 50 in value and companies named as tests or ReBattery itself.
Never clears the flag. Output is aggregate counts plus the company names newly marked.
"""
import argparse
import json
import sys

import psycopg2

from platform_account_sync import PlatformReader, platform_credentials

PAID_STEPS = {'payment_confirmed', 'collection_scheduled', 'completed'}
MIN_VALUE = 50

MARK = """
update crm_companies c set customer = true, updated_at = now(),
  notes = concat_ws(E'\\n\\n', c.notes, to_char(current_date, 'DD Mon YYYY') || ': marked Customer from a paid marketplace deal.')
from (select distinct p.company_id from crm_platform_accounts pa join crm_people p on p.id = pa.person_id
      where pa.account_id::text = any(%s) and pa.review_status <> 'rejected' and p.company_id is not null) x
where c.id = x.company_id and not c.customer
  and c.name !~* '(test|^rebattery$)' and coalesce(c.domain, '') <> 'rebattery.io'
returning c.name
"""


def paid_accounts(deals):
    accounts = set()
    for deal in deals:
        if deal['status'] == 'cancelled' or float(deal.get('agreed_amount') or 0) < MIN_VALUE:
            continue
        if deal['status'] == 'completed' or deal['workflow_step'] in PAID_STEPS:
            customer = deal['supplier_account_id'] if deal['source_type'] == 'recycling_offer' else deal['counterparty_account_id']
            if customer:
                accounts.add(customer)
    return sorted(accounts)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Write the flag in the local CRM (default: dry run)')
    args = parser.parse_args()
    try:
        reader = PlatformReader(*platform_credentials())
        deals = reader.table('deals', 'id,source_type,status,workflow_step,agreed_amount,supplier_account_id,counterparty_account_id',
                             'created_at.asc')
        accounts = paid_accounts(deals)
        with psycopg2.connect(dbname='denchclaw') as conn, conn.cursor() as cursor:
            cursor.execute(MARK, (accounts,))
            marked = sorted(row[0] for row in cursor.fetchall())
            if not args.apply:
                conn.rollback()
        summary = {'mode': 'apply' if args.apply else 'dry-run', 'deals': len(deals),
                   'paid_accounts': len(accounts), 'newly_marked': marked}
        if args.apply and not marked:
            return 0  # silent when nothing changed (cron)
        print(json.dumps(summary, sort_keys=True))
    except Exception as exc:
        print(f'Platform deal customer sync failed ({type(exc).__name__}); no CRM changes applied.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
