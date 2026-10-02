#!/usr/bin/env python3
"""Freeze CRM cohorts, send approved Postmark campaigns, and reconcile receipts.

All mutations require --apply. Launch additionally requires an approved manifest
digest and DENCH_CAMPAIGN_LIVE_SEND=1. Never retry an ambiguous send automatically.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor


def connection(read_only=False):
    db = psycopg2.connect(os.environ.get("DENCH_CAMPAIGN_DSN", "dbname=denchclaw"))
    db.set_session(readonly=read_only)
    return db


def load_manifest(path):
    manifest = json.loads(Path(path).read_text())
    required = ("id", "name", "objective", "success_measure", "listing_id", "auction_url", "stock_snapshot_ref",
                "message_version", "sender", "reply_to", "reply_owner", "subject", "html", "text", "stream")
    missing = [key for key in required if not isinstance(manifest.get(key), str) or not manifest[key].strip()]
    if missing:
        raise ValueError(f"Missing campaign inputs: {', '.join(missing)}")
    if manifest["stream"] == "outbound":
        raise ValueError("Campaigns require an explicitly configured Broadcast stream")
    url = urllib.parse.urlparse(manifest["auction_url"])
    if url.scheme != "https" or not url.netloc or not url.path.startswith("/marketplace/auctions/"):
        raise ValueError("auction_url must be a public HTTPS auction detail URL")
    if manifest["auction_url"] not in manifest["html"] or manifest["auction_url"] not in manifest["text"]:
        raise ValueError("The approved HTML and text must both link to this auction")
    links = manifest.get("links")
    if not isinstance(links, list) or not links:
        raise ValueError("Provide the campaign's tracked CTA links")
    keys, urls = set(), set()
    for link in links:
        if not isinstance(link, dict) or not isinstance(link.get("key"), str) or not re.fullmatch(r"[a-z0-9_-]{1,40}", link["key"]):
            raise ValueError("Each CTA requires a stable lowercase key")
        target = link.get("url")
        url = urllib.parse.urlparse(target) if isinstance(target, str) else None
        if not url or url.scheme != "https" or url.hostname not in ("www.rebattery.io", "form.typeform.com"):
            raise ValueError("CTA URLs must use an approved HTTPS destination")
        if link.get("listing_id") is not None and (not isinstance(link["listing_id"], str) or not link["listing_id"].strip()):
            raise ValueError("CTA listing_id must be a nonempty string when provided")
        if link["key"] in keys or target in urls or target not in manifest["html"] or target not in manifest["text"]:
            raise ValueError("CTA keys and URLs must be unique and present in HTML and text")
        keys.add(link["key"])
        urls.add(target)
    if manifest["auction_url"] not in urls:
        raise ValueError("Primary auction URL must be a tracked CTA")
    html_urls = set(re.findall(r'''href=["'](https://[^"']+)''', manifest["html"]))
    text_urls = set(re.findall(r"https://[^\s<>]+", manifest["text"]))
    if html_urls != urls or text_urls != urls:
        raise ValueError("Every HTML and text CTA URL must have exactly one tracking entry")
    if "{{{ pm:unsubscribe }}}" not in manifest["html"] or "{{{ pm:unsubscribe }}}" not in manifest["text"]:
        raise ValueError("Broadcast HTML and text must include Postmark's unsubscribe placeholder")
    if not manifest.get("person_ids") and not manifest.get("cohort_sql"):
        raise ValueError("Provide person_ids or cohort_sql (path to a read-only SELECT returning person_id)")
    if manifest.get("person_ids") and manifest.get("cohort_sql"):
        raise ValueError("Use only one cohort source")
    return manifest


def cohort(db, manifest):
    with db.cursor(cursor_factory=RealDictCursor) as cur:
        if manifest.get("person_ids"):
            ids = manifest["person_ids"]
            if not isinstance(ids, list) or not ids or any(not isinstance(i, str) for i in ids):
                raise ValueError("person_ids must be a nonempty array of CRM person IDs")
            if len(ids) > 500 or len(ids) != len(set(ids)):
                raise ValueError("Cohort must contain at most 500 distinct person IDs")
        else:
            sql = Path(manifest["cohort_sql"]).read_text().strip()
            if not sql.lower().startswith("select ") or ";" in sql:
                raise ValueError("cohort_sql must be one SELECT returning person_id")
            # Read-only transaction is the actual protection, including against writable CTEs/functions.
            cur.execute("set local statement_timeout = '10s'")
            cur.execute(sql)
            if [column.name for column in cur.description] != ["person_id"]:
                raise ValueError("Query must return exactly one column named person_id")
            ids = [row["person_id"] for row in cur.fetchall()]
            if not ids or len(ids) > 500 or len(ids) != len(set(ids)):
                raise ValueError("Cohort must contain 1–500 distinct person IDs")
        cur.execute("""select p.id, p.company_id, p.email, coalesce(p.email_opted_out, false) as opted_out
                       from crm_people p where p.id = any(%s::text[])""", (ids,))
        found = {row["id"]: row for row in cur.fetchall()}
        if len(found) != len(ids):
            raise ValueError(f"Unknown CRM person IDs: {sorted(set(ids) - set(found))}")
        rows = []
        seen = set()
        for person_id in ids:
            row = found[person_id]
            email = (row["email"] or "").strip().lower()
            if not email or "@" not in email or row["opted_out"]:
                raise ValueError(f"Missing email or opted-out CRM person: {person_id}")
            if email in seen:
                raise ValueError(f"Duplicate address in cohort: {email}")
            seen.add(email)
            rows.append({"person_id": person_id, "company_id": row["company_id"], "email": email})
        return sorted(rows, key=lambda row: row["email"])


def digest(manifest, rows):
    contents = {key: manifest[key] for key in ("id", "name", "objective", "success_measure", "listing_id", "auction_url",
        "stock_snapshot_ref", "message_version", "sender", "reply_to", "reply_owner", "subject", "html", "text", "stream")}
    contents["auction_slug"] = manifest.get("auction_slug")
    contents["links"] = manifest["links"]
    # Approval binds identities, not the database's locale-dependent row order.
    contents["cohort"] = sorted(rows, key=lambda row: row["email"])
    contents["track_opens"] = True
    contents["track_links"] = "HtmlAndText"
    return hashlib.sha256(json.dumps(contents, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def frozen_rows(db, campaign_id):
    with db.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""select person_id, company_id, recipient_email as email from crm_campaign_sends
                       where campaign_id = %s order by recipient_email""", (campaign_id,))
        return [dict(row) for row in cur.fetchall()]


def postmark(path, method="GET", payload=None):
    token = os.environ.get("POSTMARK_SERVER_TOKEN")
    if not token:
        raise ValueError("POSTMARK_SERVER_TOKEN is required")
    body = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request("https://api.postmarkapp.com" + path, data=body, method=method,
        headers={"X-Postmark-Server-Token": token, "Accept": "application/json", "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=20) as response:
        return json.load(response)


def provider_preflight(manifest, rows):
    stream = urllib.parse.quote(manifest["stream"], safe="")
    details = postmark("/message-streams/" + stream)
    if details.get("MessageStreamType") != "Broadcasts" or details.get("ArchivedAt"):
        raise ValueError("Selected Postmark stream is not an active Broadcast stream")
    if details.get("SubscriptionManagementConfiguration", {}).get("UnsubscribeHandlingType", "none").lower() == "none":
        raise ValueError("Broadcast stream lacks unsubscribe handling")
    for row in rows:
        path = "/message-streams/" + stream + "/suppressions/dump?" + urllib.parse.urlencode({"EmailAddress": row["email"]})
        suppressed = postmark(path).get("Suppressions", [])
        if any(item.get("EmailAddress", "").lower() == row["email"] for item in suppressed):
            raise ValueError(f"Recipient is suppressed in Postmark: {row['email']}")


def preview(manifest):
    with connection(read_only=True) as db:
        rows = cohort(db, manifest)
        listing_ids = sorted({link["listing_id"] for link in manifest["links"] if link.get("listing_id")})
        with db.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""select s.person_id, l.listing_id, count(distinct s.id)::int as prior_pitches
                           from crm_campaign_sends s join crm_campaign_send_links l on l.send_id=s.id
                           where l.listing_id = any(%s::text[]) and s.state in ('accepted', 'sending', 'unknown')
                             and s.person_id = any(%s::text[])
                           group by s.person_id, l.listing_id""",
                        (listing_ids, [r["person_id"] for r in rows]))
            counts = {}
            for pitch in cur.fetchall():
                counts.setdefault(pitch["person_id"], {})[pitch["listing_id"]] = pitch["prior_pitches"]
    return rows, counts


def freeze(manifest, rows, sha):
    with connection() as db, db.cursor() as cur:
        cur.execute("select 1 from campaigns where id = %s", (manifest["id"],))
        if cur.fetchone():
            raise ValueError("Campaign already exists; frozen cohorts cannot be replaced")
        cur.execute("""insert into campaigns (id, campaign_name, auction_slug, type, channel, status,
                       source_system, audience, audience_size, objective, success_measure,
                       stock_snapshot_ref, message_version, sender_identity, reply_owner, reply_mailbox, notes,
                       emails_opened, emails_clicked)
                       values (%s,%s,%s,'supply_update','email-postmark','frozen','dench-campaign',%s,%s,
                               %s,%s,%s,%s,%s,%s,%s,%s,null,null)""",
                    (manifest["id"], manifest["name"], manifest.get("auction_slug"),
                     f"Frozen {len(rows)} recipients; SHA256 {sha}", len(rows), manifest["objective"],
                     manifest["success_measure"], manifest["stock_snapshot_ref"], manifest["message_version"],
                     manifest["sender"], manifest["reply_owner"], manifest["reply_to"], "Internal pilot"))
        for row in rows:
            send_id = hashlib.sha256(f"{manifest['id']}\0{row['person_id']}".encode()).hexdigest()[:32]
            cur.execute("""insert into crm_campaign_sends
                           (id, campaign_id, person_id, company_id, listing_id, auction_url, recipient_email)
                           values (%s,%s,%s,%s,%s,%s,%s)""",
                         (send_id, manifest["id"], row["person_id"], row["company_id"],
                          manifest["listing_id"], manifest["auction_url"], row["email"]))
            for link in manifest["links"]:
                link_id = hashlib.sha256(f"{send_id}\0{link['key']}".encode()).hexdigest()[:32]
                cur.execute("""insert into crm_campaign_send_links
                               (id, send_id, cta_key, destination_url, listing_id)
                               values (%s,%s,%s,%s,%s)""",
                            (link_id, send_id, link["key"], link["url"], link.get("listing_id")))
    return sha


def approve(campaign_id, sha, approver):
    with connection() as db, db.cursor() as cur:
        cur.execute("""update campaigns set approved_manifest_sha256=%s, approved_by=%s,
                       approved_at=now() where id=%s and status='frozen' and approved_at is null
                       and audience like %s""", (sha, approver, campaign_id, f"%SHA256 {sha}"))
        if cur.rowcount != 1:
            raise ValueError("Campaign not frozen with this digest, or already approved")


def launch(manifest, sha):
    if os.environ.get("DENCH_CAMPAIGN_LIVE_SEND") != "1":
        raise ValueError("DENCH_CAMPAIGN_LIVE_SEND=1 required for a real send")
    with connection(read_only=True) as db:
        rows = frozen_rows(db, manifest["id"])
        if not rows or digest(manifest, rows) != sha:
            raise ValueError("Frozen cohort or creative differs from approved manifest")
        with db.cursor() as cur:
            cur.execute("""select 1 from campaigns where id=%s and approved_manifest_sha256=%s
                           and approved_at is not null and status in ('frozen','sending')""", (manifest["id"], sha))
            if not cur.fetchone():
                raise ValueError("Exact manifest has not been approved")
    provider_preflight(manifest, rows)
    results = []
    for row in rows:
        with connection() as db, db.cursor() as cur:
            cur.execute("""update crm_campaign_sends s set state='sending', claimed_at=now()
                           from crm_people p where s.campaign_id=%s and s.person_id=%s
                             and p.id=s.person_id and lower(p.email)=s.recipient_email
                             and not coalesce(p.email_opted_out,false) and s.state='frozen'
                           returning s.id""", (manifest["id"], row["person_id"]))
            claimed = cur.fetchone()
            if not claimed:
                results.append((row["person_id"], "skipped: already claimed or suppressed"))
                continue
            send_id = claimed[0]
        payload = {"From": manifest["sender"], "ReplyTo": manifest["reply_to"], "To": row["email"],
                   "Subject": manifest["subject"], "HtmlBody": manifest["html"], "TextBody": manifest["text"],
                   "Tag": manifest["id"], "MessageStream": manifest["stream"], "TrackOpens": True,
                   "TrackLinks": "HtmlAndText", "Metadata": {"campaign_id": manifest["id"],
                   "recipient_id": send_id}}
        try:
            response = postmark("/email", "POST", payload)
        except urllib.error.HTTPError as exc:
            # A 4xx response is a definite rejection; a 5xx may follow provider acceptance.
            with connection() as db, db.cursor() as cur:
                cur.execute("update crm_campaign_sends set state=%s where id=%s and state='sending'",
                            ("failed" if 400 <= exc.code < 500 else "unknown", send_id))
            results.append((row["person_id"], f"provider HTTP {exc.code}; launch stopped"))
            break
        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            # The provider may have accepted it. Reconcile before any manual retry.
            with connection() as db, db.cursor() as cur:
                cur.execute("update crm_campaign_sends set state='unknown' where id=%s and state='sending'", (send_id,))
            results.append((row["person_id"], f"unknown: {type(exc).__name__}"))
            break
        with connection() as db, db.cursor() as cur:
            ok = response.get("ErrorCode") == 0 and response.get("MessageID")
            cur.execute("""update crm_campaign_sends set state=%s, provider_message_id=%s,
                           accepted_at=case when %s then now() else null end where id=%s""",
                        ("accepted" if ok else "failed", response.get("MessageID") if ok else None,
                         bool(ok), send_id))
            cur.execute("update campaigns set status='sending', launched_at=coalesce(launched_at,now()) where id=%s",
                        (manifest["id"],))
        results.append((row["person_id"], "accepted" if ok else "failed"))
    return results


def observed_clicks(events, links):
    """Attribute each provider event only to a frozen destination for this send."""
    destinations = {link["destination_url"]: link["cta_key"] for link in links}
    clicks = {}
    for event in events:
        key = destinations.get(event.get("Details", {}).get("Link"))
        if event.get("Type") == "LinkClicked" and event.get("ReceivedAt") and key:
            clicks[key] = min(clicks.get(key, event["ReceivedAt"]), event["ReceivedAt"])
    return clicks


def sync(campaign_id, apply):
    with connection(read_only=True) as db, db.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""select id, provider_message_id from crm_campaign_sends where campaign_id=%s
                       and provider_message_id is not null""", (campaign_id,))
        sends = cur.fetchall()
        cur.execute("""select l.send_id, l.cta_key, l.destination_url from crm_campaign_send_links l
                       join crm_campaign_sends s on s.id=l.send_id where s.campaign_id=%s""", (campaign_id,))
        links_by_send = {}
        for link in cur.fetchall():
            links_by_send.setdefault(link["send_id"], []).append(link)
    results = []
    for send in sends:
        details = postmark("/messages/outbound/" + urllib.parse.quote(send["provider_message_id"]) + "/details")
        events = details.get("MessageEvents", [])
        def first(kind):
            return min((event["ReceivedAt"] for event in events
                        if event.get("Type") == kind and event.get("ReceivedAt")), default=None)
        clicks = observed_clicks(events, links_by_send.get(send["id"], []))
        clicked = min(clicks.values(), default=None)
        status = {"delivered": first("Delivered"), "bounced": first("Bounced"),
                  "opened": first("Opened"), "clicked": clicked, "cta_clicks": clicks}
        results.append({"message_id": send["provider_message_id"], **status})
        if apply:
            with connection() as db, db.cursor() as cur:
                cur.execute("""update crm_campaign_sends set delivered_at=coalesce(delivered_at,%s),
                               bounced_at=coalesce(bounced_at,%s), provider_opened_at=coalesce(provider_opened_at,%s),
                               provider_link_clicked_at=coalesce(provider_link_clicked_at,%s), last_synced_at=now()
                               where id=%s""", (status["delivered"], status["bounced"], status["opened"],
                                                status["clicked"], send["id"]))
                for key, clicked_at in clicks.items():
                    cur.execute("""update crm_campaign_send_links set first_clicked_at=coalesce(first_clicked_at,%s)
                                   where send_id=%s and cta_key=%s""", (clicked_at, send["id"], key))
    return results


def recover(manifest, apply):
    """Resolve uncertain claims by exact metadata; never mark a missing receipt safe to resend."""
    with connection(read_only=True) as db, db.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""select id, person_id, recipient_email from crm_campaign_sends
                       where campaign_id=%s and state in ('sending','unknown')""", (manifest["id"],))
        uncertain = cur.fetchall()
    results = []
    for row in uncertain:
        params = urllib.parse.urlencode({"count": 10, "offset": 0, "messagestream": manifest["stream"],
                                         "metadata_recipient_id": row["id"]})
        found = postmark("/messages/outbound?" + params).get("Messages", [])
        matches = [message for message in found if message.get("MessageID") and
                   message.get("Metadata", {}).get("recipient_id") == row["id"] and
                   row["recipient_email"] in message.get("Recipients", [])]
        if len(matches) != 1:
            results.append({"person_id": row["person_id"], "state": "unresolved", "matches": len(matches)})
            continue
        message = matches[0]
        results.append({"person_id": row["person_id"], "state": "found", "message_id": message["MessageID"]})
        if apply:
            with connection() as db, db.cursor() as cur:
                cur.execute("""update crm_campaign_sends set state='accepted', provider_message_id=%s,
                               accepted_at=coalesce(accepted_at,%s::timestamptz)
                               where id=%s and state in ('sending','unknown')""",
                            (message["MessageID"], message.get("ReceivedAt"), row["id"]))
    return results


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    for name in ("preview", "freeze", "launch", "recover"):
        sub = commands.add_parser(name)
        sub.add_argument("--manifest", required=True, help="JSON campaign brief and cohort source")
        if name != "preview":
            sub.add_argument("--apply", action="store_true")
        if name == "launch":
            sub.add_argument("--approved-sha256", required=True)
    sub = commands.add_parser("approve")
    sub.add_argument("--campaign-id", required=True)
    sub.add_argument("--sha256", required=True)
    sub.add_argument("--approved-by", required=True)
    sub.add_argument("--apply", action="store_true")
    sub = commands.add_parser("sync")
    sub.add_argument("--campaign-id", required=True)
    sub.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        if args.command in ("preview", "freeze", "launch", "recover"):
            manifest = load_manifest(args.manifest)
            if args.command == "launch":
                if not args.apply:
                    raise ValueError("launch requires --apply and separately approved send")
                output = launch(manifest, args.approved_sha256)
            elif args.command == "recover":
                output = recover(manifest, args.apply)
            else:
                rows, counts = preview(manifest)
                sha = digest(manifest, rows)
                output = {"sha256": sha, "cohort": [{**row, "prior_pitches_by_listing": counts.get(row["person_id"], {})} for row in rows]}
                if args.command == "freeze" and args.apply:
                    freeze(manifest, rows, sha)
                elif args.command == "freeze":
                    output["dry_run"] = True
        elif args.command == "approve":
            if args.apply:
                approve(args.campaign_id, args.sha256, args.approved_by)
            output = {"campaign_id": args.campaign_id, "sha256": args.sha256, "dry_run": not args.apply}
        else:
            output = sync(args.campaign_id, args.apply)
        print(json.dumps(output, indent=2, default=str))
    except (ValueError, psycopg2.Error, urllib.error.URLError) as exc:
        print(f"Campaign stopped: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
