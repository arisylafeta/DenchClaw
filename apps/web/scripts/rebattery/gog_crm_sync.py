#!/usr/bin/env python3
"""
Gog CRM Email Sync

Syncs emails from both Gmail accounts (ari + alex) into Postgres CRM.
Only imports emails where:
  1. The email has 'CRM' label in Gmail, OR
  2. At least one counterparty (from/to/cc, excluding account owner) is in CRM people

Writes directly to Postgres crm_* tables.

Usage:
    python3 gog_crm_sync.py [--dry-run] [--account ari@rebattery.io]
"""

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from datetime import datetime, timedelta, timezone
from email.utils import parseaddr, parsedate_to_datetime
from pathlib import Path

import psycopg2

# --- Config ---
GOG_BIN = "/usr/local/bin/gog"
KEYRING_PASSWORD_PATH = "/root/.hermes/workspace/.secrets/gog-keyring-password"
ACCOUNTS = ["ari@rebattery.io", "alex@rebattery.io"]
DB_NAME = "denchclaw"
SEARCH_BATCH_SIZE = 8  # emails per Gmail search query (from + to = 16 clauses)
MAX_RESULTS_PER_SEARCH = 100
RATE_LIMIT_DELAY = 0.1  # seconds between gog calls
COMMIT_EVERY = 25  # commit after this many messages


# ---------------------------------------------------------------------------
# gog CLI wrapper
# ---------------------------------------------------------------------------

def gog(account, *args, timeout=120):
    """Run gog command, return parsed JSON output."""
    password = Path(KEYRING_PASSWORD_PATH).read_text().strip()
    env = os.environ.copy()
    env["GOG_KEYRING_PASSWORD"] = password
    env["HOME"] = "/root"
    cmd = [GOG_BIN, "--account", account] + list(args) + ["--json", "--no-input"]
    result = subprocess.run(cmd, env=env, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise RuntimeError(
            f"gog failed ({result.returncode}): {result.stderr[:500]}"
        )
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        return {"raw": result.stdout}


# ---------------------------------------------------------------------------
# Email parsing helpers
# ---------------------------------------------------------------------------

def normalize_email(email):
    """Normalize: lowercase, strip plus tags."""
    if not email:
        return None
    email = email.strip().lower()
    if "@" not in email:
        return None
    local, domain = email.rsplit("@", 1)
    if "+" in local:
        local = local[: local.index("+")]
    if not local or not domain:
        return None
    return f"{local}@{domain}"


def parse_email_addresses(header_value):
    """Parse a From/To/Cc header into list of (name, email) tuples."""
    if not header_value:
        return []
    results = []
    # Split by comma, handle quoted names with commas
    parts = re.split(r',\s*(?=(?:[^"]*"[^"]*")*[^"]*$)', header_value)
    for part in parts:
        name, email = parseaddr(part.strip())
        if email:
            results.append((name.strip() if name else "", email.strip().lower()))
    return results


def parse_date(date_str):
    """Parse email date header to ISO format."""
    if not date_str:
        return None
    try:
        dt = parsedate_to_datetime(date_str)
        return dt.isoformat() if dt else None
    except Exception:
        return None


def make_body_preview(body):
    """Create a plain-text preview from body text."""
    if not body:
        return ""
    # Strip HTML tags if present
    text = re.sub(r"<[^>]+>", " ", body)
    # Collapse whitespace
    text = re.sub(r"\s+", " ", text).strip()
    return text[:500]


# ---------------------------------------------------------------------------
# CRM data loading
# ---------------------------------------------------------------------------

def get_crm_people(conn):
    """Load CRM people emails into a dict {normalized_email: person_id}."""
    with conn.cursor() as cur:
        cur.execute(
            """
            SELECT id, lower(email) as email
            FROM crm_people
            WHERE email IS NOT NULL AND email != ''
            """
        )
        return {row[1]: row[0] for row in cur.fetchall() if row[1]}


def get_person_company_map(conn):
    """Load {person_id: company_id} for all people with companies."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id, company_id FROM crm_people WHERE company_id IS NOT NULL"
        )
        return {row[0]: row[1] for row in cur.fetchall()}


def get_existing_message_ids(conn):
    """Load imported Gmail message IDs, scoped to their owning mailbox."""
    with conn.cursor() as cur:
        cur.execute(
            """SELECT u.email, m.gmail_message_id
                 FROM crm_email_messages m
                 JOIN crm_users u ON u.id = m.mailbox_owner_id
                WHERE m.gmail_message_id IS NOT NULL"""
        )
        return {(row[0].lower(), row[1]) for row in cur.fetchall()}


def get_mailbox_owner_id(conn, account):
    """Resolve a configured mailbox to exactly one active CRM identity."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT id FROM crm_users WHERE lower(email) = lower(%s) AND is_active",
            (account,),
        )
        rows = cur.fetchall()
    if len(rows) != 1:
        raise RuntimeError(f"No unique active crm_users identity for configured account: {account}")
    return rows[0][0]


def get_owner_emails():
    """Account owner emails to exclude from counterparty matching."""
    return {normalize_email(e) for e in ACCOUNTS}


COMMON_EMAIL_PROVIDERS = {
    "gmail", "yahoo", "outlook", "hotmail", "icloud", "proton", "aol", "live", "msn"
}


def is_common_email_provider(domain):
    """Return True if domain is a public/common email provider."""
    if not domain:
        return True
    return domain.lower() in COMMON_EMAIL_PROVIDERS


def upsert_company_by_domain(cur, domain):
    """
    Upsert a company by domain. Returns company id.
    Uses SELECT-then-INSERT/UPDATE because the live DB does not have a
    unique constraint on lower(domain) (some domains have duplicate rows).
    """
    domain = (domain or "").lower().strip()
    if not domain:
        return None

    # Update an existing row for this domain if one exists.
    cur.execute(
        "SELECT id FROM crm_companies WHERE lower(domain) = %s LIMIT 1",
        (domain,),
    )
    row = cur.fetchone()
    display_name = domain[0].upper() + domain[1:] if domain else domain
    if row:
        existing_id = row[0]
        cur.execute(
            """
            UPDATE crm_companies
            SET name = %s,
                domain = %s,
                updated_at = now()
            WHERE id = %s
            """,
            (display_name, domain, existing_id),
        )
        return existing_id

    company_id = "company_domain_" + hashlib.md5(str(domain).encode()).hexdigest()[:16]
    cur.execute(
        """
        INSERT INTO crm_companies (id, name, domain, tags)
        VALUES (%s, %s, %s, ARRAY['auto-created'])
        """,
        (company_id, display_name, domain),
    )
    return company_id


def upsert_person_by_email(cur, name, email, company_id):
    """
    Upsert a person by email. Returns person id.
    Uses SELECT-then-INSERT/UPDATE because the live DB does not have a
    unique constraint on lower(email) (emails are currently unique in
    practice, but the index is not marked unique).
    """
    email = normalize_email(email)
    if not email:
        raise ValueError("email is required for upsert_person_by_email")
    person_id = "person_email_" + hashlib.md5(email.encode()).hexdigest()[:16]
    name = (name or "").strip()
    parts = name.split(None, 1) if name else []
    full_name = name if name else None
    first_name = parts[0] if parts else None
    last_name = parts[1] if len(parts) > 1 else None

    cur.execute(
        "SELECT id FROM crm_people WHERE lower(email) = %s LIMIT 1",
        (email,),
    )
    row = cur.fetchone()
    if row:
        existing_id = row[0]
        cur.execute(
            """
            UPDATE crm_people
            SET full_name = COALESCE(NULLIF(%s, ''), full_name),
                first_name = COALESCE(%s, first_name),
                last_name = COALESCE(%s, last_name),
                company_id = COALESCE(%s, company_id),
                updated_at = now()
            WHERE id = %s
            """,
            (full_name or "", first_name, last_name, company_id, existing_id),
        )
        return existing_id

    cur.execute(
        """
        INSERT INTO crm_people
            (id, full_name, first_name, last_name, email, company_id, tags)
        VALUES (%s, %s, %s, %s, %s, %s, ARRAY['auto-created'])
        """,
        (person_id, full_name, first_name, last_name, email, company_id),
    )
    return person_id


def ensure_person(cur, name, email, crm_people, owner_emails, person_company_map, stats):
    """
    Ensure a person exists in crm_people for the given email/name.
    Auto-creates company and person if missing and not an owner email.
    Returns (person_id, created).
    """
    normalized = normalize_email(email)
    if not normalized:
        return None, False
    if normalized in owner_emails:
        return None, False
    if normalized in crm_people:
        return crm_people[normalized], False

    domain = normalized.split("@", 1)[1]
    company_id = None
    if not is_common_email_provider(domain):
        company_id = upsert_company_by_domain(cur, domain)

    person_id = upsert_person_by_email(cur, name, normalized, company_id)
    crm_people[normalized] = person_id
    person_company_map[person_id] = company_id
    stats["auto_created"] += 1
    return person_id, True


# ---------------------------------------------------------------------------
# Sync state
# ---------------------------------------------------------------------------


def init_sync_state(conn):
    """Create the sync state table if it does not exist."""
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS crm_sync_state (
                account text primary key,
                last_sync_at timestamptz,
                last_sync_status text,
                updated_at timestamptz not null default now()
            )
            """
        )
    conn.commit()


def get_last_sync_at(conn, account):
    """Load the last successful sync timestamp for an account."""
    with conn.cursor() as cur:
        cur.execute(
            "SELECT last_sync_at FROM crm_sync_state WHERE account = %s",
            (account,),
        )
        row = cur.fetchone()
        return row[0] if row else None


def set_sync_state(conn, account, status):
    """Upsert sync state for an account."""
    with conn.cursor() as cur:
        cur.execute(
            """
            INSERT INTO crm_sync_state (account, last_sync_at, last_sync_status, updated_at)
            VALUES (%s, now(), %s, now())
            ON CONFLICT (account) DO UPDATE
            SET last_sync_at = EXCLUDED.last_sync_at,
                last_sync_status = EXCLUDED.last_sync_status,
                updated_at = now()
            """,
            (account, status),
        )
    conn.commit()


# ---------------------------------------------------------------------------
# Gmail search
# ---------------------------------------------------------------------------

def build_search_query(base_query, after_date=None):
    """Scope a Gmail query while authoritatively excluding draft messages."""
    query = f"({base_query}) -label:DRAFT"
    if after_date:
        query += f" after:{after_date}"
    return query


def is_draft_message(raw_message):
    """Return True when Gmail marks a fetched message as a draft."""
    labels = raw_message.get("labelIds", []) if isinstance(raw_message, dict) else []
    return any(str(label).upper() == "DRAFT" for label in labels)


def search_label_crm(account, after_date=None):
    """Search for non-draft messages with CRM label, optionally after a date."""
    query = build_search_query("label:CRM", after_date)
    print(f"  [{account}] Searching {query}...")
    try:
        result = gog(account, "gmail", "messages", "search", query, "--max", "500")
        messages = (
            result if isinstance(result, list) else result.get("messages", [])
        )
        print(f"    Found {len(messages)} messages with CRM label")
        return messages
    except Exception as e:
        print(f"    Warning: CRM label search failed: {e}", file=sys.stderr)
        return []


def search_by_crm_people(account, crm_emails, owner_emails, after_date=None):
    """Search for messages where CRM people are from/to, in batches."""
    search_emails = sorted(crm_emails - owner_emails)
    if not search_emails:
        print(f"  [{account}] No CRM emails to search for (excluding owners)")
        return []

    total_batches = (len(search_emails) - 1) // SEARCH_BATCH_SIZE + 1
    print(
        f"  [{account}] Searching {len(search_emails)} CRM emails "
        f"in {total_batches} batches..."
    )

    all_messages = []
    seen_ids = set()

    for i in range(0, len(search_emails), SEARCH_BATCH_SIZE):
        batch = search_emails[i : i + SEARCH_BATCH_SIZE]
        clauses = []
        for email in batch:
            clauses.append(f"from:{email}")
            clauses.append(f"to:{email}")
        query = build_search_query(" OR ".join(clauses), after_date)

        batch_num = i // SEARCH_BATCH_SIZE + 1
        try:
            result = gog(
                account,
                "gmail",
                "messages",
                "search",
                query,
                "--max",
                str(MAX_RESULTS_PER_SEARCH),
            )
            messages = (
                result if isinstance(result, list) else result.get("messages", [])
            )
            new_count = 0
            for msg in messages:
                msg_id = msg.get("id")
                if msg_id and msg_id not in seen_ids:
                    seen_ids.add(msg_id)
                    all_messages.append(msg)
                    new_count += 1
            print(
                f"    Batch {batch_num}/{total_batches}: "
                f"{len(messages)} results, {new_count} new "
                f"(total unique: {len(all_messages)})"
            )
        except Exception as e:
            print(
                f"    Warning: batch {batch_num} failed: {e}", file=sys.stderr
            )

        time.sleep(RATE_LIMIT_DELAY)

    print(f"    Total unique messages from CRM people: {len(all_messages)}")
    return all_messages


def search_draft_message_ids(account):
    """Return authoritative Gmail draft message IDs for one mailbox."""
    result = gog(
        account,
        "gmail",
        "messages",
        "search",
        "label:DRAFT",
        "--max",
        "10000",
    )
    messages = result if isinstance(result, list) else result.get("messages", [])
    return {
        message.get("id")
        for message in messages
        if isinstance(message, dict) and message.get("id")
    }


def purge_imported_drafts(conn, account, dry_run=False):
    """Remove previously imported messages that Gmail still marks as drafts."""
    owner_id = get_mailbox_owner_id(conn, account)
    draft_ids = sorted(search_draft_message_ids(account))
    stats = {
        "gmail_drafts": len(draft_ids),
        "messages": 0,
        "interactions": 0,
        "threads": 0,
    }
    if not draft_ids:
        return stats

    with conn.cursor() as cur:
        cur.execute(
            """SELECT count(*)
                 FROM crm_email_messages
                WHERE mailbox_owner_id = %s
                  AND gmail_message_id = ANY(%s::text[])""",
            (owner_id, draft_ids),
        )
        stats["messages"] = cur.fetchone()[0]
        if dry_run or not stats["messages"]:
            return stats

        cur.execute(
            """SELECT DISTINCT i.person_id
                 FROM crm_interactions i
                 JOIN crm_email_messages m ON m.id = i.email_message_id
                WHERE m.mailbox_owner_id = %s
                  AND m.gmail_message_id = ANY(%s::text[])
                  AND i.person_id IS NOT NULL""",
            (owner_id, draft_ids),
        )
        affected_person_ids = [row[0] for row in cur.fetchall()]

        cur.execute(
            """DELETE FROM crm_interactions i
                  USING crm_email_messages m
                 WHERE i.email_message_id = m.id
                   AND m.mailbox_owner_id = %s
                   AND m.gmail_message_id = ANY(%s::text[])""",
            (owner_id, draft_ids),
        )
        stats["interactions"] = cur.rowcount

        cur.execute(
            """DELETE FROM crm_email_messages
                 WHERE mailbox_owner_id = %s
                   AND gmail_message_id = ANY(%s::text[])""",
            (owner_id, draft_ids),
        )

        cur.execute(
            """DELETE FROM crm_email_threads t
                 WHERE t.mailbox_owner_id = %s
                   AND NOT EXISTS (
                       SELECT 1 FROM crm_email_messages m WHERE m.thread_id = t.id
                   )""",
            (owner_id,),
        )
        stats["threads"] = cur.rowcount

        if affected_person_ids:
            cur.execute(
                """UPDATE crm_people p
                      SET last_interaction_at = (
                          SELECT max(i.occurred_at)
                            FROM crm_interactions i
                           WHERE i.person_id = p.id
                      ),
                          updated_at = now()
                    WHERE p.id = ANY(%s::text[])""",
                (affected_person_ids,),
            )

    conn.commit()
    return stats


def fetch_message(account, message_id):
    """Fetch full message details via gog gmail get."""
    try:
        result = gog(account, "gmail", "get", message_id, timeout=60)
        time.sleep(RATE_LIMIT_DELAY)
        return result
    except Exception as e:
        print(
            f"    Warning: failed to fetch message {message_id}: {e}",
            file=sys.stderr,
        )
        return None


# ---------------------------------------------------------------------------
# Import decision
# ---------------------------------------------------------------------------

def check_should_import(headers, crm_emails, owner_emails, has_crm_label):
    """
    Check if message should be imported.
    Returns (should_import, reason, matched_party_ids).
    """
    if has_crm_label:
        return True, "crm-label", set()

    from_header = headers.get("from", "")
    to_header = headers.get("to", "")
    cc_header = headers.get("cc", "")

    all_parties = []
    all_parties.extend(parse_email_addresses(from_header))
    all_parties.extend(parse_email_addresses(to_header))
    all_parties.extend(parse_email_addresses(cc_header))

    matched = set()
    for _name, email in all_parties:
        normalized = normalize_email(email)
        if normalized and normalized not in owner_emails and normalized in crm_emails:
            matched.add(crm_emails[normalized])

    if matched:
        return True, "crm-party", matched

    return False, "no-match", set()


# ---------------------------------------------------------------------------
# Postgres upserts
# ---------------------------------------------------------------------------

def upsert_thread(cur, owner_id, account, gmail_thread_id, subject, sent_at):
    """Upsert an email thread inside one authoritative mailbox."""
    scoped_key = f"{account.lower()}:{gmail_thread_id}"
    thread_pk = "gmail_thread_" + hashlib.sha256(scoped_key.encode()).hexdigest()[:32]
    cur.execute(
        """
        INSERT INTO crm_email_threads (id, subject, gmail_thread_id, mailbox_owner_id, last_message_at, message_count)
        VALUES (%s, %s, %s, %s, %s, 1)
        ON CONFLICT (mailbox_owner_id, gmail_thread_id) WHERE mailbox_owner_id IS NOT NULL AND gmail_thread_id IS NOT NULL DO UPDATE
        SET subject = EXCLUDED.subject,
            last_message_at = GREATEST(crm_email_threads.last_message_at, EXCLUDED.last_message_at),
            updated_at = now()
        RETURNING id
        """,
        (thread_pk, subject, gmail_thread_id, owner_id, sent_at),
    )
    return cur.fetchone()[0]


def upsert_message(
    cur, owner_id, account, gmail_msg_id, thread_pk, subject, sent_at,
    from_person_id, from_email, body_preview, body, has_attachments,
):
    """Upsert an email message inside one authoritative mailbox."""
    scoped_key = f"{account.lower()}:{gmail_msg_id}"
    msg_pk = "gmail_msg_" + hashlib.sha256(scoped_key.encode()).hexdigest()[:32]
    cur.execute(
        """
        INSERT INTO crm_email_messages
            (id, thread_id, subject, sent_at, from_person_id, from_email,
             body_preview, body, has_attachments, gmail_message_id, mailbox_owner_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        ON CONFLICT (mailbox_owner_id, gmail_message_id) WHERE mailbox_owner_id IS NOT NULL AND gmail_message_id IS NOT NULL DO UPDATE
        SET subject = EXCLUDED.subject,
            sent_at = EXCLUDED.sent_at,
            from_person_id = COALESCE(EXCLUDED.from_person_id, crm_email_messages.from_person_id),
            from_email = COALESCE(EXCLUDED.from_email, crm_email_messages.from_email),
            body_preview = EXCLUDED.body_preview,
            body = EXCLUDED.body,
            has_attachments = EXCLUDED.has_attachments,
            updated_at = now()
        RETURNING id
        """,
        (
            msg_pk, thread_pk, subject, sent_at, from_person_id, from_email,
            body_preview, body[:50000] if body else None,
            has_attachments, gmail_msg_id, owner_id,
        ),
    )
    return cur.fetchone()[0]


def upsert_recipient(cur, message_pk, person_id, recipient_type, position):
    """Upsert email message recipient."""
    cur.execute(
        """
        INSERT INTO crm_email_message_recipients (message_id, person_id, recipient_type, position)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (message_id, person_id, recipient_type) DO NOTHING
        """,
        (message_pk, person_id, recipient_type, position),
    )


def upsert_thread_participant(cur, thread_pk, person_id, position):
    """Upsert thread participant."""
    cur.execute(
        """
        INSERT INTO crm_email_thread_participants (thread_id, person_id, position)
        VALUES (%s, %s, %s)
        ON CONFLICT (thread_id, person_id) DO NOTHING
        """,
        (thread_pk, person_id, position),
    )


def upsert_interaction(
    cur, person_id, company_id, msg_pk, occurred_at, direction, score
):
    """Upsert interaction for a CRM person on a message."""
    # Deterministic ID: hash of message PK + person ID
    raw = f"{msg_pk}_{person_id}"
    int_id = "int_" + hashlib.md5(raw.encode()).hexdigest()[:16]
    cur.execute(
        """
        INSERT INTO crm_interactions
            (id, type, occurred_at, person_id, company_id,
             email_message_id, direction, score_contribution)
        VALUES (%s, 'Email', %s, %s, %s, %s, %s, %s)
        ON CONFLICT (id) DO UPDATE
        SET occurred_at = EXCLUDED.occurred_at,
            direction = EXCLUDED.direction,
            score_contribution = EXCLUDED.score_contribution,
            updated_at = now()
        """,
        (int_id, occurred_at, person_id, company_id, msg_pk, direction, score),
    )


def update_person_last_interaction(cur, person_id, occurred_at):
    """Update person's last_interaction_at if this is more recent."""
    cur.execute(
        """
        UPDATE crm_people
        SET last_interaction_at = GREATEST(
            COALESCE(last_interaction_at, '1970-01-01'::timestamptz),
            %s::timestamptz
        )
        WHERE id = %s AND (%s::timestamptz > COALESCE(last_interaction_at, '1970-01-01'::timestamptz))
        """,
        (occurred_at, person_id, occurred_at),
    )


# ---------------------------------------------------------------------------
# Main sync
# ---------------------------------------------------------------------------

def sync_account(
    conn,
    account,
    crm_people,
    owner_emails,
    person_company_map,
    existing_message_ids,
    dry_run=False,
    last_sync_at=None,
    full_sync=False,
    max_fetch=None,
):
    """Sync one Gmail account. Returns stats dict."""
    owner_id = get_mailbox_owner_id(conn, account)
    account_key = account.lower()
    stats = {
        "found": 0,
        "fetched": 0,
        "imported": 0,
        "skipped": 0,
        "errors": 0,
        "drafts_skipped": 0,
        "threads": 0,
        "recipients": 0,
        "participants": 0,
        "interactions": 0,
        "auto_created": 0,
    }

    # Build incremental date filter
    after_date = None
    if not full_sync and last_sync_at:
        after_date = (last_sync_at - timedelta(days=1)).strftime("%Y/%m/%d")
        print(f"  [{account}] Incremental sync after {after_date}")

    # Search for messages
    crm_label_msgs = search_label_crm(account, after_date)
    counterparty_msgs = search_by_crm_people(
        account, set(crm_people.keys()), owner_emails, after_date
    )

    # Deduplicate by message ID
    crm_label_ids = {msg.get("id") for msg in crm_label_msgs}
    all_msgs = {}
    for msg in crm_label_msgs + counterparty_msgs:
        msg_id = msg.get("id")
        if msg_id and msg_id not in all_msgs:
            all_msgs[msg_id] = msg

    print(f"\n  [{account}] Total unique messages to process: {len(all_msgs)}")
    stats["found"] = len(all_msgs)

    already_imported = [msg_id for msg_id in all_msgs if (account_key, msg_id) in existing_message_ids]
    if already_imported:
        print(
            f"  [{account}] Already imported, skipping fetch for {len(already_imported)} messages"
        )

    if dry_run:
        print("  [DRY RUN] Skipping fetch and import.")
        return stats

    # Apply max-fetch safety valve (newest first, relying on Gmail search order)
    process_msg_ids = list(all_msgs.keys())
    if max_fetch:
        process_msg_ids = process_msg_ids[:max_fetch]
        print(
            f"  [{account}] Capping fetch at {max_fetch} messages "
            f"(processing {len(process_msg_ids)})"
        )

    # Process each message
    for i, msg_id in enumerate(process_msg_ids):
        total_to_process = len(process_msg_ids)
        if (i + 1) % COMMIT_EVERY == 0:
            conn.commit()
            print(
                f"  [{account}] Processed {i+1}/{total_to_process} "
                f"(imported: {stats['imported']}, skipped: {stats['skipped']})"
            )

        if (account_key, msg_id) in existing_message_ids:
            stats["skipped"] += 1
            continue

        # Fetch full message
        full_msg = fetch_message(account, msg_id)
        if not full_msg:
            stats["errors"] += 1
            continue

        stats["fetched"] += 1

        # Extract data from gog response
        headers = full_msg.get("headers", {})
        raw_msg = full_msg.get("message", {})
        body = full_msg.get("body", "")
        attachments = full_msg.get("attachments", [])

        from_header = headers.get("from", "")
        to_header = headers.get("to", "")
        cc_header = headers.get("cc", "")
        subject = headers.get("subject", "")
        date_header = headers.get("date", "")

        thread_id = raw_msg.get("threadId", "")
        internal_date = raw_msg.get("internalDate")
        label_ids = raw_msg.get("labelIds", [])

        # Search excludes drafts, and this authoritative fetched-message guard
        # prevents import if Gmail returns a stale or unexpectedly labelled hit.
        if is_draft_message(raw_msg):
            stats["drafts_skipped"] += 1
            continue

        if not thread_id:
            print(f"    Warning: no threadId for message {msg_id}, skipping")
            stats["errors"] += 1
            continue

        # Parse date
        sent_at = parse_date(date_header)
        if not sent_at and internal_date:
            try:
                sent_at = datetime.fromtimestamp(
                    int(internal_date) / 1000, tz=timezone.utc
                ).isoformat()
            except Exception:
                pass

        # Check if should import
        has_crm_label = msg_id in crm_label_ids or "CRM" in label_ids
        should, reason, matched_parties = check_should_import(
            headers, crm_people, owner_emails, has_crm_label
        )

        if not should:
            stats["skipped"] += 1
            continue

        stats["imported"] += 1

        # Parse all parties
        from_parties = parse_email_addresses(from_header)
        to_parties = parse_email_addresses(to_header)
        cc_parties = parse_email_addresses(cc_header)

        # Determine direction before parties are auto-created
        from_is_owner = False
        if from_parties:
            from_email = normalize_email(from_parties[0][1])
            from_is_owner = from_email in owner_emails

        to_has_owner = any(
            normalize_email(email) in owner_emails
            for _name, email in to_parties + cc_parties
        )

        if from_is_owner:
            direction = "Sent"
        elif to_has_owner:
            direction = "Received"
        else:
            direction = "Internal"

        # Body preview
        body_preview = make_body_preview(body)

        # Upsert thread
        with conn.cursor() as cur:
            # Auto-create missing counterparties so the rest of the pipeline
            # can link them naturally.
            for name, email in from_parties + to_parties + cc_parties:
                ensure_person(
                    cur, name, email, crm_people, owner_emails, person_company_map, stats
                )

            # Resolve from_person_id (now guaranteed to exist if not owner)
            from_person_id = None
            if from_parties:
                from_email = normalize_email(from_parties[0][1])
                if from_email and from_email in crm_people:
                    from_person_id = crm_people[from_email]

            thread_pk = upsert_thread(cur, owner_id, account, thread_id, subject, sent_at)
            stats["threads"] += 1

            # Upsert message
            sender_email = normalize_email(from_parties[0][1]) if from_parties else None
            msg_pk = upsert_message(
                cur, owner_id, account, msg_id, thread_pk, subject, sent_at,
                from_person_id, sender_email, body_preview, body, bool(attachments),
            )
            existing_message_ids.add((account_key, msg_id))

            # Upsert recipients (to and cc) - only CRM people
            pos = 0
            for _name, email in to_parties:
                normalized = normalize_email(email)
                if normalized and normalized in crm_people:
                    person_id = crm_people[normalized]
                    upsert_recipient(cur, msg_pk, person_id, "to", pos)
                    upsert_thread_participant(cur, thread_pk, person_id, pos)
                    stats["recipients"] += 1
                    stats["participants"] += 1
                    pos += 1

            pos = 0
            for _name, email in cc_parties:
                normalized = normalize_email(email)
                if normalized and normalized in crm_people:
                    person_id = crm_people[normalized]
                    upsert_recipient(cur, msg_pk, person_id, "cc", pos)
                    upsert_thread_participant(cur, thread_pk, person_id, pos)
                    stats["recipients"] += 1
                    stats["participants"] += 1
                    pos += 1

            # Add from person as thread participant if in CRM
            if from_person_id:
                upsert_thread_participant(cur, thread_pk, from_person_id, 0)
                stats["participants"] += 1

            # Create interactions for all CRM parties in this message
            # From person
            if from_person_id:
                company_id = person_company_map.get(from_person_id)
                upsert_interaction(
                    cur, from_person_id, company_id, msg_pk,
                    sent_at, direction, 1.0,
                )
                update_person_last_interaction(cur, from_person_id, sent_at)
                stats["interactions"] += 1

            # To persons
            for _name, email in to_parties:
                normalized = normalize_email(email)
                if normalized and normalized in crm_people:
                    person_id = crm_people[normalized]
                    if person_id == from_person_id:
                        continue
                    company_id = person_company_map.get(person_id)
                    upsert_interaction(
                        cur, person_id, company_id, msg_pk,
                        sent_at, direction, 1.0,
                    )
                    update_person_last_interaction(cur, person_id, sent_at)
                    stats["interactions"] += 1

            # CC persons
            for _name, email in cc_parties:
                normalized = normalize_email(email)
                if normalized and normalized in crm_people:
                    person_id = crm_people[normalized]
                    if person_id == from_person_id:
                        continue
                    company_id = person_company_map.get(person_id)
                    upsert_interaction(
                        cur, person_id, company_id, msg_pk,
                        sent_at, direction, 0.3,
                    )
                    update_person_last_interaction(cur, person_id, sent_at)
                    stats["interactions"] += 1

    conn.commit()
    if not dry_run:
        set_sync_state(conn, account, "success")
        print(f"  [{account}] Sync state recorded")
    return stats


def update_thread_aggregates(conn):
    """Recalculate thread message_count and last_message_at from actual messages."""
    print("\nUpdating thread aggregates...")
    with conn.cursor() as cur:
        cur.execute(
            """
            UPDATE crm_email_threads t
            SET message_count = sub.cnt,
                last_message_at = sub.latest
            FROM (
                SELECT thread_id, count(*) as cnt, max(sent_at) as latest
                FROM crm_email_messages
                WHERE mailbox_owner_id IS NOT NULL
                GROUP BY thread_id
            ) sub
            WHERE t.id = sub.thread_id
            """
        )
    conn.commit()
    print(f"  Updated {cur.rowcount} threads")


def main():
    parser = argparse.ArgumentParser(description="Gog CRM Email Sync")
    parser.add_argument(
        "--dry-run", action="store_true", help="Search only, no imports"
    )
    parser.add_argument(
        "--account", type=str, default=None, help="Sync only this account"
    )
    parser.add_argument(
        "--full-sync", action="store_true", help="Ignore last sync state and sync everything"
    )
    parser.add_argument(
        "--max-fetch", type=int, default=None, help="Max messages to fetch per account (newest first)"
    )
    parser.add_argument(
        "--purge-drafts",
        action="store_true",
        help="Delete previously imported messages that Gmail currently marks as drafts",
    )
    args = parser.parse_args()

    print("=" * 60)
    print("  Gog CRM Email Sync")
    print("=" * 60)

    accounts = [args.account] if args.account else ACCOUNTS

    # Connect to Postgres
    conn = psycopg2.connect(dbname=DB_NAME)
    conn.autocommit = False

    # Ensure sync state table exists
    init_sync_state(conn)

    # Load CRM data
    print("\nLoading CRM data...")
    crm_people = get_crm_people(conn)
    owner_emails = get_owner_emails()
    person_company_map = get_person_company_map(conn)

    if args.purge_drafts:
        print("\nPurging previously imported Gmail drafts...")
        for account in accounts:
            purge_stats = purge_imported_drafts(conn, account, dry_run=args.dry_run)
            mode = "would remove" if args.dry_run else "removed"
            print(
                f"  [{account}] {purge_stats['gmail_drafts']} Gmail drafts; "
                f"{mode} {purge_stats['messages']} messages, "
                f"{purge_stats['interactions']} interactions, "
                f"{purge_stats['threads']} empty threads"
            )

    existing_message_ids = get_existing_message_ids(conn)
    print(f"  {len(crm_people)} CRM people with emails")
    print(f"  {len(person_company_map)} people with company links")
    print(f"  {len(existing_message_ids)} Gmail messages already imported")
    print(f"  Owner emails excluded: {owner_emails}")

    # Load last sync state unless full sync requested
    last_sync_map = {}
    if not args.full_sync:
        for account in accounts:
            last_sync_map[account] = get_last_sync_at(conn, account)
            if last_sync_map[account]:
                print(
                    f"  Last successful sync for {account}: "
                    f"{last_sync_map[account].isoformat()}"
                )

    # Sync each account
    all_stats = []
    for account in accounts:
        print(f"\n{'─' * 50}")
        print(f"  Account: {account}")
        print(f"{'─' * 50}")

        stats = sync_account(
            conn, account, crm_people, owner_emails,
            person_company_map, existing_message_ids,
            dry_run=args.dry_run,
            last_sync_at=last_sync_map.get(account),
            full_sync=args.full_sync,
            max_fetch=args.max_fetch,
        )
        all_stats.append((account, stats))

    if not args.dry_run:
        update_thread_aggregates(conn)

    # Print summary
    print("\n" + "=" * 60)
    print("  SYNC SUMMARY")
    print("=" * 60)
    for account, stats in all_stats:
        print(f"\n  {account}:")
        for key, val in stats.items():
            print(f"    {key:>15}: {val}")

    conn.close()
    print("\nDone.")


if __name__ == "__main__":
    main()
