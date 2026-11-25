#!/usr/bin/env python3
"""Write crm_companies.total_deals, deal_value_gbp and deal_value_eur; dry run unless --apply.

Marketplace side (production `deals`, GET only): our customer on every non-cancelled deal that is paid, collection scheduled or
completed and worth 50 or more: the buyer of a sale, the supplier of a recycling deal (same rule as platform_deal_customers.py).
Platform accounts map to CRM companies through crm_platform_accounts -> crm_people.company_id.
Trades Preview side: counterparty offers (any listing) at signed, invoiced, paid or complete, plus demand listings closed
bought_from_us that no such offer answers. Amount comes from offer terms.amount with terms.currency; no currency conversion.
Off-platform deals that exist only in email are not counted. Values are known values, not lifetime totals.
"""
import argparse
import json
import sys
from collections import defaultdict
from decimal import Decimal

import psycopg2

from platform_account_sync import PlatformReader, platform_credentials

PAID_STEPS = {'payment_confirmed', 'collection_scheduled', 'completed'}
MIN_VALUE = 50

TRADES = """
with won as (
  select o.company_id, o.id offer_id, o.counterpart_id,
         case when (o.terms->>'amount') ~ '^[0-9]+(\\.[0-9]+)?$' then (o.terms->>'amount')::numeric end amount,
         upper(coalesce(o.terms->>'currency', '')) currency
  from crm_bulk_offers o join crm_bulk_listings l on l.id = o.bulk_listing_id
  where o.role = 'counterparty' and o.company_id is not null
    and o.stage in ('signed', 'invoiced', 'paid', 'complete')
), bought as (
  select l.company_id, l.id from crm_bulk_listings l
  where l.kind = 'demand' and l.closed_reason = 'bought_from_us' and l.company_id is not null
    and not exists (select 1 from won w where w.counterpart_id = l.id)
)
select company_id, amount, currency from won
union all select company_id, null, '' from bought
"""

WRITE = """
update crm_companies c set total_deals = t.deals, deal_value_gbp = t.gbp, deal_value_eur = t.eur
from unnest(%s::text[], %s::int[], %s::numeric[], %s::numeric[]) as t(id, deals, gbp, eur)
where c.id = t.id and (c.total_deals is distinct from t.deals or c.deal_value_gbp is distinct from t.gbp
                       or c.deal_value_eur is distinct from t.eur)
"""
CLEAR = """
update crm_companies set total_deals = null, deal_value_gbp = null, deal_value_eur = null
where (total_deals is not null or deal_value_gbp is not null or deal_value_eur is not null) and id <> all(%s::text[])
"""


def platform_deals(deals, account_company):
    out = []
    for deal in deals:
        amount = float(deal.get('agreed_amount') or 0)
        if deal['status'] == 'cancelled' or amount < MIN_VALUE:
            continue
        if not (deal['status'] == 'completed' or deal['workflow_step'] in PAID_STEPS):
            continue
        customer = deal['supplier_account_id'] if deal['source_type'] == 'recycling_offer' else deal['counterparty_account_id']
        company = account_company.get(customer)
        if company:
            out.append((company, Decimal(str(amount)), (deal.get('agreed_currency') or '').upper()))
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Write the columns (default: dry run)')
    args = parser.parse_args()
    try:
        reader = PlatformReader(*platform_credentials())
        deals = reader.table('deals', 'id,source_type,status,workflow_step,agreed_amount,agreed_currency,supplier_account_id,'
                             'counterparty_account_id', 'created_at.asc')
        with psycopg2.connect(dbname='denchclaw') as conn, conn.cursor() as cur:
            cur.execute("""select pa.account_id::text, min(p.company_id) from crm_platform_accounts pa
                           join crm_people p on p.id = pa.person_id
                           where pa.review_status <> 'rejected' and p.company_id is not null group by 1""")
            account_company = dict(cur.fetchall())
            rows = platform_deals(deals, account_company)
            cur.execute(TRADES)
            rows += [(c, a, cur_) for c, a, cur_ in cur.fetchall()]
            cur.execute("select id from crm_companies where name ~* '(test|^rebattery$)' or coalesce(domain, '') = 'rebattery.io'")
            skip = {r[0] for r in cur.fetchall()}
            totals = defaultdict(lambda: [0, Decimal(0), Decimal(0)])
            for company, amount, currency in rows:
                if company in skip:
                    continue
                t = totals[company]
                t[0] += 1
                if amount is not None and currency == 'GBP':
                    t[1] += amount
                elif amount is not None and currency == 'EUR':
                    t[2] += amount
            ids = sorted(totals)
            cur.execute(WRITE, (ids, [totals[i][0] for i in ids], [totals[i][1] or None for i in ids],
                                [totals[i][2] or None for i in ids]))
            changed = cur.rowcount
            cur.execute(CLEAR, (ids,))
            cleared = cur.rowcount
            if not args.apply:
                conn.rollback()
        print(json.dumps({'mode': 'apply' if args.apply else 'dry-run', 'platform_deals': len(deals), 'companies': len(ids),
                          'deals_counted': sum(t[0] for t in totals.values()), 'changed': changed, 'cleared': cleared}, sort_keys=True))
    except Exception as exc:
        print(f'Company deal totals failed ({type(exc).__name__}); no CRM changes applied.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
