#!/usr/bin/env python3
"""Relay "Prepare listings and link": the marketplace writes for one approved proposal.

Started by the CRM (lib/relay-listings.ts approveListings) as: relay_listings.py <proposal id>, once Alex has approved the
card. For each battery group it creates a DRAFT listing under ReBattery Sales through the supplier API (never published),
adds the seller's photos from their emails with the file metadata removed, then issues the platform's prepared-listing
invitation for the seller's email (scripts/generate-listing-invitation.ts, from a clean checkout of the platform's
origin/main). Everything is read back from the database before the links go to the CRM, which puts them in the reply.

The invitation link is a credential: it is held in memory and handed to the CRM only, never printed, logged or stored.
Keys come from Bitwarden Secrets Manager in memory. Nothing here sends an email or publishes a listing.

RELAY_LISTINGS_ENV=staging runs against staging (staging.rebattery.io, the staging Supabase project) with the key in
RELAY_LISTINGS_STAGING_API_KEY, for testing.
"""
from __future__ import annotations

import base64
import io
import json
import os
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import psycopg2
import psycopg2.extras

DSN = os.environ.get("RELAY_DSN", "host=/var/run/postgresql dbname=denchclaw")
CLI = "/usr/local/bin/rebattery-mail"
CRM_URL = os.environ.get("RELAY_CRM_URL", "http://127.0.0.1:3100").rstrip("/")
SECRET_FILE = os.environ.get("RELAY_INTERNAL_SECRET_FILE", "/root/.hermes/workspace/secrets/relay-internal.secret")
BWS = "/root/.hermes/tools/bws-2.0.0-linux-x64/bws"
BWS_ENV = "/root/.hermes/workspace/secrets/bitwarden-secrets-manager.env"
BWS_PROJECT = "03f9dbec-6f5d-4461-aa95-b48d00ca813e"
BWS_SERVER = "https://vault.bitwarden.eu"
PLATFORM_REPO = Path("/root/.hermes/projects/rebattery-platform")
PLATFORM_DIR = Path(os.environ.get("RELAY_LISTINGS_PLATFORM_DIR", "/root/.hermes-worktrees/platform-invite"))
# The staff-held source account every prepared draft must sit in (issuing is refused otherwise).
SALES_ACCOUNT = "15f92a7a-61be-4648-b328-3d49ab99690e"

IMAGE_TYPES = {"jpg", "jpeg", "png", "webp"}
MAX_PHOTOS = 10
MIN_PHOTO_BYTES = 15_000       # smaller pictures are signatures and logos
PHOTO_SIDE = 1600
PHOTO_BATCH = 3                # photos per upload request, to stay well under request size limits

ENV = os.environ.get("RELAY_LISTINGS_ENV", "production")
# Everything up to the first write: photos, payloads, keys present, platform checkout and the invitation script loading.
DRY_RUN = os.environ.get("RELAY_LISTINGS_DRY_RUN") == "1"
TARGETS = {
    "production": {"origin": "https://www.rebattery.io", "keys": ("REBATTERY_SALES_LISTINGS_API_KEY", "REBATTERY_PRODUCTION_SUPABASE_URL",
                                                                     "REBATTERY_PRODUCTION_SUPABASE_SECRET_KEY", "REBATTERY_PRODUCTION_SUPABASE_PUBLISHABLE_KEY")},
    "staging": {"origin": "https://staging.rebattery.io", "keys": (None, "REBATTERY_STAGING_SUPABASE_URL",
                                                                   "REBATTERY_STAGING_SUPABASE_SECRET_KEY", "REBATTERY_STAGING_SUPABASE_PUBLISHABLE_KEY")},
}


class Stop(Exception):
    """A reason to stop that Alex can read on the card. Never carries a secret or the link."""


# ---------- pure parts (tested) ----------

def is_photo(attachment: dict) -> bool:
    name = str(attachment.get("filename") or "").lower()
    return name.rsplit(".", 1)[-1] in IMAGE_TYPES and int(attachment.get("sizeBytes") or 0) >= MIN_PHOTO_BYTES


def clean_photo(raw: bytes) -> bytes:
    """The photo as a fresh JPEG: turned upright, at most PHOTO_SIDE on its long side, and with no EXIF or other
    metadata (GPS position, device, owner name)."""
    from PIL import Image, ImageOps
    with Image.open(io.BytesIO(raw)) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        im.thumbnail((PHOTO_SIDE, PHOTO_SIDE))
        out = io.BytesIO()
        im.save(out, "JPEG", quality=85, optimize=True)  # nothing is passed through: no exif=, no icc_profile=
        return out.getvalue()


def batches(items: list, size: int) -> list[list]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def links_for(groups: list[dict], issued: dict[int, dict], origin: str) -> list[dict]:
    """The one link in the reply. The first group's invitation is issued last, so its link sets up the account; opening
    it claims every other open invitation for the same email from ReBattery Sales too (claim_listing_invitation,
    platform migration 20261124140000), so all the drafts land in the seller's account together."""
    labels = [g["group"]["label"] for g in groups]
    return [{"label": " and ".join(labels) if len(labels) <= 2 else f"{len(labels)} listings", "url": issued[0]["url"]}]


# ---------- the outside world ----------

def secrets(names: tuple) -> dict[str, str]:
    """The named secrets from Bitwarden, in memory only."""
    env = dict(os.environ)
    for line in Path(BWS_ENV).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip().removeprefix("export ").strip()] = v.strip().strip('"').strip("'")
    result = subprocess.run([BWS, "secret", "list", BWS_PROJECT, "--output", "json", "--server-url", BWS_SERVER],
                            capture_output=True, text=True, env=env, timeout=60)
    if result.returncode != 0:
        raise Stop("Couldn't read the marketplace keys from Bitwarden.")
    found = {s["key"]: s["value"] for s in json.loads(result.stdout) if s.get("key") in names}
    missing = [n for n in names if n and n not in found]
    if missing:
        raise Stop(f"Bitwarden has no {', '.join(missing)}.")
    return found


def http(method: str, url: str, headers: dict, body: dict | None = None, timeout: int = 90) -> tuple[int, dict]:
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json", **headers})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            return r.status, json.loads(raw or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except ValueError:
            return e.code, {}


def api_error(status: int, body: dict) -> str:
    detail = body.get("error") or body.get("message") or ""
    if isinstance(detail, dict):
        detail = detail.get("message") or json.dumps(detail)[:200]
    return f"the marketplace answered {status}{f': {str(detail)[:200]}' if detail else ''}"


def photos(cur, thread_id: str, seller: str) -> list[bytes]:
    """The seller's photos from their emails on the thread, newest email first, cleaned, at most MAX_PHOTOS."""
    cur.execute("""select id from mail_message where thread_id = %s and direction = 'inbound' and lower(from_email) = %s
                   order by coalesce(sent_at, created_at) desc limit 10""", (thread_id, seller))
    out: list[bytes] = []
    with tempfile.TemporaryDirectory(prefix="relay-listing-") as folder:
        for row in cur.fetchall():
            message_id = row["id"] if isinstance(row, dict) else row[0]
            listed = subprocess.run([CLI, "attachment", "list", "--", message_id], capture_output=True, text=True, timeout=60)
            if listed.returncode != 0:
                continue
            files = [a for a in json.loads(listed.stdout).get("attachments", []) if is_photo(a)]
            names = [str(a["filename"]) for a in files]
            for a in files:
                if len(out) >= MAX_PHOTOS:
                    return out
                if names.count(str(a["filename"])) > 1:
                    continue  # Gmail is asked by name: two parts with one name can't be told apart
                path = Path(folder) / f"{len(out)}.img"
                got = subprocess.run([CLI, "attachment", "get", "--out", str(path), "--", message_id, str(a["filename"])],
                                     capture_output=True, text=True, timeout=120)
                if got.returncode != 0 or not path.is_file():
                    continue
                try:
                    out.append(clean_photo(path.read_bytes()))
                except Exception:  # an image PIL can't read is left out, never sent raw
                    continue
    return out


def create_draft(base: str, key: str, proposal_id: str, index: int, payload: dict, pictures: list[bytes]) -> dict:
    auth = {"authorization": f"Bearer {key}"}
    status, ack = http("POST", f"{base}/api/v1/listings", {**auth, "idempotency-key": f"relay-{proposal_id}-{index}"}, payload)
    if status not in (200, 201) or not ack.get("id"):
        raise Stop(f"Creating draft {index + 1} failed: {api_error(status, ack)}.")
    if ack.get("status") != "draft":
        raise Stop(f"Draft {index + 1} came back {ack.get('status')}, not draft. Check it on the marketplace.")
    listing_id, revision = ack["id"], ack.get("revision")
    for n, batch in enumerate(batches(pictures, PHOTO_BATCH)):
        images = [{"base64": base64.b64encode(p).decode(), "contentType": "image/jpeg", "filename": f"photo-{n * PHOTO_BATCH + i + 1}.jpg"} for i, p in enumerate(batch)]
        status, ack = http("POST", f"{base}/api/v1/listings/{listing_id}/images",
                           {**auth, "idempotency-key": f"relay-{proposal_id}-{index}-photos-{n}", "if-match": f'"{revision}"'}, {"images": images})
        if status not in (200, 201):
            raise Stop(f"Adding photos to draft {index + 1} failed: {api_error(status, ack)}.")
        revision = ack.get("revision", revision)
    return {"id": listing_id}


def platform_checkout() -> Path:
    """A clean checkout of the platform's origin/main for the invitation script, kept beside the shared one."""
    def git(*args: str, cwd: Path = PLATFORM_REPO) -> str:
        return subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, timeout=300, check=True).stdout.strip()
    git("fetch", "-q", "origin", "main")
    if not PLATFORM_DIR.exists():
        git("worktree", "add", "--detach", str(PLATFORM_DIR), "origin/main")
    before = git("rev-parse", "HEAD:bun.lock", cwd=PLATFORM_DIR) if (PLATFORM_DIR / "bun.lock").exists() else ""
    git("checkout", "-q", "--detach", "--force", "origin/main", cwd=PLATFORM_DIR)
    after = git("rev-parse", "HEAD:bun.lock", cwd=PLATFORM_DIR)
    if before != after or not (PLATFORM_DIR / "node_modules").exists():
        subprocess.run(["bun", "install", "--frozen-lockfile"], cwd=PLATFORM_DIR, capture_output=True, text=True, timeout=900, check=True)
    for stray in (".env", ".env.local", ".env.production", ".env.production.local"):
        if (PLATFORM_DIR / stray).exists():  # bun loads these on its own; only the environment given below may count
            raise Stop(f"The platform checkout has a {stray} file; remove it before issuing links.")
    return PLATFORM_DIR


def issue(platform: Path, env: dict[str, str], origin: str, email: str, listing_id: str) -> dict:
    result = subprocess.run(["bun", "scripts/generate-listing-invitation.ts", "--origin", origin, "--email", email, "--listing", listing_id],
                            cwd=platform, capture_output=True, text=True, timeout=180, env=env)
    if result.returncode != 0:
        raise Stop(f"Issuing the link failed: {result.stderr.strip().splitlines()[-1][:200] if result.stderr.strip() else 'no reason given'}.")
    lines = [line for line in result.stdout.splitlines() if line.startswith("{")]
    out = json.loads(lines[-1])
    if not out.get("url", "").startswith(origin) or not out.get("invitationId"):
        raise Stop("The link the script gave back doesn't look right, so it wasn't used.")
    return out


def rest(supabase: str, secret: str, table: str, query: str) -> list[dict]:
    status, body = http("GET", f"{supabase}/rest/v1/{table}?{query}", {"apikey": secret, "authorization": f"Bearer {secret}"}, None)
    if status != 200 or not isinstance(body, list):
        raise Stop(f"Reading back {table} failed ({status}).")
    return body


def verify(supabase: str, secret: str, email: str, listing_ids: list[str], invitation_ids: list[str]) -> None:
    """Reads the drafts and invitations back from the database rather than trusting the API and script output."""
    listings = rest(supabase, secret, "listings", f"select=id,listing_status,supplier_account_id&id=in.({','.join(listing_ids)})")
    if len(listings) != len(listing_ids) or any(l["listing_status"] != "draft" or l["supplier_account_id"] != SALES_ACCOUNT for l in listings):
        raise Stop("The drafts didn't read back as ReBattery Sales drafts. Check them on the marketplace.")
    invitations = rest(supabase, secret, "listing_invitations",
                       f"select=id,listing_id,source_account_id,recipient_email,expires_at,revoked_at,claimed_at&id=in.({','.join(invitation_ids)})")
    if len(invitations) != len(invitation_ids):
        raise Stop("Not every invitation read back. Check them before sending.")
    for inv in invitations:
        if str(inv.get("recipient_email") or "").lower() != email:
            raise Stop("An invitation is bound to a different email. It wasn't used.")
        if inv.get("listing_id") not in listing_ids or inv.get("source_account_id") != SALES_ACCOUNT:
            raise Stop("An invitation points at the wrong listing or account. It wasn't used.")
        if inv.get("claimed_at") or inv.get("revoked_at") or not inv.get("expires_at"):
            raise Stop("An invitation isn't open. Check it before sending.")


def report(proposal_id: str, body: dict) -> None:
    secret = Path(SECRET_FILE).read_text().strip()
    status, answer = http("POST", f"{CRM_URL}/api/relay/internal/listings/{urllib.parse.quote(proposal_id)}", {"authorization": f"Bearer {secret}"}, body, timeout=120)
    if status != 200:
        raise RuntimeError(f"CRM answered {status}: {answer.get('error', '')}")


def run(proposal_id: str) -> None:
    target = TARGETS[ENV]
    with psycopg2.connect(DSN) as conn, conn.cursor(cursor_factory=psycopg2.extras.RealDictCursor) as cur:
        cur.execute("""select p.id, p.seller_email, p.groups, p.status, i.mail_thread_id from relay_listing_proposal p
                         join relay_item i on i.id = p.item_id where p.id = %s""", (proposal_id,))
        p = cur.fetchone()
        if not p or p["status"] not in (("creating", "proposed", "failed") if DRY_RUN else ("creating",)):
            raise Stop("This proposal isn't waiting to be created.")
        if not DRY_RUN:
            cur.execute("update relay_listing_proposal set pid = %s, updated_at = now() where id = %s", (os.getpid(), proposal_id))
            conn.commit()
        groups, seller = p["groups"], p["seller_email"].lower()
        pictures = photos(cur, p["mail_thread_id"], seller) if p["mail_thread_id"] else []

    keys = secrets(target["keys"])
    api_key = keys.get(target["keys"][0]) if target["keys"][0] else os.environ.get("RELAY_LISTINGS_STAGING_API_KEY", "")
    if not api_key:
        raise Stop("No ReBattery Sales listing key for this environment.")
    supabase, service, publishable = keys[target["keys"][1]], keys[target["keys"][2]], keys[target["keys"][3]]
    origin = target["origin"]

    if DRY_RUN:
        platform = platform_checkout()
        loads = subprocess.run(["bun", "scripts/generate-listing-invitation.ts"], cwd=platform, capture_output=True, text=True, timeout=180,
                               env={"PATH": os.environ.get("PATH", ""), "HOME": os.environ.get("HOME", "/root")})
        print(json.dumps({"dry_run": True, "env": ENV, "seller": seller, "photos": [len(x) for x in pictures],
                          "drafts": [{"label": g["group"]["label"], "payload": g["payload"]} for g in groups],
                          "keys_found": True, "platform_head": subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=platform, capture_output=True, text=True).stdout.strip(),
                          "invitation_script_loads": "are required" in loads.stderr or "Usage:" in loads.stderr}, indent=1))
        return
    created = [create_draft(origin, api_key, proposal_id, i, g["payload"], pictures) for i, g in enumerate(groups)]
    listing_ids = [c["id"] for c in created]

    platform = platform_checkout()
    env = {"PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"), "HOME": os.environ.get("HOME", "/root"),
           "NEXT_PUBLIC_SUPABASE_URL": supabase, "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY": publishable, "SUPABASE_SECRET_KEY": service,
           "PUBLIC_APP_URL": origin, "NEXT_PUBLIC_SITE_URL": origin, "NODE_ENV": "production"}
    issued: dict[int, dict] = {}
    for i in reversed(range(len(listing_ids))):  # the first group last: its link is the one that sets up the account
        issued[i] = issue(platform, env, origin, seller, listing_ids[i])
    invitation_ids = [issued[i]["invitationId"] for i in range(len(listing_ids))]
    verify(supabase, service, seller, listing_ids, invitation_ids)
    report(proposal_id, {"ok": True, "links": links_for(groups, issued, origin), "listingIds": listing_ids,
                         "invitationIds": invitation_ids, "expiresAt": issued[0]["expiresAt"]})


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: relay_listings.py <proposal id>", file=sys.stderr)
        return 2
    try:
        run(argv[1])
        return 0
    except Exception as error:
        if DRY_RUN:
            print(f"relay_listings dry run: {error if isinstance(error, Stop) else repr(error)}", file=sys.stderr)
            return 1  # report every failure to the card, with a reason that never carries a secret
        reason = str(error) if isinstance(error, Stop) else f"The listing job failed ({type(error).__name__}). Check the marketplace before trying again."
        try:
            report(argv[1], {"ok": False, "error": reason})
        except Exception as again:
            print(f"relay_listings: couldn't report: {again}", file=sys.stderr)
        print(f"relay_listings: {reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
