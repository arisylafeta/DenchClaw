#!/usr/bin/env python3
"""Report: Regular Wants (buyer_interest kind 'standing') that expire in the next N days. Read-only.

Prints Markdown to stdout: buyer, product key, last said, last bought, last contact (the latest mail to or from the
buyer's people, or the latest crm_interactions row for the company or its people), and the expiry date.

  wants_expiring.py [--days 30] [--dsn <dsn>]
"""
import argparse
import sys

DEFAULT_DSN = "host=/var/run/postgresql dbname=denchclaw"

SQL = """
with wants as (
  select w.id, w.company_id, w.product_key, w.last_seen, w.expires_on,
         (select max(b.last_seen) from buyer_interest b
           where b.company_id = w.company_id and b.product_key = w.product_key and b.kind = 'bought') as last_bought
    from buyer_interest w
   where w.kind = 'standing' and w.expires_on between current_date and current_date + %(days)s::int),
people as (
  select p.company_id, p.id as person_id, lower(p.email) as email from crm_people p
   where p.company_id in (select company_id from wants)),
mail as (
  select p.company_id, max(coalesce(m.sent_at, m.created_at)) as at
    from people p
    join mail_message m on p.email is not null and p.email <> ''
     and (lower(m.from_email) = p.email
          or p.email = any (select lower(x) from unnest(coalesce(m.to_emails, '{}')) x)
          or p.email = any (select lower(x) from unnest(coalesce(m.cc_emails, '{}')) x))
   group by p.company_id),
interactions as (
  select c.company_id, max(i.occurred_at) as at
    from (select distinct company_id from wants) c
    join crm_interactions i on i.company_id = c.company_id
          or i.person_id in (select person_id from people where people.company_id = c.company_id)
   group by c.company_id)
select w.expires_on, co.name as buyer, w.company_id, w.product_key, w.last_seen, w.last_bought,
       greatest(mail.at, interactions.at)::date as last_contact
  from wants w
  left join crm_companies co on co.id = w.company_id
  left join mail on mail.company_id = w.company_id
  left join interactions on interactions.company_id = w.company_id
 order by w.expires_on, co.name, w.product_key
"""


def render(rows, days):
    lines = [f"# Regular Wants expiring in the next {days} days", "", f"{len(rows)} Regular Wants.", ""]
    if rows:
        lines += ["| Buyer | Product | Last said | Last bought | Last contact | Expires |", "|---|---|---|---|---|---|"]
        for r in rows:
            cells = [r["buyer"] or r["company_id"], r["product_key"], r["last_seen"], r["last_bought"],
                     r["last_contact"], r["expires_on"]]
            lines.append("| " + " | ".join("" if c is None else str(c).replace("|", "/") for c in cells) + " |")
    return "\n".join(lines) + "\n"


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--days", type=int, default=30)
    parser.add_argument("--dsn", default=DEFAULT_DSN)
    args = parser.parse_args(argv)
    import psycopg2
    import psycopg2.extras
    conn = psycopg2.connect(args.dsn)
    conn.set_session(readonly=True, autocommit=False)
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute(SQL, {"days": args.days})
            rows = cur.fetchall()
    finally:
        conn.rollback()
        conn.close()
    sys.stdout.write(render(rows, args.days))
    return 0


if __name__ == "__main__":
    sys.exit(main())
