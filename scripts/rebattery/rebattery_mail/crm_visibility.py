"""The existing narrow CRM enrolment policy, independent of wide capture."""
import hashlib
import re
from email.utils import getaddresses

COMMON_EMAIL_PROVIDERS = {'gmail','googlemail','yahoo','outlook','hotmail','icloud','proton','protonmail','aol','live','msn','me','gmx','yandex','zoho','mail','btinternet','wp','o2','interia','onet','ukr','i','seznam','web','t-online'}


def normalize_email(value):
    value = (value or '').strip().lower()
    if '@' not in value:
        return None
    local, domain = value.rsplit('@', 1)
    local = local.split('+',1)[0]
    return f'{local}@{domain}' if local and domain else None


def parse_email_addresses(value):
    return [(name.strip(), email.strip().lower()) for name,email in getaddresses([value or '']) if email]


def is_common_email_provider(domain):
    return not domain or domain.lower().split('.',1)[0] in COMMON_EMAIL_PROVIDERS


def ensure_person(cur, name, email, people, owners, companies, stats, domains=None, labelled=False):
    email = normalize_email(email)
    if not email or email in owners:
        return None, False
    if email in people:
        return people[email], False
    domain = email.split('@',1)[1]
    company = None
    if not is_common_email_provider(domain):
        company = (domains or {}).get(domain)
        if not company and labelled:
            cur.execute('select id from crm_companies where lower(domain)=%s limit 1', (domain,))
            row = cur.fetchone()
            if row:
                company = row[0]
                cur.execute("update crm_companies set name=%s,updated_at=now() where id=%s and coalesce(btrim(name),'')=''", (domain[0].upper()+domain[1:],company))
            else:
                company = 'company_domain_'+hashlib.md5(domain.encode()).hexdigest()[:16]
                cur.execute("insert into crm_companies(id,name,domain,source,source_detail) values(%s,%s,%s,'Email mining','Gmail: thread labelled CRM')", (company,domain[0].upper()+domain[1:],domain))
    if not company and not labelled:
        return None, False
    person = 'person_email_'+hashlib.md5(email.encode()).hexdigest()[:16]
    parts = name.strip().split(None,1) if name else []
    note = 'Added from Gmail: thread labelled CRM' if labelled else f'Added from Gmail: emails from {domain}, a company already in the CRM'
    cur.execute('select id from crm_people where lower(email)=%s limit 1', (email,))
    row = cur.fetchone()
    if row:
        person = row[0]
        cur.execute("update crm_people set full_name=coalesce(nullif(%s,''),full_name),first_name=coalesce(%s,first_name),last_name=coalesce(%s,last_name),company_id=coalesce(%s,company_id),updated_at=now() where id=%s", (name,parts[0] if parts else None,parts[1] if len(parts)>1 else None,company,person))
    else:
        cur.execute('insert into crm_people(id,full_name,first_name,last_name,email,company_id,notes) values(%s,%s,%s,%s,%s,%s,%s)', (person,name or None,parts[0] if parts else None,parts[1] if len(parts)>1 else None,email,company,note))
    people[email], companies[person] = person,company
    stats['auto_created'] += 1
    return person,True


def visibility(parties, people, owners, labelled=False, triaged=False):
    if labelled:
        return True,'crm-label'
    if triaged:
        return True,'triage-label'
    if any(normalize_email(email) in people and normalize_email(email) not in owners for _,email in parties):
        return True,'crm-party'
    return False,'no-match'


def parse_message_ids(value):
    """Extract complete RFC Message-ID tokens, including folded References."""
    return set(re.findall(r'<[^<>\s]+>', value or ''))


def reply_matches(incoming, outgoing, owner_id, account):
    if incoming['direction'] != 'inbound' or outgoing['direction'] != 'outbound':
        return False
    if str(incoming.get('mailbox_owner_id')) != str(owner_id):
        return False
    if outgoing.get('mailbox_owner_id') and str(outgoing['mailbox_owner_id']) != str(owner_id):
        return False
    if not outgoing.get('sent_at') or not incoming.get('sent_at') or outgoing['sent_at'] > incoming['sent_at']:
        return False
    counterparties = {normalize_email(email) for field in ('to_emails','cc_emails','bcc_emails') for email in outgoing.get(field,[])}
    counterparties.add(normalize_email(outgoing.get('recipient_email')))
    if not incoming.get('from_email') or normalize_email(incoming['from_email']) not in counterparties:
        return False
    snapshot = outgoing.get('personalization',{}).get('identity_snapshot',{})
    reply_addresses = {normalize_email(account),normalize_email(outgoing.get('from_email')),normalize_email(snapshot.get('reply_to'))}
    incoming_recipients = {normalize_email(email) for field in ('to_emails','cc_emails') for email in incoming.get(field,[])}
    if not (incoming_recipients - {None}) & (reply_addresses - {None}):
        return False
    ancestry = parse_message_ids(incoming.get('in_reply_to')) | parse_message_ids(incoming.get('rfc_references'))
    if outgoing.get('rfc_message_id') in ancestry:
        return True
    provider_headers = incoming.get('personalization',{}).get('provider_headers',{})
    provider_id = outgoing.get('provider_message_id')
    if provider_id and any(token[1:-1] == provider_id or token[1:-1].split('@',1)[0] == provider_id for token in ancestry):
        return True
    if provider_id and any(str(provider_headers.get(key,'')).strip().strip('<>') == provider_id for key in ('x-pm-message-id','x-postmark-message-id','postmark-message-id')):
        return True
    return bool(incoming.get('thread_id') and incoming['thread_id'] == outgoing.get('thread_id'))
