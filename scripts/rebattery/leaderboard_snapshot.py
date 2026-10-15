#!/usr/bin/env python3
"""Fetch per-user PostHog activity once and store it for the CRM Leaderboard.

One scan computes the 7, 30 and 90 day windows together. A failed fetch leaves the
previous snapshot untouched; all three windows are replaced in one transaction.
Output is counts only.
"""
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import psycopg2
from psycopg2.extras import Json

ROOT = Path(__file__).resolve().parents[2]
CREDENTIALS = Path('/root/.posthog/credentials.json')
HOSTS = {'https://us.posthog.com', 'https://eu.posthog.com', 'https://app.posthog.com'}
WINDOWS = (7, 30, 90)
OFFER_EVENTS = ('listing_offer_submitted', 'listing_buy_now_submitted', 'auction_bid_submitted')


def scored_events():
    """The scored event names live in scoring.ts; read them from there."""
    out = subprocess.run(
        ['bun', '-e', "import {SCORING} from './apps/web/lib/leaderboard/scoring.ts'; console.log(JSON.stringify(Object.keys(SCORING.weights)))"],
        cwd=ROOT, capture_output=True, text=True, check=True).stdout
    return json.loads(out)


def posthog(sql, creds):
    body = json.dumps({'query': {'kind': 'HogQLQuery', 'query': sql, 'filters': {'filterTestAccounts': True}}}).encode()
    request = urllib.request.Request(
        f"{creds['host'].rstrip('/')}/api/projects/{creds['env_id']}/query/", data=body,
        headers={'Authorization': f"Bearer {creds['token']}", 'Content-Type': 'application/json'})
    last = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(request, timeout=300) as response:
                payload = json.load(response)
            if payload.get('error') or payload.get('hasMore') or not isinstance(payload.get('results'), list):
                raise RuntimeError('PostHog response incomplete')
            return payload['results']
        except urllib.error.HTTPError as error:
            last = f'HTTP {error.code}'
            if error.code < 500 and error.code != 429:
                raise RuntimeError(f'PostHog query failed ({error.code})')
        except (urllib.error.URLError, TimeoutError) as error:
            last = str(error)
        time.sleep(15 * (attempt + 1))
    raise RuntimeError(f'PostHog unavailable after retries ({last})')


BOT = """AND coalesce(toString(properties.is_bot), 'false') NOT IN ('true','1')
      AND coalesce(toString(properties.$virt_is_bot), 'false') NOT IN ('true','1')
      AND coalesce(toString(properties.analytics_test_cohort), 'false') NOT IN ('true','1')"""
NOISE = "event NOT IN ('$web_vitals', '$pageleave', '$autocapture')"


def lifetime_query(ids):
    """Cheap all-time pass: total events and last seen. Heavier predicates time out at this scale."""
    id_list = ','.join(f"'{i}'" for i in ids) or "''"
    return f"""SELECT distinct_id, count(), max(timestamp) FROM events
      WHERE distinct_id IN ({id_list}) AND {NOISE} AND {{filters}}
      GROUP BY distinct_id ORDER BY distinct_id LIMIT 5000"""


def window_query(events, ids):
    """One 90 day scan that yields the 7, 30 and 90 day figures together."""
    cols = ['distinct_id', 'countIf(timestamp >= now() - INTERVAL 7 DAY)',
            'countIf(timestamp >= now() - INTERVAL 14 DAY AND timestamp < now() - INTERVAL 7 DAY)',
            "countIf(event IN (%s))" % ','.join(f"'{e}'" for e in OFFER_EVENTS)]
    for w in WINDOWS:
        cols += [f"uniqIf(properties.$session_id, timestamp >= now() - INTERVAL {w} DAY AND properties.$session_id IS NOT NULL)",
                 f"uniqIf(toDate(timestamp), timestamp >= now() - INTERVAL {w} DAY)",
                 f"countIf(timestamp >= now() - INTERVAL {w} DAY)"]
        cols += [f"countIf(event = '{e}' AND timestamp >= now() - INTERVAL {w} DAY)" for e in events]
    id_list = ','.join(f"'{i}'" for i in ids) or "''"
    return f"""SELECT {', '.join(cols)} FROM events
      WHERE timestamp >= now() - INTERVAL 90 DAY AND distinct_id IN ({id_list})
      AND {NOISE} AND {{filters}} {BOT}
      GROUP BY distinct_id ORDER BY distinct_id LIMIT 5000"""


def fetch(conn, creds, events):
    with conn.cursor() as cur:
        cur.execute('select auth_user_id::text from crm_platform_accounts')
        ids = [row[0] for row in cur.fetchall()]
    lifetime = {r[0]: r for r in posthog(lifetime_query(ids), creds)}
    recent = {r[0]: r for r in posthog(window_query(events, ids), creds)}
    if len(lifetime) == 5000 or len(recent) == 5000:
        raise RuntimeError('PostHog result hit the row cap')
    out = {w: [] for w in WINDOWS}
    for uid, life in lifetime.items():
        r = recent.get(uid)
        base = {'authUserId': uid, 'role': None, 'accountStatus': None, 'totalEvents': int(life[1]),
                'lastSeen': datetime.fromisoformat(str(life[2]).replace('Z', '+00:00')).astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
                'recentEvents': int(r[1]) if r else 0, 'previousEvents': int(r[2]) if r else 0, 'hasOffer': bool(r and int(r[3]) > 0)}
        offset = 4
        for w in WINDOWS:
            if r:
                counts = r[offset + 3: offset + 3 + len(events)]
                out[w].append({**base, 'sessions': int(r[offset]), 'activeDays': int(r[offset + 1]), 'engagementScore': int(r[offset + 2]),
                               'actions': [{'event': e, 'count': int(c)} for e, c in zip(events, counts) if int(c) > 0]})
                offset += 3 + len(events)
            else:
                out[w].append({**base, 'sessions': 0, 'activeDays': 0, 'engagementScore': 0, 'actions': []})
    return out


def main():
    creds = json.loads(CREDENTIALS.read_text())
    if creds.get('host', '').rstrip('/') not in HOSTS or str(creds.get('env_id')) != '375247':
        sys.exit('PostHog credentials not as expected')
    with psycopg2.connect(dbname='denchclaw') as conn:
        data = fetch(conn, creds, scored_events())
        now = datetime.now(timezone.utc)
        with conn.cursor() as cur:
            for w in WINDOWS:
                cur.execute("""insert into crm_user_activity_snapshots(window_days, as_of, row_count, activity)
                  values (%s,%s,%s,%s) on conflict (window_days) do update
                  set as_of = excluded.as_of, row_count = excluded.row_count, activity = excluded.activity""",
                            (w, now, len(data[w]), Json(data[w])))
    print(json.dumps({'as_of': now.isoformat(), 'users': {str(w): len(data[w]) for w in WINDOWS}}))


if __name__ == '__main__':
    main()
