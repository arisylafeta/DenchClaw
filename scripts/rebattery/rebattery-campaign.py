#!/usr/bin/env python3
"""Freeze CRM cohorts, send approved Postmark campaigns, and reconcile receipts.

All mutations require --apply. Launch additionally requires an approved manifest
digest and DENCH_CAMPAIGN_LIVE_SEND=1. Never retry an ambiguous send automatically.
"""

from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

import psycopg2
from psycopg2.extras import RealDictCursor


SUPPLY_UPDATE_LIST = "Supply update"
PERSONALIZATION_COLUMNS = {"first_name", "last_name", "opening"}
VARIABLE = re.compile(r"(?<!\{)\{\{([a-z][a-z0-9_]*)\}\}(?!\})")

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
    personalization = manifest.get("personalization", {})
    if not isinstance(personalization, dict) or any(
        not re.fullmatch(r"[a-z][a-z0-9_]*", variable)
        or column not in PERSONALIZATION_COLUMNS
        for variable, column in personalization.items()
    ):
        raise ValueError("Personalization must map variable names to approved CRM person columns")
    if not manifest.get("person_ids") and not manifest.get("cohort_sql"):
        raise ValueError("Provide person_ids or cohort_sql (path to a read-only SELECT returning person_id)")
    if manifest.get("person_ids") and manifest.get("cohort_sql"):
        raise ValueError("Use only one cohort source")
    return manifest


def cohort(db, manifest, suppressions):
    personalization = manifest.get("personalization", {})
    columns = ["p.id", "p.company_id", "p.email", "coalesce(p.email_opted_out, false) as opted_out"]
    columns.extend(f'p."{column}"' for column in sorted(set(personalization.values())))
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
            cur.execute("set local statement_timeout = '10s'")
            cur.execute(sql)
            if [column.name for column in cur.description] != ["person_id"]:
                raise ValueError("Query must return exactly one column named person_id")
            ids = [row["person_id"] for row in cur.fetchall()]
            if not ids or len(ids) > 500 or len(ids) != len(set(ids)):
                raise ValueError("Cohort must contain 1–500 distinct person IDs")
        cur.execute(f"""select {', '.join(columns)},
                              exists (select 1 from crm_subscriptions s where s.person_id=p.id
                                      and s.list=%s and s.status='Opted out') as list_opted_out
                       from crm_people p where p.id = any(%s::text[])""", (SUPPLY_UPDATE_LIST, ids))
        found = {row["id"]: row for row in cur.fetchall()}
        if len(found) != len(ids):
            raise ValueError(f"Unknown CRM person IDs: {sorted(set(ids) - set(found))}")
        rows = []
        exclusions = []
        seen = set()
        for person_id in ids:
            row = found[person_id]
            email = (row["email"] or "").strip().lower()
            suppression = suppressions.get(email)
            if row["list_opted_out"] or suppression:
                exclusions.append({"person_id": person_id, "email": email,
                                   "list_opted_out": row["list_opted_out"],
                                   "provider_reason": suppression["SuppressionReason"] if suppression else None})
                continue
            if not email or "@" not in email or row["opted_out"]:
                raise ValueError(f"Missing email or opted-out CRM person: {person_id}")
            if email in seen:
                raise ValueError(f"Duplicate address in cohort: {email}")
            seen.add(email)
            template_vars = dict(manifest.get("campaign_variables", {}))
            template_vars.update({name: row[column] for name, column in personalization.items()})
            if any(value is None or not str(value).strip() for name, value in template_vars.items() if name in personalization):
                raise ValueError(f"Missing required personalization for CRM person: {person_id}")
            rows.append({
                "person_id": person_id,
                "company_id": row["company_id"],
                "email": email,
                "personalization": {name: row[column] for name, column in personalization.items()},
                "subject": render_template(manifest["subject"], template_vars),
                "html": render_template(manifest["html"], template_vars, html_mode=True),
                "text": render_template(manifest["text"], template_vars),
            })
        if not rows:
            raise ValueError("No eligible recipients remain after suppression exclusions")
        return sorted(rows, key=lambda row: row["email"]), exclusions


def render_template(template, variables, html_mode=False):
    def replace(match):
        name = match.group(1)
        if name not in variables:
            raise ValueError(f"Template variable has no CRM source: {name}")
        value = str(variables[name])
        return html.escape(value, quote=True) if html_mode else value
    rendered = VARIABLE.sub(replace, template)
    if VARIABLE.search(rendered):
        raise ValueError("Unresolved template variable")
    return rendered


def digest(manifest, rows):
    contents = {key: manifest[key] for key in ("id", "name", "objective", "success_measure", "listing_id", "auction_url",
        "stock_snapshot_ref", "message_version", "sender", "reply_to", "reply_owner", "subject", "html", "text", "stream")}
    contents["auction_slug"] = manifest.get("auction_slug")
    contents["links"] = manifest["links"]
    # Approval binds identities, not the database's locale-dependent row order.
    contents["personalization"] = manifest.get("personalization", {})
    contents["campaign_variables"] = manifest.get("campaign_variables", {})
    contents["cohort"] = sorted(rows, key=lambda row: row["email"])
    contents["track_opens"] = True
    contents["track_links"] = "HtmlAndText"
    return hashlib.sha256(json.dumps(contents, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def frozen_rows(db, campaign_id):
    with db.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("""select person_id, company_id, recipient_email as email, personalization,
                              rendered_subject as subject, rendered_html as html, rendered_text as text
                         from crm_campaign_sends where campaign_id = %s order by recipient_email""", (campaign_id,))
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


def stream_suppressions(stream):
    """Read the unfiltered dump: Postmark's dump endpoint is not paginated."""
    if not isinstance(stream, str) or not stream.strip() or stream == "outbound":
        raise ValueError("An explicit Broadcast stream is required")
    path = "/message-streams/" + urllib.parse.quote(stream, safe="")
    details = postmark(path)
    if details.get("MessageStreamType") != "Broadcasts" or details.get("ArchivedAt"):
        raise ValueError("Selected Postmark stream is not an active Broadcast stream")
    if details.get("SubscriptionManagementConfiguration", {}).get("UnsubscribeHandlingType", "none").lower() == "none":
        raise ValueError("Broadcast stream lacks unsubscribe handling")
    dump = postmark(path + "/suppressions/dump")
    if not isinstance(dump, dict) or not isinstance(dump.get("Suppressions"), list):
        raise ValueError("Incomplete Postmark suppression dump")
    suppressions = {}
    for item in dump["Suppressions"]:
        if not isinstance(item, dict) or any(
            not isinstance(item.get(key), str) or not item[key].strip()
            for key in ("EmailAddress", "SuppressionReason", "Origin", "CreatedAt")
        ):
            raise ValueError("Incomplete Postmark suppression record")
        email = item["EmailAddress"].strip().lower()
        if "@" not in email or email in suppressions:
            raise ValueError("Invalid or duplicate address in Postmark suppression dump")
        try:
            since = datetime.fromisoformat(item["CreatedAt"].replace("Z", "+00:00")).date()
        except ValueError as exc:
            raise ValueError("Invalid Postmark suppression date") from exc
        suppressions[email] = {**item, "since": since}
    return suppressions


def provider_preflight(manifest, rows):
    suppressions = stream_suppressions(manifest["stream"])
    for row in rows:
        if row["email"] in suppressions:
            raise ValueError(f"Recipient is suppressed in Postmark: {row['email']}")


def sync_suppressions(stream, suppressions, apply):
    """Only opt out. Absence from the dump never restores subscription or consent."""
    results = []
    with connection(read_only=not apply) as db, db.cursor(cursor_factory=RealDictCursor) as cur:
        cur.execute("select id, lower(trim(email)) as email from crm_people where lower(trim(email)) = any(%s::text[])",
                    (list(suppressions),))
        people = {}
        for person in cur.fetchall():
            people.setdefault(person["email"], []).append(person["id"])
        for email, item in sorted(suppressions.items()):
            person_ids = sorted(people.get(email, []))
            global_opt_out = item["SuppressionReason"] in ("SpamComplaint", "HardBounce")
            how = f"Postmark stream={stream}; reason={item['SuppressionReason']}; origin={item['Origin']}"
            results.append({"email": email, "person_ids": person_ids, "reason": item["SuppressionReason"],
                            "origin": item["Origin"], "since": item["since"],
                            "global_opt_out": global_opt_out, "matched": bool(person_ids)})
            if not apply:
                continue
            for person_id in person_ids:
                cur.execute("""insert into crm_subscriptions (person_id, list, status, since, how)
                               values (%s,%s,'Opted out',%s,%s)
                               on conflict (person_id, list) do update
                               set status='Opted out', since=excluded.since, how=excluded.how, updated_at=now()
                               where (crm_subscriptions.status, crm_subscriptions.since, crm_subscriptions.how)
                                     is distinct from (excluded.status, excluded.since, excluded.how)""",
                            (person_id, SUPPLY_UPDATE_LIST, item["since"], how))
                if global_opt_out:
                    cur.execute("""update crm_people set email_opted_out=true, updated_at=now()
                                   where id=%s and not coalesce(email_opted_out,false)""", (person_id,))
    return results


def preview(manifest):
    suppressions = stream_suppressions(manifest["stream"])
    with connection(read_only=True) as db:
        rows, exclusions = cohort(db, manifest, suppressions)
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
    return rows, counts, exclusions


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
                           (id, campaign_id, person_id, company_id, listing_id, auction_url, recipient_email,
                            personalization, rendered_subject, rendered_html, rendered_text)
                           values (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,%s,%s)""",
                        (send_id, manifest["id"], row["person_id"], row["company_id"],
                         manifest["listing_id"], manifest["auction_url"], row["email"],
                         json.dumps(row.get("personalization", {})), row["subject"], row["html"], row["text"]))
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


def launch(manifest, sha, max_recipients):
    if os.environ.get("DENCH_CAMPAIGN_LIVE_SEND") != "1":
        raise ValueError("DENCH_CAMPAIGN_LIVE_SEND=1 required for a real send")
    if max_recipients < 1:
        raise ValueError("--max-recipients must be at least one")
    with connection(read_only=True) as db:
        all_rows = frozen_rows(db, manifest["id"])
        if not all_rows or digest(manifest, all_rows) != sha:
            raise ValueError("Frozen cohort or creative differs from approved manifest")
        with db.cursor() as cur:
            cur.execute("""select 1 from campaigns where id=%s and approved_manifest_sha256=%s
                           and approved_at is not null and status in ('frozen','sending')""", (manifest["id"], sha))
            if not cur.fetchone():
                raise ValueError("Exact manifest has not been approved")
        with db.cursor(cursor_factory=RealDictCursor) as cur:
            cur.execute("""select person_id, company_id, recipient_email as email, personalization,
                                  rendered_subject as subject, rendered_html as html, rendered_text as text
                             from crm_campaign_sends
                            where campaign_id=%s and state='frozen'
                            order by recipient_email limit %s""", (manifest["id"], max_recipients))
            rows = [dict(row) for row in cur.fetchall()]
            cur.execute("""select count(*) as uncertain from crm_campaign_sends
                            where campaign_id=%s and state in ('sending','unknown')""", (manifest["id"],))
            if cur.fetchone()["uncertain"]:
                raise ValueError("Campaign has sending/unknown receipts; recover them before launch")
    if not rows:
        raise ValueError("No frozen recipients remain to send")
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
                   "Subject": row["subject"], "HtmlBody": row["html"], "TextBody": row["text"],
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


def sync(campaign_id, apply, stream):
    suppressions = stream_suppressions(stream)
    suppression_results = sync_suppressions(stream, suppressions, apply)
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
    return {"receipts": results, "suppressions": suppression_results, "stream": stream,
            "list": SUPPLY_UPDATE_LIST, "dry_run": not apply}


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
            sub.add_argument("--max-recipients", required=True, type=int,
                             help="Hard cap for this launch invocation; recipient sends are never implicit")
    sub = commands.add_parser("approve")
    sub.add_argument("--campaign-id", required=True)
    sub.add_argument("--sha256", required=True)
    sub.add_argument("--approved-by", required=True)
    sub.add_argument("--apply", action="store_true")
    for name in ("sync", "sync-suppressions"):
        sub = commands.add_parser(name)
        if name == "sync":
            sub.add_argument("--campaign-id", required=True)
        sub.add_argument("--stream", required=True, help="Explicit Broadcast stream mapped to the Supply update list")
        sub.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    try:
        if args.command in ("preview", "freeze", "launch", "recover"):
            manifest = load_manifest(args.manifest)
            if args.command == "launch":
                if not args.apply:
                    raise ValueError("launch requires --apply and separately approved send")
                output = launch(manifest, args.approved_sha256, args.max_recipients)
            elif args.command == "recover":
                output = recover(manifest, args.apply)
            else:
                rows, counts, exclusions = preview(manifest)
                sha = digest(manifest, rows)
                output = {"sha256": sha, "cohort": [{**row, "prior_pitches_by_listing": counts.get(row["person_id"], {})} for row in rows],
                          "exclusions": exclusions}
                if args.command == "freeze" and args.apply:
                    freeze(manifest, rows, sha)
                elif args.command == "freeze":
                    output["dry_run"] = True
        elif args.command == "approve":
            if args.apply:
                approve(args.campaign_id, args.sha256, args.approved_by)
            output = {"campaign_id": args.campaign_id, "sha256": args.sha256, "dry_run": not args.apply}
        elif args.command == "sync-suppressions":
            suppressions = stream_suppressions(args.stream)
            output = {"suppressions": sync_suppressions(args.stream, suppressions, args.apply),
                      "stream": args.stream, "list": SUPPLY_UPDATE_LIST, "dry_run": not args.apply}
        else:
            output = sync(args.campaign_id, args.apply, args.stream)
        print(json.dumps(output, indent=2, default=str))
    except (ValueError, psycopg2.Error, urllib.error.URLError) as exc:
        print(f"Campaign stopped: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
