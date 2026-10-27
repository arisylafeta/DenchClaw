#!/usr/bin/env python3
"""Hourly index of the emails ReBattery sent about bulk-trade offers (REB-572).

Runs after the Gmail sync. Reads sent mail, and for each message tied to a bulk offer:
  1. records one row in crm_bulk_offer_mail (the index);
  2. links the Gmail thread to the listing and offer as `proposed` (never `confirmed`);
  3. stamps the offer's last touch and writes the Story `mail` row if it is missing;
  4. when a reply lands on an indexed thread, logs it at its real time and sets the offer to waiting on us;
  5. flags offers at `offered` with no reply past their chase date.
It never sends mail, moves a stage or closes a record. Dry run unless --apply. Idempotent: a second run changes nothing.

  bulk_offer_mail_index.py [--apply] [--since YYYY-MM-DD] [--no-alert] [--alert-to discord:<chat id>] [--include-recipient]

A message is tied to an offer by an existing thread link (confident). Matching only by recipient is weak (the same person gets
intros, auction updates and replies about other things), so it is off unless --include-recipient; those hits are counted and listed.

Exit code 1 when any message failed, so the cron job shows the failure. Alerts go through `hermes send` (no model), and
carry company, listing and dates only, never email addresses.
"""
import argparse
import json
import os
import subprocess
import sys
from datetime import date, datetime, timedelta, timezone

import psycopg2
import psycopg2.extras

DSN = os.environ.get("DENCH_CRM_DSN", "host=/var/run/postgresql dbname=denchclaw")
ALERT_REPLY_DAYS = 3    # older replies are logged but not announced
ALERT_CHASE_DAYS = 30   # an offer sent longer ago than this is stale, not a chase to announce
ACTIVE = ("candidate", "offered", "contract_out", "signed", "invoiced", "paid")
OUR_DOMAIN = "@rebattery.io"
DEFAULT_CHASE_DAYS = 7
CRM = "https://crm.rebattery.io/?path=~trades-preview&listing="
DEFAULT_ALERT = "discord:1523383956878266388"  # the offers and deals channel


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


def overdue(cur, today, window_days=ALERT_CHASE_DAYS):
    return rows(cur, """
        select o.id as offer_id, o.bulk_listing_id as listing_id, o.name, l.party,
               coalesce(nullif(o.data->>'chase_on', ''), nullif(o.data->>'next_due', ''), (max(i.sent_at)::date + %s)::text) as chase_on,
               max(i.sent_at)::date as sent_on, (array_agg(i.message_id order by i.sent_at desc))[1] as last_message
        from crm_bulk_offers o join crm_bulk_offer_mail i on i.offer_id = o.id
        join crm_bulk_listings l on l.id = o.bulk_listing_id and l.status <> 'closed'
        where o.stage = 'offered' and coalesce(o.data->>'waiting_on', 'them') <> 'us'
          and not exists (select 1 from crm_bulk_offer_mail x where x.offer_id = o.id and x.replied_at is not null and x.replied_at >= i.sent_at)
          and not exists (select 1 from crm_bulk_offer_mail x where x.offer_id = o.id and x.chase_alerted_at is not null and x.sent_at = (select max(sent_at) from crm_bulk_offer_mail where offer_id = o.id))
        group by o.id, o.bulk_listing_id, o.name, l.party, o.data
        having max(i.sent_at) >= %s::date - %s and coalesce(nullif(o.data->>'chase_on', ''), nullif(o.data->>'next_due', ''), (max(i.sent_at)::date + %s)::text) < %s
        order by 5""", (DEFAULT_CHASE_DAYS, today.isoformat(), window_days, DEFAULT_CHASE_DAYS, today.isoformat()))


def send_alert(target, text):
    r = subprocess.run(["hermes", "send", "--json", "-t", target, text], capture_output=True, text=True, timeout=120)
    if r.returncode != 0:
        raise RuntimeError(f"hermes send failed: {r.stderr.strip()[:300] or r.stdout.strip()[:300]}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--since", default=(date.today() - timedelta(days=14)).isoformat())
    ap.add_argument("--no-alert", action="store_true")
    ap.add_argument("--alert-to", default=os.environ.get("BULK_OFFER_ALERT_TO", DEFAULT_ALERT))
    ap.add_argument("--include-recipient", action="store_true", help="also index mail tied to an offer only by its recipient")
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()
    conn = psycopg2.connect(DSN)
    conn.autocommit = False
    cur = conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    s = dict(indexed=0, linked=0, touched=0, story=0, threads_filled=0, replies=0, not_offer_mail=0, recipient_only=0, ambiguous=0, overdue=0, errors=0)
    recipient_only, ambiguous, alerts, errors = [], [], [], []
    today = datetime.now(timezone.utc).date()
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
            if r["reply_at"] >= datetime.now(timezone.utc) - timedelta(days=ALERT_REPLY_DAYS):
                alerts.append((r["sent_id"], f"Reply on a bulk offer: **{who}** answered about {r['party']}. Log it, then propose the next step. {CRM}{r['listing_id']}"))
            cur.execute("release savepoint r")
        except Exception as exc:
            cur.execute("rollback to savepoint r")
            s["errors"] += 1
            errors.append(f"reply {r['reply_id']}: {exc}")
    for offer_id, (who, when) in waiting.items():
        set_waiting(cur, offer_id, who, when)

    chases = overdue(cur, today)
    s["overdue"] = len(chases)
    if args.verbose or not args.apply:
        for c in chases:
            print(f"  chase due {c['chase_on']}: {c['name'] or c['party']} / {c['party']} (sent {c['sent_on']})")
    for c in chases:
        alerts.append((None, f"Chase due: **{c['name'] or c['party']}** has had the offer since {c['sent_on']}, no reply, chase date {c['chase_on']}. {CRM}{c['listing_id']}"))

    if args.apply:
        conn.commit()
        if alerts and not args.no_alert:
            body = "Bulk offers\n" + "\n".join(f"- {t}" for _, t in alerts[:15]) + (f"\n(+{len(alerts) - 15} more)" if len(alerts) > 15 else "")
            try:
                send_alert(args.alert_to, body)
                for sent_id, _ in alerts:
                    if sent_id:
                        cur.execute("update crm_bulk_offer_mail set reply_alerted_at = now() where message_id = %s and reply_alerted_at is null", (sent_id,))
                for c in chases:
                    cur.execute("update crm_bulk_offer_mail set chase_alerted_at = now() where message_id = %s", (c["last_message"],))
                conn.commit()
            except Exception as exc:
                conn.rollback()
                s["errors"] += 1
                errors.append(f"alert: {exc}")
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
