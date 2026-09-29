#!/usr/bin/env python3
"""Bulk Trades auction sync: every marketplace auction is a bulk trade, and everyone who engages
with an auction is on that trade's buyer list.

  bulk_trade_auction_sync.py                 # one sync: link auctions to trades, refresh their people
  bulk_trade_auction_sync.py --dry-run       # print what it would do, write nothing
  ... --only-at 07:30,16:30                  # act only within 15 minutes after these UK times

Reads the ReBattery platform database (read-only, through its REST API with the key in
dench-platform-admin.env) and writes to the CRM database:

1. Linking. Each published or withdrawn auction is tied to one trade, by the trade's marketplace
   listing, else by the auction's pack or cell model appearing in exactly one live trade's title or
   model. A published auction with no trade gets a new one, filled from the listing. When several
   trades could match, Alex gets a "link auction" card instead of a guess.
2. People. For each auction trade it collects, by email: the auction invite email (sent and
   clicked, from crm_campaign_sends), offers, buy-now requests and messages
   (public.auction_submissions) and signed-in page views (public.auction_views). They are kept in
   crm_bulk_trade_auction_people for the trade page.
3. Buyers. Someone who clicked the invite, viewed the auction signed in, messaged or made an offer
   is added as a buyer (Bid in after an offer or buy-now request, else Teaser sent), and each offer
   is recorded as a bid. Moving an existing buyer on stays a card for Alex. People who were only
   invited stay on the trade's auction card. ReBattery addresses are skipped.
Changes are kept as applied proposals, so they can be undone in the app like inbox-check findings.
"""

import argparse
import datetime as dt
import importlib.util
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg2
import psycopg2.extras

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("bulk_trade_inbox_check", HERE / "bulk_trade_inbox_check.py")
check = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check)

PLATFORM_ENV = Path("/root/.hermes/workspace/secrets/dench-platform-admin.env")
EARLY_STATUSES = ("To contact", "Teaser sent", "No reply", "NDA, specs sent")
KIND_BY_FORMAT = {"pack": "packs", "cell": "cells", "module": "packs", "system": "systems"}
UNIT_BY_KIND = {"packs": "pack", "cells": "cell", "systems": "system"}
CURRENCY_SIGN = {"EUR": "€", "USD": "$", "GBP": "£"}
INTERNAL = re.compile(r"@rebattery\.io$|@example\.|\.test$", re.I)


# ---------------------------------------------------------------------------
# Platform reads
# ---------------------------------------------------------------------------

class Platform:
    """Read-only access to the platform's REST API with the service key."""

    def __init__(self, env_path=PLATFORM_ENV):
        self.url = check.read_env_value(env_path, "NEXT_PUBLIC_SUPABASE_URL")
        self.key = check.read_env_value(env_path, "SUPABASE_SECRET_KEY")
        self.site = (check.read_env_value(env_path, "NEXT_PUBLIC_SITE_URL") or "https://rebattery.io").rstrip("/")
        if not self.url or not self.key:
            raise SystemExit(f"platform URL or key missing in {env_path}")

    def get(self, table, params):
        query = urllib.parse.urlencode(params, safe="(),.*:!")
        request = urllib.request.Request(f"{self.url}/rest/v1/{table}?{query}", headers={
            "apikey": self.key, "Authorization": f"Bearer {self.key}", "Accept": "application/json"})
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read())

    def auctions(self):
        rows = self.get("auctions", {
            "select": "id,slug,status,closes_at,access_scope,listing_id,listings(title,listing_specs("
                      "manufacturer,model,chemistry,format,pack_kwh,quantity,quantity_available,year_manufacture,soh,location_address))",
            "status": "in.(published,withdrawn)", "order": "created_at"})
        for row in rows:
            listing = row.pop("listings") or {}
            specs = listing.get("listing_specs") or {}
            row["title"] = listing.get("title") or row["slug"]
            row["specs"] = specs[0] if isinstance(specs, list) and specs else specs if isinstance(specs, dict) else {}
            row["url"] = f"{self.site}/marketplace/auctions/{row['slug']}"
        return rows

    def submissions(self, auction_ids):
        return self.get("auction_submissions", {
            "select": "id,auction_id,submission_kind,email,price_per_kwh,amount_per_unit,quantity_requested,currency,"
                      "incoterm,site_visit_requested,message,created_at",
            "auction_id": f"in.({','.join(auction_ids)})", "order": "created_at"}) if auction_ids else []

    def views(self, auction_ids):
        """Signed-in page views. Returns [] until the platform records them."""
        if not auction_ids:
            return []
        try:
            return self.get("auction_views", {
                "select": "auction_id,email,first_viewed_at,last_viewed_at,view_count",
                "auction_id": f"in.({','.join(auction_ids)})"})
        except urllib.error.HTTPError as err:
            if err.code == 404:
                return []
            raise


# ---------------------------------------------------------------------------
# Linking auctions to trades
# ---------------------------------------------------------------------------

def squash(text):
    return re.sub(r"[^a-z0-9]", "", (text or "").lower())


def trade_kind(auction):
    return KIND_BY_FORMAT.get(str(auction["specs"].get("format") or "").lower(), "packs")


def candidates(cur, auction):
    """Live trades without an auction whose title or model names the auction's model."""
    model = squash(auction["specs"].get("model"))
    if len(model) < 5:
        return []
    cur.execute(
        """select l.id, l.title, f.value as model from crm_bulk_trade_lots l
           left join crm_bulk_trade_fields f on f.lot_id = l.id and f.field_key = 'model'
           where l.auction_id is null and l.trade_stage in ('Needs info', 'With buyers', 'Closing')""")
    return [row["id"] for row in cur.fetchall() if model in squash(row["title"]) or model in squash(row["model"])]


def listing_fields(auction):
    """Template fields a new trade can take from its marketplace listing."""
    specs, kind = auction["specs"], trade_kind(auction)
    unit = UNIT_BY_KIND.get(kind, "pack")
    location = specs.get("location_address") if isinstance(specs.get("location_address"), dict) else {}
    fields = {
        "model": " ".join(x for x in (specs.get("manufacturer"), specs.get("model")) if x),
        "chemistry": specs.get("chemistry"),
        "capacity" if kind != "systems" else "energy": f"{specs['pack_kwh']:g} kWh per {unit}" if specs.get("pack_kwh") else None,
        "quantity": f"{specs['quantity_available'] or specs.get('quantity')} {unit}s" if specs.get("quantity_available") or specs.get("quantity") else None,
        "manufacture_date" if kind != "systems" else "commissioned": str(specs["year_manufacture"]) if specs.get("year_manufacture") else None,
        "soh": f"{specs['soh']:g}%" if specs.get("soh") else None,
        "location": ", ".join(x for x in (location.get("city"), location.get("country")) if x),
    }
    keys = {f["key"] for f in check.TEMPLATES["fields"][kind]}
    return {k: str(v) for k, v in fields.items() if v and k in keys}


def create_trade(cur, auction):
    kind = trade_kind(auction)
    lot_id = f"bulk-{auction['slug']}"[:120]
    closes = auction["closes_at"][:10]
    row = {"id": lot_id, "title": auction["title"], "trade_stage": "With buyers", "trade_kind": kind,
           "next_step": f"Watch auction offers; closes {closes}", "next_step_due": closes, "waiting_on": "them",
           "listing_id": auction["listing_id"]}
    cur.execute(
        """insert into crm_bulk_trade_lots (id, lot_kind, summary, observed_outcome, confidence, title, trade_stage, trade_kind,
             next_step, next_step_due, waiting_on, waiting_since, listing_id)
           values (%(id)s, 'supply', '', '', 'confirmed', %(title)s, %(trade_stage)s, %(trade_kind)s, %(next_step)s,
             %(next_step_due)s, %(waiting_on)s, current_date, %(listing_id)s)""", row)
    check.log_event(cur, lot_id, "trade_created", {**row, "via": "auction sync", "auction": auction["slug"]})
    for key, value in listing_fields(auction).items():
        template = next(f for f in check.TEMPLATES["fields"][kind] if f["key"] == key)
        cur.execute(
            """insert into crm_bulk_trade_fields (lot_id, field_key, value, status, visibility, source_label, source_url, source_date)
               values (%s, %s, %s, 'confirmed', %s, 'Marketplace listing', %s, current_date)""",
            (lot_id, key, value, template["visibility"], auction["url"]))
        check.log_event(cur, lot_id, "field_updated", {"field": key, "value": [None, value], "via": "auction sync"})
    return lot_id


def link(cur, lot_id, auction):
    cur.execute(
        """update crm_bulk_trade_lots set auction_id = %s, auction_slug = %s, auction_status = %s, auction_closes_at = %s,
             listing_id = coalesce(listing_id, %s), updated_at = now()
           where id = %s""",
        (auction["id"], auction["slug"], auction["status"], auction["closes_at"], auction["listing_id"], lot_id))


def link_card(auction, lots):
    return {"kind": "link_auction", "target": auction["id"],
            "proposed": {"auction_id": auction["id"], "slug": auction["slug"], "title": auction["title"],
                         "closes_at": auction["closes_at"], "listing_id": auction["listing_id"], "lot_ids": sorted(lots)},
            "summary": f"Auction “{auction['title']}” could be one of {len(lots)} trades. Link it to this one?",
            "quote": auction["title"], "source": auction_source(auction, f"auction:{auction['id']}", None, auction["title"])}


def place_auctions(cur, run_id, auctions, report, dry_run):
    """Links every auction to a trade. Returns {auction id: lot_id} for the linked ones."""
    cur.execute("select id, auction_id, listing_id from crm_bulk_trade_lots where auction_id is not null or listing_id is not null")
    rows = cur.fetchall()
    by_auction = {r["auction_id"]: r["id"] for r in rows if r["auction_id"]}
    by_listing = {}
    for r in rows:
        if r["listing_id"] and not r["auction_id"]:
            by_listing.setdefault(r["listing_id"], []).append(r["id"])
    linked = {}
    for auction in auctions:
        lot_id = by_auction.get(auction["id"])
        how = "known"
        if not lot_id and len(by_listing.get(auction["listing_id"], [])) == 1:
            lot_id, how = by_listing[auction["listing_id"]][0], "listing"
        if not lot_id:
            matches = candidates(cur, auction)
            if len(matches) == 1:
                lot_id, how = matches[0], "model"
            elif len(matches) > 1:
                report["cards"].append({"auction": auction["slug"], "lots": matches})
                if not dry_run:
                    check.insert_proposal(cur, run_id, matches[0], link_card(auction, matches))
                continue
        if not lot_id:
            if auction["status"] != "published" or check.parse_time(auction["closes_at"]) < dt.datetime.now(dt.timezone.utc):
                continue  # no new trades for withdrawn or closed auctions
            how = "created"
            lot_id = create_trade(cur, auction) if not dry_run else f"(new) bulk-{auction['slug']}"
        if how != "known":
            report["linked"].append({"auction": auction["slug"], "lot_id": lot_id, "how": how})
        if not dry_run:
            link(cur, lot_id, auction)
        linked[auction["id"]] = lot_id
    return linked


# ---------------------------------------------------------------------------
# People and buyers
# ---------------------------------------------------------------------------

def auction_source(auction, source_id, at, text):
    return {"kind": "auction", "id": source_id, "key": f"auction:{auction['id']}", "thread": None, "at": at,
            "url": auction["url"], "label": f"Auction · {auction['slug']}", "text": text}


def money(currency, amount):
    return f"{CURRENCY_SIGN.get(currency, (currency or '') + ' ')}{amount:,.2f}".rstrip("0").rstrip(".")


def offer_text(offer, unit):
    if offer["kind"] == "offer":
        text = f"Offer {money(offer['currency'], offer['price_per_kwh'])}/kWh, {offer['quantity']} {unit}s, {offer['incoterm']}"
        return text + (", site visit requested" if offer.get("site_visit") else "")
    return f"Buy now: {offer['quantity']} {unit}s at {money(offer['currency'], offer['amount_per_unit'])}/{unit}"


def collect_people(cur, lot_id, listing_id, auction_id, submissions, views):
    """Everyone who was invited to or engaged with one auction, keyed by email."""
    people = {}

    def person(email):
        email = (email or "").strip().lower()
        if not email or INTERNAL.search(email):
            return None
        return people.setdefault(email, {"email": email, "invited_at": None, "clicked_at": None, "first_viewed_at": None,
                                         "last_viewed_at": None, "view_count": 0, "offers": [], "messages": []})

    if listing_id:
        cur.execute(
            """select lower(recipient_email) as email, min(accepted_at) as invited_at, min(provider_link_clicked_at) as clicked_at
               from crm_campaign_sends where listing_id = %s and accepted_at is not null group by 1""", (listing_id,))
        for row in cur.fetchall():
            p = person(row["email"])
            if p:
                p["invited_at"], p["clicked_at"] = row["invited_at"], row["clicked_at"]
    for s in submissions:
        if s["auction_id"] != auction_id:
            continue
        p = person(s["email"])
        if not p:
            continue
        at = check.parse_time(s["created_at"])
        if s["submission_kind"] == "message":
            p["messages"].append({"id": s["id"], "at": at, "text": s["message"]})
        else:
            p["offers"].append({"id": s["id"], "at": at, "kind": s["submission_kind"], "price_per_kwh": _num(s["price_per_kwh"]),
                                "amount_per_unit": _num(s["amount_per_unit"]), "currency": s["currency"],
                                "quantity": s["quantity_requested"], "incoterm": s["incoterm"],
                                "site_visit": s["site_visit_requested"]})
    for v in views:
        if v["auction_id"] != auction_id:
            continue
        p = person(v.get("email"))
        if p:
            p["first_viewed_at"] = check.parse_time(v["first_viewed_at"])
            p["last_viewed_at"] = check.parse_time(v["last_viewed_at"])
            p["view_count"] = v["view_count"] or 0
    return people


def _num(value):
    return float(value) if value is not None else None


def engaged(p):
    return bool(p["clicked_at"] or p["view_count"] or p["offers"] or p["messages"])


def last_activity(p):
    times = [p["clicked_at"], p["last_viewed_at"], *(o["at"] for o in p["offers"]), *(m["at"] for m in p["messages"])]
    times = [check.parse_time(t) for t in times if t]
    return max(times) if times else None


def crm_person(cur, email):
    cur.execute(
        """select p.id, p.full_name, c.name as company from crm_people p left join crm_companies c on c.id = p.company_id
           where lower(p.email) = %s order by p.updated_at desc nulls last limit 1""", (email,))
    return cur.fetchone()


def already_proposed(cur, lot_id, source_id):
    cur.execute("select 1 from crm_bulk_trade_proposals where lot_id = %s and source_id = %s limit 1", (lot_id, source_id))
    return cur.fetchone() is not None


def find_buyer(cur, lot_id, email, person_id):
    cur.execute(
        """select id, status from crm_bulk_trade_buyers
           where lot_id = %s and ((%s::text is not null and person_id = %s) or lower(coalesce(contact, '')) like '%%' || %s || '%%')
           order by created_at limit 1""", (lot_id, person_id, person_id, email))
    return cur.fetchone()


def sync_people(cur, run_id, lot_id, auction, people, ctx, report, dry_run):
    kind = check.load_trades(cur, [lot_id])[lot_id]["trade_kind"] or "packs"
    unit = UNIT_BY_KIND.get(kind, "pack")
    for p in people.values():
        crm = crm_person(cur, p["email"])
        person_id = crm["id"] if crm else None
        buyer = find_buyer(cur, lot_id, p["email"], person_id)
        latest = last_activity(p)
        offers = sorted(p["offers"], key=lambda o: o["at"])
        if engaged(p):
            findings = []
            buyer_source = f"buyer:{auction['id']}:{p['email']}"
            if not buyer and not already_proposed(cur, lot_id, buyer_source):  # once only, so an undo sticks
                name = (crm and crm["company"]) or p["email"].split("@")[1].split(".")[0].title()
                contact = f"{crm['full_name']} ({p['email']})" if crm and crm["full_name"] else p["email"]
                what = offer_text(offers[-1], unit) if offers else "Viewed the auction" if p["view_count"] else \
                    "Messaged about the auction" if p["messages"] else "Clicked the auction invite"
                findings.append({"kind": "new_buyer", "target": None,
                                 "proposed": {"name": name, "contact": contact, "wants": None, "person_id": person_id,
                                              "status": "Bid in" if offers else "Teaser sent",
                                              "last_touch_on": latest.date().isoformat() if latest else None,
                                              "last_touch_via": "Auction"},
                                 "summary": f"{name} engaged with the auction: {what}. Added as a buyer.",
                                 "quote": what, "source": auction_source(auction, buyer_source, latest, what)})
            elif buyer and latest:
                day = latest.date().isoformat()
                findings.append({"kind": "buyer_update", "target": buyer["id"],
                                 "proposed": {"last_touch_on": day, "last_touch_via": "Auction"},
                                 "summary": f"{p['email']} was active on the auction on {day}.", "quote": f"Auction activity {day}",
                                 "source": auction_source(auction, f"touch:{auction['id']}:{p['email']}:{day}", latest, "")})
            for o in offers:
                findings.append({"kind": "bid", "offer": o})
            for f in findings:
                if f["kind"] == "buyer_update":
                    if not dry_run and check.settle(cur, run_id, lot_id, f, None, ctx):
                        report["applied"].append({"lot_id": lot_id, "kind": "buyer_update", "summary": f["summary"]})
                    continue
                if f["kind"] == "new_buyer":
                    ctx["undo"] = None
                    outcome = "applied" if dry_run else check.settle(cur, run_id, lot_id, f, None, ctx)
                    if outcome:
                        report["applied"].append({"lot_id": lot_id, "kind": "new_buyer", "summary": f["summary"]})
                    buyer = find_buyer(cur, lot_id, p["email"], person_id) if not dry_run else {"id": None, "status": f["proposed"]["status"]}
                    if not buyer and (ctx.get("undo") or {}).get("id"):
                        buyer = {"id": ctx["undo"]["id"], "status": f["proposed"]["status"]}
                    continue
                if not buyer or not buyer["id"]:
                    continue
                o = f["offer"]
                text = offer_text(o, unit)
                amount, bid_unit = (o["price_per_kwh"], "kWh") if o["kind"] == "offer" else (o["amount_per_unit"], unit if unit in ("pack", "cell") else "pack")
                terms = ", ".join(x for x in (o.get("incoterm"), f"{o['quantity']} {unit}s", "site visit requested" if o.get("site_visit") else None) if x)
                bid = {"kind": "bid", "target": buyer["id"],
                       "proposed": {"amount": amount, "unit": bid_unit, "currency": o["currency"], "firmness": "indicative",
                                    "delivery_terms": terms},
                       "summary": f"Auction {text.lower() if o['kind'] == 'offer' else text}.",
                       "quote": text, "source": auction_source(auction, f"submission:{o['id']}", o["at"], text)}
                if dry_run:
                    report["applied"].append({"lot_id": lot_id, "kind": "bid", "summary": bid["summary"]})
                    continue
                if check.settle(cur, run_id, lot_id, bid, None, ctx):
                    report["applied"].append({"lot_id": lot_id, "kind": "bid", "summary": bid["summary"]})
                if buyer["status"] in EARLY_STATUSES:  # moving an existing buyer on is Alex's call
                    card = {"kind": "buyer_update", "target": buyer["id"], "proposed": {"status": "Bid in"},
                            "summary": f"Auction offer from {p['email']}: {text}. Move them to Bid in?",
                            "quote": text, "source": bid["source"]}
                    if check.settle(cur, run_id, lot_id, card, None, ctx):
                        report["cards"].append({"lot_id": lot_id, "summary": card["summary"]})
        if not dry_run:
            cur.execute(
                """insert into crm_bulk_trade_auction_people (lot_id, email, person_id, buyer_id, invited_at, clicked_at,
                     first_viewed_at, last_viewed_at, view_count, offer_count, last_offer, message_count, last_activity_at, synced_at)
                   values (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, now())
                   on conflict (lot_id, email) do update set person_id = excluded.person_id,
                     buyer_id = coalesce(excluded.buyer_id, crm_bulk_trade_auction_people.buyer_id),
                     invited_at = excluded.invited_at, clicked_at = excluded.clicked_at, first_viewed_at = excluded.first_viewed_at,
                     last_viewed_at = excluded.last_viewed_at, view_count = excluded.view_count, offer_count = excluded.offer_count,
                     last_offer = excluded.last_offer, message_count = excluded.message_count,
                     last_activity_at = excluded.last_activity_at, synced_at = now()""",
                (lot_id, p["email"], person_id, buyer["id"] if buyer else None, p["invited_at"], p["clicked_at"],
                 p["first_viewed_at"], p["last_viewed_at"], p["view_count"], len(offers),
                 json.dumps({**offers[-1], "at": offers[-1]["at"].isoformat()}, default=str) if offers else None,
                 len(p["messages"]), latest))


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------

def run(conn, args, platform=None):
    platform = platform or Platform()
    auctions = platform.auctions()
    run_id = check.new_run(conn, args, "auctions")
    report = {"run_id": run_id, "auctions": len(auctions), "linked": [], "applied": [], "cards": [], "warnings": [], "people": 0}
    ctx = {"mailbox": None, "download": None, "new_contacts": set(), "warnings": report["warnings"]}
    try:
        with conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
            cur.execute("select pg_try_advisory_lock(hashtext('bulk_trade_auction_sync')) as locked")
            if not cur.fetchone()["locked"]:
                print("Another auction sync is running; skipped.")
                return 0
            linked = place_auctions(cur, run_id, auctions, report, args.dry_run)
            ids = [a for a in linked]
            submissions, views = platform.submissions(ids), platform.views(ids)
            by_id = {a["id"]: a for a in auctions}
            for auction_id, lot_id in linked.items():
                if lot_id.startswith("(new)"):
                    continue
                cur.execute("select listing_id from crm_bulk_trade_lots where id = %s", (lot_id,))
                listing_id = cur.fetchone()["listing_id"]
                people = collect_people(cur, lot_id, listing_id, auction_id, submissions, views)
                report["people"] += len(people)
                sync_people(cur, run_id, lot_id, by_id[auction_id], people, ctx, report, args.dry_run)
            if not args.dry_run:
                cur.execute(
                    """update crm_bulk_trade_check_runs set status = 'ok', finished_at = now(), proposals_made = %s, error = %s
                       where id = %s""",
                    (len(report["applied"]) + len(report["cards"]), "; ".join(report["warnings"]) or None, run_id))
            conn.commit()
    except Exception as err:
        check.fail_run(conn, run_id, err)
        raise
    json.dump(report, sys.stdout, indent=2, ensure_ascii=False, default=str)
    print()
    return 0


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dsn", default="host=/var/run/postgresql dbname=denchclaw")
    parser.add_argument("--dry-run", action="store_true", help="print what it would do and write nothing")
    parser.add_argument("--only-at", help="comma-separated UK times; do nothing outside them")
    args = parser.parse_args()
    if args.only_at and not check.due_now([t.strip() for t in args.only_at.split(",") if t.strip()]):
        return 0
    conn = psycopg2.connect(args.dsn)
    try:
        return run(conn, args)
    finally:
        conn.close()


if __name__ == "__main__":
    sys.exit(main())
