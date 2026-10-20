"""Canonical approval contents, independent of provider state and database order."""
import hashlib
import json
from .core import dict_cursor, Refused

FIELDS = ('id','identity_key','transport','purpose','from_email','to_emails','cc_emails','bcc_emails','recipient_email','person_id','company_id','subject','body_text','body_html')


def digest(rows):
    values = [{key:row.get(key) for key in FIELDS} | ({'attachments':[{'filename':a['filename'],'sha256':a['sha256']} for a in row['personalization']['attachments']]} if row.get('personalization',{}).get('attachments') and row.get('direction')=='outbound' else {}) | {
        'identity_snapshot':row.get('personalization',{}).get('identity_snapshot'),
        'campaign_cap':row.get('personalization',{}).get('campaign_cap'),
        'links':sorted(row.get('links',[]),key=lambda link:(link['cta_key'],link['destination_url'],link.get('listing_id') or ''))} for row in rows]
    return hashlib.sha256(json.dumps(sorted(values,key=lambda r:r['id']),sort_keys=True,separators=(',',':'),default=str).encode()).hexdigest()


def load(db, target):
    with dict_cursor(db) as cur:
        cur.execute('select * from campaigns where id=%s', (target,))
        campaign = cur.fetchone()
        cur.execute('select m.*,t.gmail_thread_id from mail_message m left join mail_thread t on t.id=m.thread_id where ' + ('m.campaign_id=%s' if campaign else 'm.id=%s') + ' order by m.id', (target,))
        rows = [dict(r) for r in cur.fetchall()]
        if not rows:
            raise Refused('subject_not_found', subject_id=target)
        for row in rows:
            cur.execute('select cta_key,destination_url,listing_id from mail_message_link where message_id=%s order by cta_key',(row['id'],))
            row['links'] = [dict(link) for link in cur.fetchall()]
    return dict(campaign) if campaign else None, rows
