import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime,timedelta,timezone
from types import SimpleNamespace as NS
from uuid import uuid4
from unittest.mock import patch
import pytest
from rebattery_mail import draft,campaign,send,policy,followup
from rebattery_mail.core import connection,dict_cursor,Refused,UnknownOutcome,run
from rebattery_mail.digest import digest,load
from rebattery_mail.drivers import GmailSendDriver,PostmarkSendDriver,stream_suppressions,sync_suppressions


class Fake:
    def __init__(self):
        self.calls=[]
        self.suppressions={}
        self.failure=None
    def preflight(self,identity,message):
        return self.suppressions
    def send(self,identity,message):
        self.calls.append(message['id'])
        if self.failure:
            raise self.failure
        return {'provider_message_id':'fake-'+message['id']}
    def recover(self,identity,message):
        return {'provider_message_id':'fake-'+message['id']} if message['id'] in self.calls else None


@pytest.fixture
def env(db_after_cutover):
    prefix='send_'+uuid4().hex
    with connection() as db,db.cursor() as cur:
        for i in range(3):
            cur.execute("insert into crm_people(id,full_name,email,first_name) values (%s,'Synthetic',%s,'Buyer')",(prefix+str(i),prefix+str(i)+'@example.test'))
    yield prefix
    with connection() as db,db.cursor() as cur:
        cur.execute('delete from mail_approval where subject_id like %s',(prefix+'%',))
        cur.execute('delete from mail_followup where id like %s',(prefix+'%',))
        cur.execute('delete from mail_message_link where message_id in (select id from mail_message where campaign_id like %s or id like %s)',(prefix+'%',prefix+'%'))
        cur.execute('delete from mail_message where campaign_id like %s or id like %s',(prefix+'%',prefix+'%'))
        cur.execute('delete from campaigns where id like %s',(prefix+'%',))
        cur.execute('delete from mail_thread where id like %s',(prefix+'%',))
        cur.execute('delete from crm_people where id like %s',(prefix+'%',))


def one(prefix,thread=None):
    email=prefix+'0@example.test'
    with connection() as db:
        row,_=draft.prepare(db,'alex',[email],subject='Synthetic',body='Hello',verification={email:{'status':'valid','sub_status':'role_based'}},message_id=prefix+'message',thread=thread)
        draft.insert(db,row)
    return row


def approved(target):
    with connection(read_only=True) as db:
        _,rows=load(db,target)
    sha=digest(rows)
    send.approve(NS(target=target,sha256=sha,approved_by='Ari',expires_at=None,apply=True))
    return sha


def frozen(prefix):
    args=NS(identity='alex',purpose='personal',transport=None,template=None,vars='{}',subject='Hello {{name}}',body='Synthetic',html='',verification=__import__('json').dumps({prefix+str(i)+'@example.test':{'status':'valid'} for i in range(3)}),id=prefix+'campaign',name='Synthetic',person_ids=','.join(prefix+str(i) for i in range(3)),cohort_sql=None,links='[]',personalization='{"name":"first_name"}',listing_id=None,auction_url=None,type='intro',apply=True)
    campaign.create(args)
    campaign.freeze(NS(target=args.id,apply=True),Fake())
    return args.id,approved(args.id)


def state(target):
    with connection(read_only=True) as db:
        return load(db,target)[1][0]['state']


def test_exact_message_approval_duplicate_and_role_address(env):
    row=one(env)
    with pytest.raises(Refused,match='approval_missing'):
        send.execute(NS(target=row['id'],apply=True),Fake())
    approved(row['id'])
    fake=Fake()
    assert send.execute(NS(target=row['id'],apply=True),fake)['results'][0]['state']=='accepted'
    with pytest.raises(Refused,match='duplicate_idempotency_key'):
        send.execute(NS(target=row['id'],apply=True),fake)
    assert len(fake.calls)==1


def test_pilot_and_separate_remainder(env):
    target,sha=frozen(env)
    fake=Fake()
    result=send.launch(NS(target=target,approved_sha256=sha,max_recipients=1,apply=True),fake)
    assert result['next_gate']=='pilot_review' and len(fake.calls)==1
    send.launch(NS(target=target,approved_sha256=sha,max_recipients=None,apply=True),fake)
    assert len(fake.calls)==3 and len(set(fake.calls))==3


def test_unknown_exit_four_and_never_retry(env,capsys):
    row=one(env);approved(row['id'])
    fake=Fake();fake.failure=UnknownOutcome('lost_receipt')
    args=NS(target=row['id'],apply=True)
    assert run(lambda a:send.execute(a,fake),args)==4
    assert state(row['id'])=='unknown'
    with pytest.raises(Refused,match='audience_has_sending_or_unknown'):
        send.execute(args,fake)
    assert len(fake.calls)==1
    assert send.recover(NS(target=row['id'],apply=True),fake)['results'][0]['state']=='found'
    assert state(row['id'])=='accepted'


def test_accepted_write_failure(env):
    row=one(env);approved(row['id'])
    with patch.object(send,'record_acceptance',side_effect=RuntimeError('synthetic write fault')):
        with pytest.raises(UnknownOutcome,match='accepted_write_failed'):
            send.execute(NS(target=row['id'],apply=True),Fake())
    assert state(row['id'])=='unknown'
    with connection(read_only=True) as db,db.cursor() as cur:
        cur.execute("select count(*) from mail_event where message_id=%s and type='accepted_write_failed'",(row['id'],))
        assert cur.fetchone()[0]==1


def test_concurrent_launch_claims_once(env):
    target,sha=frozen(env)
    entered=threading.Event();release=threading.Event()
    class Blocking(Fake):
        def send(self,identity,message):
            entered.set();assert release.wait(5)
            return super().send(identity,message)
    fake=Blocking();args=NS(target=target,approved_sha256=sha,max_recipients=1,apply=True)
    with ThreadPoolExecutor(2) as pool:
        first=pool.submit(send.launch,args,fake)
        assert entered.wait(5)
        try:
            with pytest.raises(Refused,match='audience_has_sending_or_unknown'):
                send.launch(args,fake)
        finally:
            release.set()
        first.result()
    assert len(fake.calls)==1


@pytest.mark.parametrize('status',['sending','unknown'])
def test_campaign_uncertain_blocks_every_row(env,status):
    target,sha=frozen(env)
    with connection() as db,db.cursor() as cur:
        cur.execute('update mail_message set state=%s where id=(select id from mail_message where campaign_id=%s limit 1)',(status,target))
    with pytest.raises(Refused,match='audience_has_sending_or_unknown'):
        send.launch(NS(target=target,approved_sha256=sha,max_recipients=1,apply=True),Fake())


def test_suppression_added_after_claim(env):
    row=one(env);approved(row['id'])
    class NewSuppression(Fake):
        n=0
        def preflight(self,identity,message):
            self.n+=1
            return {} if self.n==1 else {row['recipient_email']:{'SuppressionReason':'HardBounce'}}
    fake=NewSuppression()
    with pytest.raises(Refused,match='recipient_suppressed'):
        send.execute(NS(target=row['id'],apply=True),fake)
    assert not fake.calls and state(row['id'])=='failed'


@pytest.mark.parametrize('rule,change',[('approval_digest_mismatch',{'sha256':'wrong'}),('approval_count_mismatch',{'recipient_count':2}),('approval_identity_mismatch',{'identity_key':'ari'}),('approval_revoked',{'revoked_at':datetime.now(timezone.utc)}),('approval_expired',{'expires_at':datetime.now(timezone.utc)-timedelta(seconds=1)}),('approval_stale',{'approved_at':datetime.now(timezone.utc)-timedelta(days=1)})])
def test_approval_rules(rule,change):
    now=datetime.now(timezone.utc)
    row={'sha256':'exact','recipient_count':1,'identity_key':'alex','approved_at':now,**change}
    with pytest.raises(Refused,match=rule):
        policy.approval(row,'exact',1,'alex',now-timedelta(seconds=1))


@pytest.mark.parametrize('name',['',' ','agent','CLAUDE','mailvin','hermes','auto','self','Ari agent'])
def test_named_human_only(name):
    with pytest.raises(Refused):policy.human(name)


def test_wrong_digest_and_changed_recipients(env):
    target,sha=frozen(env)
    with pytest.raises(Refused,match='approval_digest_mismatch'):
        send.approve(NS(target=target,sha256='wrong',approved_by='Ari',expires_at=None,apply=True))
    with connection() as db,db.cursor() as cur:
        cur.execute('update campaigns set audience_size=4 where id=%s',(target,))
    with pytest.raises(Refused,match='approval_stale'):
        send.approve(NS(target=target,sha256=sha,approved_by='Ari',expires_at=None,apply=True))


@pytest.mark.parametrize('transport',['gmail','postmark-broadcast'])
def test_marketing_requires_unsubscribe(transport):
    with pytest.raises(Refused,match='marketing_requires_unsubscribe'):
        policy.content({'purpose':'marketing','transport':transport,'body_text':'Promotion','body_html':'Promotion'})


def test_missing_variables_literal_tokens_purpose(env):
    with connection(read_only=True) as db:
        with pytest.raises(Refused,match='missing_variable'):
            draft.prepare(db,'alex',['info@example.test'],subject='{{name}}',body='Hi')
        with pytest.raises(Refused,match='literal_merge_token'):
            draft.prepare(db,'alex',['info@example.test'],subject='Hi',body='{{ bad token }}')
    with connection() as db,db.cursor() as cur:
        cur.execute("update mail_identity set allowed_purposes=array['personal'] where key='alex'")
        try:
            with pytest.raises(Refused,match='purpose_not_allowed_for_identity'):
                policy.identity(db,'alex','marketing')
        finally:
            cur.execute("update mail_identity set allowed_purposes=array['personal','marketing','transactional'] where key='alex'")


@pytest.mark.parametrize('kind,rule',[('optout','recipient_opted_out'),('bounce','recipient_bounced'),('suppressed','recipient_suppressed'),('invalid','recipient_unverified'),('unknown','recipient_unverified')])
def test_recipient_rules(env,kind,rule):
    row=one(env);email=row['recipient_email']
    with connection() as db,db.cursor() as cur:
        if kind=='optout':cur.execute('update crm_people set email_opted_out=true where id=%s',(env+'0',))
        if kind in ('bounce','suppressed'):cur.execute("insert into mail_event(message_id,type,source,occurred_at) values (%s,%s,'cli',now())",(row['id'],'bounced' if kind=='bounce' else kind))
    with connection(read_only=True) as db:
        with pytest.raises(Refused,match=rule):policy.recipient(db,email,{email:{'status':kind if kind in ('invalid','unknown') else 'valid'}})


def test_followup_reply_pauses(env):
    with connection() as db,db.cursor() as cur:
        cur.execute('insert into mail_thread(id) values (%s)',(env+'thread',))
    row=one(env)
    with connection() as db,db.cursor() as cur:
        cur.execute('update mail_message set thread_id=%s where id=%s',(env+'thread',row['id']))
        cur.execute("insert into mail_followup(id,message_id,thread_id,identity_key,due_at,origin) values (%s,%s,%s,'alex',now(),'commitment')",(env+'follow',row['id'],env+'thread'))
        cur.execute("insert into mail_message(id,direction,transport,thread_id,state,from_email) values (%s,'inbound','gmail',%s,'received',%s)",(env+'reply',env+'thread',row['recipient_email']))
    with pytest.raises(Refused,match='thread_has_reply'):
        followup.manage(NS(action='draft',target=env+'follow',apply=True,template=None,vars='{}',subject=None,body='Chase',html=None),Fake())
    with connection(read_only=True) as db,db.cursor() as cur:
        cur.execute('select state,paused_reason from mail_followup where id=%s',(env+'follow',))
        assert cur.fetchone()==('paused','thread_has_reply')


def test_dry_run_has_no_claim_or_approval(env):
    row=one(env)
    args=NS(target=row['id'],sha256=digest([row]),approved_by='Ari',expires_at=None,apply=False)
    send.approve(args)
    with connection(read_only=True) as db:
        assert send.approval_row(db,row['id']) is None
    approved(row['id'])
    assert send.execute(NS(target=row['id'],apply=False),Fake())['dry_run']
    assert state(row['id'])=='draft'


def test_real_drivers_require_live_gate(monkeypatch):
    monkeypatch.delenv('DENCH_MAIL_LIVE_SEND',raising=False)
    for driver in (GmailSendDriver(),PostmarkSendDriver()):
        with pytest.raises(Refused,match='live_send_disabled'):driver.send({}, {})


def test_tracked_links_and_optional_auction():
    row={'body_html':'<a href="https://www.rebattery.io/stock">Stock</a>','body_text':'https://www.rebattery.io/stock'}
    campaign.validate_links(row,[{'key':'stock','url':'https://www.rebattery.io/stock'}])
    with pytest.raises(Refused,match='tracked_link_parity'):campaign.validate_links(row,[])
    with pytest.raises(Refused,match='unapproved_destination_host'):campaign.validate_links(row,[{'key':'bad','url':'https://evil.test/a'}])


def test_incomplete_suppression_fails_closed():
    for dump in ({},{'Suppressions':[{}]}):
        def client(path):
            return dump if path.endswith('/dump') else {'MessageStreamType':'Broadcasts','SubscriptionManagementConfiguration':{'UnsubscribeHandlingType':'Postmark'}}
        with pytest.raises(Exception,match='incomplete_suppression'):stream_suppressions('broadcast',client)


def test_suppression_mapping_idempotence_and_absence_never_restores(env):
    def client(path):
        if not path.endswith('/dump'):
            return {'MessageStreamType':'Broadcasts','SubscriptionManagementConfiguration':{'UnsubscribeHandlingType':'Postmark'}}
        return {'Suppressions':[{'EmailAddress':env+str(i)+'@example.test','SuppressionReason':reason,'Origin':'Recipient','CreatedAt':'2026-10-01T23:30:00-05:00'} for i,reason in enumerate(('ManualSuppression','SpamComplaint','HardBounce'))]}
    suppressions=stream_suppressions('broadcast',client)
    assert len(sync_suppressions('broadcast',suppressions,False))==3
    with connection(read_only=True) as db,db.cursor() as cur:
        cur.execute('select count(*) from crm_subscriptions where person_id like %s',(env+'%',))
        assert cur.fetchone()[0]==0
    for _ in range(2):
        sync_suppressions('broadcast',suppressions,True)
    sync_suppressions('broadcast',{},True)
    with connection(read_only=True) as db,dict_cursor(db) as cur:
        cur.execute('select p.id,p.email_opted_out,s.status,s.since,s.how from crm_people p join crm_subscriptions s on s.person_id=p.id where p.id like %s order by p.id',(env+'%',))
        rows=cur.fetchall()
        assert len(rows)==3
        assert [bool(r['email_opted_out']) for r in rows]==[False,True,True]
        assert all(r['status']=='Opted out' and str(r['since'])=='2026-10-01' and 'origin=Recipient' in r['how'] for r in rows)


def test_duplicate_draft_request_is_named_refusal(env):
    row=one(env)
    with connection() as db:
        with pytest.raises(Refused,match='duplicate_idempotency_key'):
            draft.insert(db,row)


def test_identity_snapshot_change_blocks_before_submission(env):
    row=one(env);approved(row['id'])
    with connection() as db,db.cursor() as cur:
        cur.execute("update mail_identity set reply_to='synthetic@example.test' where key='alex'")
    try:
        fake=Fake()
        with pytest.raises(Refused,match='approval_identity_mismatch'):
            send.execute(NS(target=row['id'],apply=True),fake)
        assert not fake.calls
    finally:
        with connection() as db,db.cursor() as cur:
            cur.execute("update mail_identity set reply_to=null where key='alex'")


def test_definite_provider_failure_is_failed(env):
    from rebattery_mail.core import ProviderError
    row=one(env);approved(row['id'])
    fake=Fake();fake.failure=ProviderError('postmark_rejected')
    with pytest.raises(ProviderError,match='postmark_rejected'):
        send.execute(NS(target=row['id'],apply=True),fake)
    assert state(row['id'])=='failed'


def test_no_send_flag_blocks_gmail_before_refresh():
    with pytest.raises(Refused,match='live_send_disabled'):
        GmailSendDriver(gmail_no_send=True).preflight({}, {})


def test_stream_type_and_missing_unsubscribe_configuration():
    def client(path):
        return {'MessageStreamType':'Transactional'}
    with pytest.raises(Refused,match='postmark_stream_type_mismatch'):
        PostmarkSendDriver(client).preflight({'postmark_stream':'custom'}, {'purpose':'marketing'})


def test_duplicate_claim_is_atomic(env):
    row=one(env)
    send.claim(row)
    with pytest.raises(Refused,match='duplicate_idempotency_key'):
        send.claim(row)


def test_freeze_dry_run_and_exclusions(env):
    import json
    target,_=frozen(env)
    with connection() as db,db.cursor() as cur:
        cur.execute('delete from mail_approval where subject_id=%s',(target,))
        cur.execute('delete from mail_message where campaign_id=%s',(target,))
        cur.execute("update campaigns set mail_state='draft',frozen_at=null where id=%s",(target,))
        cur.execute('select notes from campaigns where id=%s',(target,))
        notes=json.loads(cur.fetchone()[0])
        notes['mail_config']['verification'][env+'1@example.test']={'status':'invalid','sub_status':'mailbox_not_found'}
        notes['mail_config']['verification'][env+'2@example.test']={'status':'unknown','sub_status':'greylisted'}
        cur.execute('update campaigns set notes=%s where id=%s',(json.dumps(notes),target))
    result=campaign.freeze(NS(target=target,apply=False),Fake())
    assert len(result['messages'])==1
    assert {e['verification_status'] for e in result['exclusions']}=={'invalid','unknown'}
    with connection(read_only=True) as db,db.cursor() as cur:
        cur.execute('select count(*) from mail_message where campaign_id=%s',(target,))
        assert cur.fetchone()[0]==0
        cur.execute('select mail_state from campaigns where id=%s',(target,))
        assert cur.fetchone()[0]=='draft'


def test_cohort_sql_rejects_mutation(env,tmp_path):
    path=tmp_path/'cohort.sql'
    path.write_text("delete from crm_people returning id as person_id")
    with connection(read_only=True) as db:
        with pytest.raises(Refused,match='cohort_requires_read_only_select'):
            campaign.cohort(db,{'cohort_sql':str(path)})


def test_threaded_draft_binds_rfc_headers_and_gmail_anchor(env):
    with connection() as db,db.cursor() as cur:
        cur.execute('insert into mail_thread(id,gmail_thread_id) values (%s,%s)',(env+'thread','gmail-thread'))
        cur.execute("""insert into mail_message(id,direction,transport,thread_id,state,from_email,gmail_message_id,rfc_message_id,rfc_references)
            values (%s,'inbound','gmail',%s,'received',%s,'gmail-anchor','<anchor@example.test>','<root@example.test>')""",(env+'inbound',env+'thread',env+'0@example.test'))
        row,_=draft.prepare(db,'alex',[env+'0@example.test'],subject='Re: Synthetic',body='Reply',thread=env+'thread',message_id=env+'reply-draft')
        assert row['in_reply_to']=='<anchor@example.test>'
        assert row['rfc_references']=='<root@example.test> <anchor@example.test>'
        assert row['personalization']['reply_gmail_message_id']=='gmail-anchor'
    calls=[]
    def runner(args,**kwargs):
        calls.append(args)
        return NS(returncode=0,stdout='{"id":"fake-gmail-receipt"}')
    row['gmail_thread_id']='gmail-thread'
    with patch('rebattery_mail.drivers.live_gate'):
        receipt=GmailSendDriver(runner).send({'gmail_account':'alex@rebattery.io','address':'alex@rebattery.io'},row)
    assert receipt['gmail_message_id']=='fake-gmail-receipt'
    assert calls[0][calls[0].index('--reply-to-message-id')+1]=='gmail-anchor'
    assert calls[0][calls[0].index('--thread-id')+1]=='gmail-thread'
