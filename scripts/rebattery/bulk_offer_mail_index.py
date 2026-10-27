#!/usr/bin/env python3
"""Hourly index of the emails ReBattery sent about bulk-trade offers (REB-572).

Runs after the Gmail sync. Reads sent mail, and for each message tied to a bulk offer:
  1. records one row in crm_bulk_offer_mail (the index);
  2. links the Gmail thread to the listing and offer as `proposed` (never `confirmed`);
  3. stamps the offer's last touch and writes the Story `mail` row if it is missing;
  4. when a reply lands on an indexed thread, logs it at its real time and sets the offer to waiting on us.
It never sends mail, moves a stage, closes a record or alerts. It does not read or write Relay.
Dry run unless --apply. Idempotent: a second run changes nothing.

  bulk_offer_mail_index.py [--apply] [--since YYYY-MM-DD] [--include-recipient]

A message is tied to an offer by an existing thread link (confident). Matching only by recipient is weak (the same person gets
intros, auction updates and replies about other things), so it is off unless --include-recipient; those hits are counted and listed.

Exit code 1 when any message failed, so the cron job shows the failure.
"""
import argparse
import json
import os
import sys
from datetime import date, datetime, timedelta, timezone

import psycopg2
import psycopg2.extras

DSN = os.environ.get("DENCH_CRM_DSN", "host=/var/run/postgresql dbname=denchclaw")
ACTIVE = ("candidate", "offered", "contract_out", "signed", "invoiced", "paid")
OUR_DOMAIN = "@rebattery.io"
CRM = "https://crm.rebattery.io/?path=~trades-preview&listing="


def rows(cur, sql, args=()):
    cur.execute(sql, args)
    return cur.fetchall()


def new_mail(cur, since):
    return rows(cur, """
        select m.id, m.gmail_message_id, m.thread_id, m.subject, m.sent_at, m.identity_key, m.person_id,
               coalesce(array_remove(m.to_emails || m.cc_emails, null), '{}') as recipients,
               coalesce(m.personalization->'attachments', '[]'::jsonb) as attachments
        from mail_message m
        where m.direction = 'outbound' and m.state in ('accepted', 'sent') and m.campaign_id is null
          and m.purpose = 'personal' and m.sent_at >= %s
          and not exists (select 1 from crm_bulk_offer_mail i where i.message_id = m.id)
        order by m.sent_at""", (since,))


def find_offers(cur, m):
    """(matched_by, offers). Thread links win; otherwise the recipient must match exactly one active offer."""
    base = """select o.id as offer_id, o.bulk_listing_id as listing_id, o.stage, o.person_id, l.party, o.name
              from crm_bulk_offers o join crm_bulk_listings l on l.id = o.bulk_listing_id and l.status <> 'closed'
              where o.role = 'counterparty' and o.stage = any(%s) """
    if m["thread_id"]:
        found = rows(cur, base + """and o.id in (select offer_id from crm_bulk_thread_links
                                      where channel = 'mail' and thread_id = %s and offer_id is not null and state <> 'rejected')""",
                     (list(ACTIVE), m["thread_id"]))
        if found:
            return "thread_link", found
    emails = [e.lower() for e in m["recipients"] if e and not e.lower().endswith(OUR_DOMAIN)]
    if not emails and not m["person_id"]:
        return "recipient", []
    found = rows(cur, base + """and (o.person_id = %s or lower(o.contact) = any(%s)
                                      or exists (select 1 from crm_people p where p.id = o.person_id and lower(p.email) = any(%s)))""",
                 (list(ACTIVE), m["person_id"], emails, emails))
    return "recipient", found


def pick(offers, m):
    if len(offers) == 1:
        return offers[0]
    same = [o for o in offers if m["person_id"] and o["person_id"] == m["person_id"]]
    return same[0] if len(same) == 1 else None


def write_index(cur, m, how, o):
    cur.execute("""insert into crm_bulk_offer_mail (message_id, bulk_listing_id, offer_id, person_id, thread_id, identity_key, subject, sent_at, attachments, matched_by)
                   values (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) on conflict (message_id) do nothing""",
                (m["id"], o["listing_id"], o["offer_id"], m["person_id"] or o["person_id"], m["thread_id"], m["identity_key"], m["subject"],
                 m["sent_at"], json.dumps(m["attachments"]), how))
    return cur.rowcount


def link_thread(cur, thread_id, o):
    if not thread_id:
        return 0
    cur.execute("""insert into crm_bulk_thread_links (channel, thread_id, bulk_listing_id, offer_id, confidence, state, reason, labelled_by)
                   values ('mail', %s, %s, %s, 'high', 'proposed', 'Offer email sent to this counterparty (hourly offer-mail index)', 'bulk_offer_mail_index')
                   on conflict (channel, thread_id, bulk_listing_id, coalesce(offer_id, '')) do nothing""",
                (thread_id, o["listing_id"], o["offer_id"]))
    return cur.rowcount


def touch(cur, offer_id, when, via="mail"):
    cur.execute("""update crm_bulk_offers set last_touch_on = %s, last_touch_via = %s, updated_at = now()
                   where id = %s and (last_touch_on is null or last_touch_on < %s)""", (when.date(), via, offer_id, when.date()))
    return cur.rowcount


def story(cur, o, mid, gmail_id, when, title, body, state):
    cur.execute("""select 1 from crm_bulk_listing_activity where kind = 'mail' and bulk_listing_id = %s
                     and (ref_id = any(%s) or data->>'gmail_message_id' = any(%s)) limit 1""",
                (o["listing_id"], [x for x in (mid, gmail_id) if x], [x for x in (mid, gmail_id) if x]))
    if cur.fetchone():
        return 0
    cur.execute("""insert into crm_bulk_listing_activity (bulk_listing_id, offer_id, person_id, kind, title, body, ref_kind, ref_id, data, occurred_at)
                   values (%s,%s,%s,'mail',%s,%s,'email',%s,%s,%s)""",
                (o["listing_id"], o["offer_id"], o.get("person_id"), title[:300], body, mid,
                 json.dumps({"state": state, "gmail_message_id": gmail_id, "source": "bulk_offer_mail_index"}), when))
    return 1


def set_waiting(cur, offer_id, who, since):
    cur.execute("""update crm_bulk_offers set data = data || jsonb_build_object('waiting_on', %s::text, 'waiting_since', %s::text), updated_at = now()
                   where id = %s and (coalesce(data->>'waiting_since', '') < %s or data->>'waiting_since' is null)""",
                (who, since.date().isoformat(), offer_id, since.date().isoformat()))
    return cur.rowcount


def fill_threads(cur):
    """Sent mail has no thread id until Gmail sync runs: fill it in and add the proposed link."""
    n = 0
    for r in rows(cur, """select i.message_id, m.thread_id, i.bulk_listing_id as listing_id, i.offer_id from crm_bulk_offer_mail i
                          join mail_message m on m.id = i.message_id where i.thread_id is null and m.thread_id is not null"""):
        cur.execute("update crm_bulk_offer_mail set thread_id = %s where message_id = %s", (r["thread_id"], r["message_id"]))
        link_thread(cur, r["thread_id"], r)
        n += 1
    return n


def replies(cur):
    """Inbound mail on indexed threads that is not logged yet."""
    return rows(cur, """
        select i.message_id as sent_id, i.bulk_listing_id as listing_id, i.offer_id, i.person_id, i.sent_at as sent_at,
               r.id as reply_id, r.gmail_message_id, r.subject, r.from_email, coalesce(r.sent_at, r.created_at) as reply_at,
               coalesce(r.body_preview, left(r.body_text, 400)) as preview, o.name, l.party
        from crm_bulk_offer_mail i
        join mail_message r on r.thread_id = i.thread_id and r.direction = 'inbound' and coalesce(r.sent_at, r.created_at) > i.sent_at
        left join crm_bulk_offers o on o.id = i.offer_id
        join crm_bulk_listings l on l.id = i.bulk_listing_id and l.status <> 'closed'
        where i.thread_id is not null and lower(coalesce(r.from_email, '')) not like %s
          and not exists (select 1 from crm_bulk_listing_activity a where a.kind = 'mail' and a.bulk_listing_id = i.bulk_listing_id
                          and (a.ref_id = r.id or a.ref_id = r.gmail_message_id or a.data->>'gmail_message_id' = r.gmail_message_id))
        order by coalesce(r.sent_at, r.created_at)""", ("%" + OUR_DOMAIN,))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--since", default=(date.today() - timedelta(days=14)).isoformat())
    ap.add_argument("--include-recipient", action="store_true", help="also index mail tied to an offer only by its recipient")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    conn = psycopg2.connect(DSN)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    s = dict(indexed=0, linked=0, touched=0, story=0, threads_filled=0, replies=0, not_offer_mail=0, recipient_only=0, ambiguous=0, errors=0)
    recipient_only, ambiguous, errors = [], [], []
    waiting = {}  # offer id -> (who, when): the latest message decides

    for m in new_mail(cur, args.since):
        try:
            how, offers = find_offers(cur, m)
            if not offers:
                s["not_offer_mail"] += 1
                continue
            if how == "recipient" and not args.include_recipient:
                s["recipient_only"] += 1
                recipient_only.append(f"{m['sent_at']:%Y-%m-%d} {(m['subject'] or '')[:60]} -> {', '.join(sorted({x['party'] for x in offers}))}")
                continue
            o = pick(offers, m)
            if o is None:
                s["ambiguous"] += 1
                ambiguous.append(f"{m['sent_at']:%Y-%m-%d} {m['subject'][:60] if m['subject'] else ''} -> {', '.join(sorted({x['party'] for x in offers}))}")
                continue
            if args.verbose or not args.apply:
                print(f"  {m['sent_at']:%Y-%m-%d} [{how}] {o['party']} / {o['name']} <- {(m['subject'] or '')[:70]}")
            cur.execute("savepoint s")
            s["indexed"] += write_index(cur, m, how, o)
            s["linked"] += link_thread(cur, m["thread_id"], o)
            s["touched"] += touch(cur, o["offer_id"], m["sent_at"])
            s["story"] += story(cur, o, m["id"], m["gmail_message_id"], m["sent_at"], f"Offer email sent to {o['name'] or o['party']}", m["subject"], "sent")
            waiting[o["offer_id"]] = ("them", m["sent_at"])
            cur.execute("release savepoint s")
        except Exception as exc:  # one bad message must not hide the rest
            if conn.get_transaction_status() == psycopg2.extensions.TRANSACTION_STATUS_INERROR:
                cur.execute("rollback to savepoint s")
            s["errors"] += 1
            errors.append(f"{m['id']}: {exc}")
    s["threads_filled"] = fill_threads(cur)

    for r in replies(cur):
        try:
            cur.execute("savepoint r")
            o = {"listing_id": r["listing_id"], "offer_id": r["offer_id"], "person_id": r["person_id"]}
            who = r["name"] or r["party"]
            if args.verbose or not args.apply:
                print(f"  reply {r['reply_at']:%Y-%m-%d} {who} / {r['party']}: {(r['subject'] or '')[:60]}")
            s["replies"] += story(cur, o, r["reply_id"], r["gmail_message_id"], r["reply_at"], f"Reply from {who}", r["preview"], "received")
            if r["offer_id"]:
                touch(cur, r["offer_id"], r["reply_at"])
                if waiting.get(r["offer_id"], ("", datetime.min.replace(tzinfo=timezone.utc)))[1] < r["reply_at"]:
                    waiting[r["offer_id"]] = ("us", r["reply_at"])
            cur.execute("""update crm_bulk_offer_mail set replied_at = coalesce(replied_at, %s), reply_message_id = coalesce(reply_message_id, %s)
                           where message_id = %s""", (r["reply_at"], r["reply_id"], r["sent_id"]))
            cur.execute("release savepoint r")
        except Exception as exc:
            cur.execute("rollback to savepoint r")
            s["errors"] += 1
            errors.append(f"reply {r['reply_id']}: {exc}")
    for offer_id, (who, when) in waiting.items():
        set_waiting(cur, offer_id, who, when)

    if args.apply:
        conn.commit()
    else:
        conn.rollback()
    mode = "APPLIED" if args.apply else "DRY RUN (nothing written)"
    print(f"bulk offer mail index {mode}, since {args.since}: " + ", ".join(f"{k} {v}" for k, v in s.items()))
    for line in recipient_only[:10]:
        print("  recipient-only (not indexed; confirm a thread link to include):", line)
    for line in ambiguous[:10]:
        print("  ambiguous (more than one active offer for the recipient):", line)
    for e in errors:
        print("  ERROR", e, file=sys.stderr)
    sys.exit(1 if s["errors"] else 0)


if __name__ == "__main__":
    main()
