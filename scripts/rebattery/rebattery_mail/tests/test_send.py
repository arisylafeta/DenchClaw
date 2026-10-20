import json
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
    def refresh_replies(self,identity,message):
        return None
    def send(self,identity,message):
        self.calls.append(message['id'])
        if self.failure:
            raise self.failure
        return {'provider_message_id':'fake-'+message['id']}
    def recover(self,identity,message):
        return {'provider_message_id':'fake-'+message['id']} if message['id'] in self.calls else None


@pytest.fixture(autouse=True)
def fake_execution_gate(monkeypatch):
    # Tests inject fake providers; never enable the environment's real-send gate.
    monkeypatch.setattr(send,'live_gate',lambda: None,raising=False)


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


def approved(target,scope='full'):
    with connection(read_only=True) as db:
        _,rows=load(db,target)
    sha=digest(rows)
    send.approve(NS(target=target,sha256=sha,approved_by='Ari',expires_at=None,scope=scope,apply=True))
    return sha


def frozen(prefix,**content):
    args=NS(identity='alex',purpose='personal',transport=None,template=None,vars='{}',subject='Hello {{name}}',body='Synthetic',html='',verification=__import__('json').dumps({prefix+str(i)+'@example.test':{'status':'valid'} for i in range(3)}),id=prefix+'campaign',name='Synthetic',person_ids=','.join(prefix+str(i) for i in range(3)),cohort_sql=None,links='[]',personalization='{"name":"first_name"}',listing_id=None,auction_url=None,type='correspondence',apply=True)
    vars(args).update(content)
    campaign.create(args)
    campaign.freeze(NS(target=args.id,apply=True),Fake())
    return args.id,approved(args.id)


def state(target):
    with connection(read_only=True) as db:
        return load(db,target)[1][0]['state']


def test_live_cohort_select_function_cannot_write(env, tmp_path):
    """Retain live CLI's transaction-level guard, not just the SELECT prefix check."""
    import psycopg2
    sql_file = tmp_path / 'cohort.sql'
    with connection() as db, db.cursor() as cur:
        cur.execute("""create function mail_test_writable_cohort() returns text language plpgsql as $$
          begin update crm_people set first_name='Changed' where id=current_setting('mail.test_person',true);
          return 'unused'; end $$""")
    sql_file.write_text('select mail_test_writable_cohort() as person_id')
    try:
        with connection() as db:
            with pytest.raises(psycopg2.errors.ReadOnlySqlTransaction):
                campaign.cohort(db, {'person_ids': None, 'cohort_sql': str(sql_file)})
        with connection(read_only=True) as db, db.cursor() as cur:
            cur.execute('select first_name from crm_people where id=%s', (env+'0',))
            assert cur.fetchone()[0] == 'Buyer'
    finally:
        with connection() as db, db.cursor() as cur:
            cur.execute('drop function mail_test_writable_cohort()')


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
    with pytest.raises(Refused) as refusal:
        send.launch(NS(target=target,approved_sha256=sha,max_recipients=None,apply=True),fake)
    assert refusal.value.rule=='approval_stale'
    approved(target,scope='full')
    with connection(read_only=True) as db:
        assert send.approval_row(db,target)['recipient_count']==2
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
    assert '--thread-id' not in calls[0]  # gog rejects both flags together; the anchor already implies the thread


def test_review_1_pilot_scope_requires_cap(env):
    target,sha=frozen(env)
    approved(target,scope='pilot')
    fake=Fake()
    with pytest.raises(Refused,match='pilot_cap_required'):
        send.launch(NS(target=target,approved_sha256=sha,max_recipients=None,apply=True),fake)
    assert fake.calls==[]


@pytest.mark.parametrize('mutation,rule',[
    ("expires_at=now()-interval '1 second'",'approval_expired'),
    ("revoked_at=now()",'approval_revoked'),
    ("sha256='tampered'",'approval_digest_mismatch'),
    ("recipient_count=9",'approval_count_mismatch'),
    ("identity_key='ari'",'approval_identity_mismatch')])
def test_review_2_revalidate_after_postclaim_preflight(env,mutation,rule):
    row=one(env);approved(row['id'])
    class ChangesApproval(Fake):
        n=0
        def preflight(self,identity,message):
            self.n+=1
            if self.n==2:
                with connection() as db,db.cursor() as cur:
                    cur.execute('update mail_approval set '+mutation+' where subject_id=%s',(row['id'],))
            return {}
    fake=ChangesApproval()
    with pytest.raises(Refused,match=rule):
        send.execute(NS(target=row['id'],apply=True),fake)
    assert fake.calls==[] and state(row['id'])=='failed'


def test_review_3_campaign_member_cannot_bypass_flow(env):
    target,_=frozen(env)
    with connection(read_only=True) as db:
        member=load(db,target)[1][0]
    with pytest.raises(Refused,match='campaign_member_requires_campaign_flow'):
        approved(member['id'])
    with pytest.raises(Refused,match='campaign_member_requires_campaign_flow'):
        send.execute(NS(target=member['id'],apply=True),Fake())


def test_review_4_link_digest_survives_database_order(env):
    row=one(env)
    links=[{'cta_key':'z','destination_url':'https://www.rebattery.io/z','listing_id':None},
           {'cta_key':'a','destination_url':'https://www.rebattery.io/a','listing_id':None}]
    row['links']=links
    with connection() as db,db.cursor() as cur:
        for link in links:
            cur.execute('insert into mail_message_link(id,message_id,cta_key,destination_url) values (%s,%s,%s,%s)',(uuid4().hex,row['id'],link['cta_key'],link['destination_url']))
    with connection(read_only=True) as db:
        assert digest([row])==digest(load(db,row['id'])[1])


def followup_for(prefix,row):
    with connection() as db,db.cursor() as cur:
        cur.execute("insert into mail_followup(id,message_id,identity_key,due_at,origin) values (%s,%s,'alex',now(),'commitment')",(prefix+'follow',row['id']))
    return NS(action='draft',target=prefix+'follow',apply=True,template=None,vars='{}',subject=None,body='Synthetic chase',html=None)


def test_review_6_followup_refresh_holds_no_row_lock(env):
    row=one(env)
    args=followup_for(env,row)
    class ReplyRefresh(Fake):
        def refresh_replies(self,identity,message):
            with connection() as db,db.cursor() as cur:
                cur.execute("set local lock_timeout='100ms'")
                cur.execute("update mail_followup set state='paused',paused_reason='thread_has_reply' where id=%s",(args.target,))
        def preflight(self,identity,message):
            self.refresh_replies(identity,message)
            return {}
    with pytest.raises(Refused,match='thread_has_reply'):
        followup.manage(args,ReplyRefresh())


@pytest.mark.parametrize('transport',['gmail','postmark-transactional'])
def test_review_7_shared_refresh_without_thread(env,transport):
    with connection() as db,db.cursor() as cur:
        cur.execute("update mail_identity set postmark_stream='outbound' where key='alex'")
    try:
        with connection() as db:
            email=env+'0@example.test'
            row,_=draft.prepare(db,'alex',[email],subject='Synthetic',body='Hi',transport=transport,verification={email:{'status':'valid'}},message_id=env+'message')
            draft.insert(db,row)
        approved(row['id'])
        class FindsReply(Fake):
            def refresh_replies(self,identity,message):
                assert message.get('thread_id') is None
                with connection() as db,db.cursor() as cur:
                    cur.execute('update mail_message set replied_at=now() where id=%s',(message['id'],))
        fake=FindsReply()
        with pytest.raises(Refused,match='thread_has_reply'):
            send.execute(NS(target=row['id'],apply=True),fake)
        assert fake.calls==[]
    finally:
        with connection() as db,db.cursor() as cur:
            cur.execute("update mail_identity set postmark_stream=null where key='alex'")


@pytest.mark.parametrize('purpose',['personal','transactional'])
def test_review_9_promotional_campaign_type_requires_marketing(env,purpose):
    args=NS(identity='supply',purpose=purpose,transport=None,template=None,vars='{}',subject='Promotion',body='Promotion',html='',verification='{}',id=env+'campaign',name='October',person_ids=env+'0',cohort_sql=None,links='[]',personalization='{}',listing_id=None,auction_url=None,type='supply_update',apply=True)
    with pytest.raises(Refused) as refusal:
        campaign.create(args)
    assert refusal.value.rule=='campaign_purpose_mismatch'


def test_review_12_html_unsubscribe_required():
    with pytest.raises(Refused,match='marketing_requires_unsubscribe'):
        policy.content({'purpose':'marketing','transport':'gmail','body_text':'Unsubscribe: mailto:remove@example.test','body_html':'<p>Promotion</p>'})


def test_review_13_gate_precedes_claim(env,monkeypatch):
    from rebattery_mail.drivers import live_gate
    monkeypatch.setattr(send,'live_gate',live_gate,raising=False)
    monkeypatch.delenv('DENCH_MAIL_LIVE_SEND',raising=False)
    row=one(env);approved(row['id'])
    with pytest.raises(Refused,match='live_send_disabled'):
        send.execute(NS(target=row['id'],apply=True),GmailSendDriver())
    with connection(read_only=True) as db:
        stored=load(db,row['id'])[1][0]
        assert stored['state']=='draft' and stored['idempotency_key'] is None


def test_review_14_provider_read_failure_releases_claim(env):
    from rebattery_mail.core import ProviderError
    row=one(env);approved(row['id'])
    class ReadFailure(Fake):
        n=0
        def preflight(self,identity,message):
            self.n+=1
            if self.n==2:raise ProviderError('synthetic_read_failure')
            return {}
    fake=ReadFailure()
    with pytest.raises(ProviderError,match='synthetic_read_failure'):
        send.execute(NS(target=row['id'],apply=True),fake)
    with connection(read_only=True) as db:
        stored=load(db,row['id'])[1][0]
        assert stored['state']=='failed'
        assert stored['personalization']['send_failure']['reason']=='preflight_error'
    assert fake.calls==[]


def test_review_15_saved_gmail_receipt_recovers_original(env):
    row=one(env);approved(row['id'])
    class AcceptedGmail(Fake):
        def send(self,identity,message):
            return {'gmail_message_id':'saved-gmail-id','provider_message_id':None}
    with patch.object(send,'record_acceptance',side_effect=RuntimeError('synthetic local write')):
        with pytest.raises(UnknownOutcome):
            send.execute(NS(target=row['id'],apply=True),AcceptedGmail())
    class Reader:
        def fetch(self,account,message_id):
            assert account=='alex@rebattery.io' and message_id=='saved-gmail-id'
            return {'message':{'id':message_id,'threadId':'recovered-thread','labelIds':['SENT']},
                    'headers':{'From':'alex@rebattery.io','To':row['recipient_email'],'Subject':'Synthetic'}}
    result=send.recover(NS(target=row['id'],apply=True),GmailSendDriver(reader=Reader()))
    assert result['results'][0]['state']=='found'
    with connection(read_only=True) as db:
        stored=load(db,row['id'])[1][0]
        assert stored['state']=='accepted' and stored['gmail_message_id']=='saved-gmail-id'


def test_review_16_recover_exact_recipient_set():
    message={'id':'synthetic','to_emails':['a@example.test','b@example.test'],'recipient_email':None}
    def client(path):
        return {'Messages':[{'MessageID':'receipt','Metadata':{'recipient_id':'synthetic'},'Recipients':['b@example.test','a@example.test']}]}
    assert PostmarkSendDriver(client).recover({'postmark_stream':'broadcast'},message)['provider_message_id']=='receipt'
    message['to_emails']=['a@example.test']
    assert PostmarkSendDriver(client).recover({'postmark_stream':'broadcast'},message) is None


def test_review_17_gmail_cannot_send_postmark_tokens():
    with pytest.raises(Refused,match='literal_merge_token'):
        policy.content({'purpose':'personal','transport':'gmail','body_text':'{{{ pm:unsubscribe }}}'})


@pytest.mark.parametrize('name',['mailvin_bot','hermes_agent','Ari_agent','claude-bot'])
def test_review_18_agent_name_separators(name):
    with pytest.raises(Refused,match='approval_invalid_approver'):policy.human(name)


def test_review_19_gmail_forwards_reply_to():
    calls=[]
    def runner(args,**kwargs):
        calls.append(args)
        return NS(returncode=0,stdout='{"id":"receipt"}')
    with patch('rebattery_mail.drivers.live_gate'):
        GmailSendDriver(runner).send({'gmail_account':'alex@rebattery.io','address':'alex@rebattery.io','reply_to':'supply@rebattery.io'},
                                    {'to_emails':['buyer@example.test'],'subject':'Synthetic','body_text':'Hi'})
    assert calls[0][calls[0].index('--reply-to')+1]=='supply@rebattery.io'


def test_review_20_supply_update_identifier_requires_supply(env):
    args=NS(identity='alex',purpose='marketing',transport=None,template=None,vars='{}',subject='Hi',body='Hi',html='',verification='{}',id='supply-update-'+env,name='October',person_ids=env+'0',cohort_sql=None,links='[]',personalization='{}',listing_id=None,auction_url=None,type='correspondence',apply=False)
    with pytest.raises(Refused,match='supply_update_identity_required'):campaign.create(args)


def test_review_21_followup_preserves_explicit_transport(env):
    with connection() as db,db.cursor() as cur:
        cur.execute("update mail_identity set postmark_stream='broadcast' where key='alex'")
    try:
        with connection() as db:
            email=env+'0@example.test'
            row,_=draft.prepare(db,'alex',[email],subject='Synthetic',body='Hi',transport='gmail',verification={email:{'status':'valid'}},message_id=env+'message')
            draft.insert(db,row)
            with db.cursor() as cur:
                cur.execute("update mail_message set state='accepted',gmail_message_id=%s,rfc_message_id=%s where id=%s",(env+'gmail','<'+env+'@example.test>',row['id']))
        result=followup.manage(followup_for(env,row),Fake())
        assert result['message']['transport']=='gmail'
    finally:
        with connection() as db,db.cursor() as cur:
            cur.execute("update mail_identity set postmark_stream=null where key='alex'")


def test_review_5_provider_metadata_does_not_change_approval_digest(env):
    row=one(env)
    approved_sha=digest([row])
    observed={**row,'thread_id':'provider-thread','rfc_message_id':'<provider@example.test>','in_reply_to':'<parent@example.test>','rfc_references':'<ancestor@example.test>','gmail_message_id':'provider-id'}
    observed['personalization']={**row['personalization'],'provider_observation':'not approved copy'}
    assert digest([observed])==approved_sha
    assert digest([{**observed,'body_text':'Changed approved body'}])!=approved_sha


@pytest.mark.parametrize('marker',[
    {'name':'Supply Update: October'},
    {'name':'SUPPLY_update October'},
    {'name':'supply-update October'},
    {'id':'supply-update'},
    {'id':'SUPPLY-UPDATE20261008'},
    {'type':'supply_update'},
])
@pytest.mark.parametrize('author',[
    {'address':'alex@rebattery.io','reply_to':'supply@rebattery.io'},
    {'address':'supply@rebattery.io','reply_to':'alex@rebattery.io'},
    {'address':'alex@rebattery.io','reply_to':None},
])
def test_supply_update_markers_independently_pin_sender_and_reply_to(marker,author):
    config={'id':'october','name':'October','type':'correspondence','purpose':'marketing',**marker}
    with pytest.raises(Refused,match='supply_update_identity_required'):
        campaign.campaign_policy(config,author)
    for reply_to in ('supply@rebattery.io',None):
        campaign.campaign_policy(config,{'address':'supply@rebattery.io','reply_to':reply_to})


def test_founder_intro_keeps_own_mailbox():
    campaign.campaign_policy({'id':'founder-intro','name':'Founder intro','type':'intro','purpose':'marketing'},
                             {'address':'alex@rebattery.io','reply_to':'alex@rebattery.io'})


def test_bounded_launch_uses_recipient_email_order_not_message_hash(env):
    target,sha=frozen(env)
    with connection(read_only=True) as db:
        rows=load(db,target)[1]
    # Deliberately reverse the loader order: neither hashed IDs nor database
    # collation should select the pilot's recipients.
    shuffled=sorted(rows,key=lambda row:row['recipient_email'],reverse=True)
    fake=Fake()
    with patch.object(send,'check',return_value=(
            {'id':target,'mail_state':'approved'},shuffled,sha)):
        result=send.launch(NS(target=target,approved_sha256=sha,max_recipients=2,apply=False),fake)
    expected=sorted(rows,key=lambda row:row['recipient_email'])[:2]
    assert result['message_ids']==[row['id'] for row in expected]
    assert not fake.calls


@pytest.mark.parametrize('apply',[False,True])
def test_suppression_only_sync_never_reads_or_changes_receipts(env,apply):
    from rebattery_mail.sync import sync_postmark_suppressions
    target,_=frozen(env)
    with connection() as db,db.cursor() as cur:
        cur.execute("""update mail_message set state='accepted',provider_message_id=id,
            delivered_at='2026-10-01T12:00:00Z',last_synced_at='2026-10-01T13:00:00Z'
            where campaign_id=%s""",(target,))
    with connection(read_only=True) as db,dict_cursor(db) as cur:
        cur.execute('select * from mail_message where campaign_id=%s order by id',(target,))
        before=[dict(row) for row in cur.fetchall()]
    calls=[]
    class Client:
        def request(self,path):
            calls.append(path)
            if path=='/message-streams/broadcast':
                return {'MessageStreamType':'Broadcasts','SubscriptionManagementConfiguration':{'UnsubscribeHandlingType':'Postmark'}}
            assert path=='/message-streams/broadcast/suppressions/dump'
            return {'Suppressions':[{'EmailAddress':env+'0@example.test','SuppressionReason':'HardBounce',
                                     'Origin':'Recipient','CreatedAt':'2026-10-01T23:30:00-05:00'}]}
    with connection(read_only=not apply) as db:
        result=sync_postmark_suppressions(db,'broadcast',apply,Client())
    assert calls==['/message-streams/broadcast','/message-streams/broadcast/suppressions/dump']
    assert result['dry_run'] is not apply
    assert result['stream']=='broadcast' and result['list']=='Supply update'
    assert result['suppressions'][0]['global_opt_out'] is True
    with connection(read_only=True) as db,dict_cursor(db) as cur:
        cur.execute('select * from mail_message where campaign_id=%s order by id',(target,))
        assert [dict(row) for row in cur.fetchall()]==before
        cur.execute("select status,since from crm_subscriptions where person_id=%s and list='Supply update'",(env+'0',))
        subscription=cur.fetchone()
        assert bool(subscription) is apply
        if apply:
            assert subscription['status']=='Opted out' and str(subscription['since'])=='2026-10-01'
        cur.execute('select email_opted_out from crm_people where id=%s',(env+'0',))
        assert bool(cur.fetchone()['email_opted_out']) is apply


@pytest.mark.parametrize('stream',['','outbound'])
def test_suppression_only_sync_requires_explicit_broadcast_stream(stream):
    from rebattery_mail.sync import sync_postmark_suppressions
    with pytest.raises(Refused,match='postmark_broadcast_stream_required'):
        sync_postmark_suppressions(None,stream)


def test_suppression_only_sync_rejects_transactional_stream_before_writes():
    from rebattery_mail.sync import sync_postmark_suppressions
    class Client:
        def request(self,path):
            assert path=='/message-streams/custom'
            return {'MessageStreamType':'Transactional'}
    with pytest.raises(Refused,match='postmark_stream_type_mismatch'):
        sync_postmark_suppressions(None,'custom',True,Client())


def test_frozen_personalization_is_escaped_bound_and_not_rerendered_at_send(env):
    with connection() as db,db.cursor() as cur:
        cur.execute('update crm_people set first_name=%s where id like %s',('<Buyer & Co>',env+'%'))
    target,sha=frozen(env,subject='{{name}}: {{stock}}',body='Hello {{name}}: {{stock}}',
                      html='<p>Hello {{name}}: {{stock}}</p>',vars='{"stock":"Modules & packs"}')
    with connection(read_only=True) as db:
        rows=load(db,target)[1]
    assert all(row['subject']=='<Buyer & Co>: Modules & packs' for row in rows)
    assert all('Hello <Buyer & Co>: Modules & packs' in row['body_text'] for row in rows)
    assert all('<p>Hello &lt;Buyer &amp; Co&gt;: Modules &amp; packs</p>' in row['body_html'] for row in rows)
    assert digest(rows)==sha
    changed=[{**rows[0],'body_html':'Changed'},*rows[1:]]
    assert digest(changed)!=sha
    with connection() as db,db.cursor() as cur:
        cur.execute("update crm_people set first_name='Changed after approval' where id like %s",(env+'%',))
    class Capture(Fake):
        sent=[]
        def send(self,identity,message):
            self.sent.append(message)
            return super().send(identity,message)
    fake=Capture()
    send.launch(NS(target=target,approved_sha256=sha,max_recipients=1,apply=True),fake)
    assert len(fake.sent)==1
    assert fake.sent[0]['subject']=='<Buyer & Co>: Modules & packs'
    assert '<p>Hello &lt;Buyer &amp; Co&gt;: Modules &amp; packs</p>' in fake.sent[0]['body_html']


def test_missing_personalization_stops_before_any_frozen_messages(env):
    with connection() as db,db.cursor() as cur:
        cur.execute('update crm_people set first_name=null where id=%s',(env+'1',))
    with pytest.raises(Refused,match='missing_variable'):
        frozen(env)
    with connection(read_only=True) as db,db.cursor() as cur:
        cur.execute('select count(*) from mail_message where campaign_id=%s',(env+'campaign',))
        assert cur.fetchone()[0]==0


@pytest.mark.parametrize('dump',[{}, {'Suppressions':None}, {'Suppressions':[{}]}])
def test_suppression_only_incomplete_dump_stops_before_database_writes(dump):
    from rebattery_mail import sync
    from rebattery_mail.core import ProviderError
    class Client:
        def request(self,path):
            if path.endswith('/dump'):
                return dump
            return {'MessageStreamType':'Broadcasts','SubscriptionManagementConfiguration':{'UnsubscribeHandlingType':'Postmark'}}
    with patch('rebattery_mail.drivers.sync_suppressions') as reconcile:
        with pytest.raises(ProviderError,match='incomplete_suppression'):
            sync.sync_postmark_suppressions(None,'broadcast',True,Client())
        reconcile.assert_not_called()


def test_suppression_only_cli_defaults_to_dry_run_and_requires_stream():
    import argparse
    from rebattery_mail import sync
    parser=argparse.ArgumentParser()
    sync.register(parser.add_subparsers(dest='command',required=True))
    args=parser.parse_args(['sync','postmark-suppressions','--stream','broadcast'])
    assert args.provider=='postmark-suppressions' and args.stream=='broadcast'
    assert args.apply is False and args.handler is sync.handle
    with pytest.raises(SystemExit):
        parser.parse_args(['sync','postmark-suppressions'])


# --- one-command send, draft edit, catch-all, gog environment ---

def test_catch_all_sends_with_a_note_and_other_unverified_still_blocks(env):
    row=one(env);email=row['recipient_email']
    with connection(read_only=True) as db:
        for evidence in ({'status':'do_not_mail','sub_status':'role_based_catch_all'},{'status':'catch-all'}):
            assert policy.recipient(db,email,{email:evidence})==email
            assert 'catch-all' in policy.verification_note(evidence)
        for evidence in ({'status':'invalid'},{'status':'do_not_mail','sub_status':'disposable'},{'status':'invalid','sub_status':'not_catch_all'},{'status':'unknown','sub_status':'catch_all_check_failed'},{}):
            with pytest.raises(Refused,match='recipient_unverified'):policy.recipient(db,email,{email:evidence})
        override={'status':'unknown','override_by':'Ari'}
        assert policy.recipient(db,email,{email:override})==email
        assert 'override' in policy.verification_note(override)
    assert policy.verification_note({'status':'valid'}) is None


def test_send_without_approver_is_a_dry_run_and_with_one_sends(env):
    row=one(env)
    fake=Fake()
    dry=send.send_message(NS(target=row['id'],apply=False,approved_by=None),fake)
    assert dry['dry_run'] is True and not fake.calls
    result=send.send_message(NS(target=row['id'],apply=False,approved_by='Ari'),fake)
    assert result['results'][0]['state']=='accepted' and result['approved_by']=='Ari' and fake.calls==[row['id']]
    with pytest.raises(Refused,match='duplicate_idempotency_key'):
        send.send_message(NS(target=row['id'],apply=False,approved_by='Ari'),fake)
    assert len(fake.calls)==1


@pytest.mark.parametrize('name',['agent','mailvin'])
def test_send_refuses_agent_as_approver(env,name):
    row=one(env);fake=Fake()
    with pytest.raises(Refused,match='approval_invalid_approver'):
        send.send_message(NS(target=row['id'],apply=False,approved_by=name),fake)
    assert not fake.calls


def test_send_notes_catch_all(env):
    email=env+'0@example.test'
    with connection() as db:
        row,_=draft.prepare(db,'alex',[email],subject='Synthetic',body='Hello',verification={email:{'status':'do_not_mail','sub_status':'role_based_catch_all'}},message_id=env+'catchall')
        draft.insert(db,row)
    result=send.send_message(NS(target=row['id'],apply=False,approved_by='Ari'),Fake())
    assert result['results'][0]['state']=='accepted' and 'catch-all' in result['notes'][0]


def test_edit_draft_purpose_drops_unsubscribe_and_refuses_marketing_or_sent(env):
    email=env+'0@example.test'
    with connection() as db:
        row,_=draft.prepare(db,'alex',[email],purpose='marketing',subject='Hi',
            body='Hello\n\nUnsubscribe: mailto:alex@rebattery.io?subject=unsubscribe',
            html='<p>Hello</p><p><a href="mailto:alex@rebattery.io?subject=unsubscribe">Unsubscribe</a></p>',verification={email:{'status':'valid'}},message_id=env+'mk')
        draft.insert(db,row)
    assert 'nsubscribe' in row['body_text'] and 'nsubscribe' in row['body_html']
    edited=draft.edit(NS(target=row['id'],purpose='personal',subject=None,body=None,html=None))['message']
    assert edited['purpose']=='personal' and 'nsubscribe' not in edited['body_text'] and 'nsubscribe' not in edited['body_html']
    assert edited['subject']=='Hi' and edited['to_emails']==[email]
    with pytest.raises(Refused) as caught:
        draft.edit(NS(target=row['id'],purpose=None,subject=None,body='New',html=None))
    assert caught.value.rule=='html_required_with_body'
    with pytest.raises(Refused,match='use_new_draft_for_marketing'):
        draft.edit(NS(target=row['id'],purpose='marketing',subject=None,body=None,html=None))
    send.send_message(NS(target=row['id'],apply=False,approved_by='Ari'),Fake())
    with pytest.raises(Refused,match='draft_not_editable'):
        draft.edit(NS(target=row['id'],purpose=None,subject='Late',body=None,html=None))


def test_gog_env_always_carries_keyring_and_home(monkeypatch,tmp_path):
    from rebattery_mail import core
    key=tmp_path/'key';key.write_text('secret\n')
    monkeypatch.setattr(core,'GOG_KEYRING_FILE',key)
    monkeypatch.delenv('GOG_KEYRING_PASSWORD',raising=False)
    monkeypatch.setenv('HOME','/nowhere')
    env=core.gog_env()
    assert env['GOG_KEYRING_PASSWORD']=='secret' and env['HOME']=='/root'
    monkeypatch.setenv('GOG_KEYRING_PASSWORD','caller')
    assert core.gog_env()['GOG_KEYRING_PASSWORD']=='caller'


def test_gmail_send_passes_keyring_env_to_gog(monkeypatch):
    seen={}
    def runner(args,**kwargs):
        seen.update(kwargs)
        return NS(returncode=0,stdout='{"id":"receipt"}')
    monkeypatch.setenv('GOG_KEYRING_PASSWORD','from-test')
    with patch('rebattery_mail.drivers.live_gate'):
        GmailSendDriver(runner).send({'gmail_account':'alex@rebattery.io','address':'alex@rebattery.io'},{'to_emails':['b@example.test'],'subject':'S','body_text':'Hi'})
    assert seen['env']['GOG_KEYRING_PASSWORD']=='from-test'


def test_gmail_auth_failure_is_a_clean_refusal_not_unknown(env,monkeypatch):
    row=one(env)
    from rebattery_mail.core import ProviderError
    import subprocess
    monkeypatch.setattr(subprocess,'run',lambda *a,**k: NS(returncode=1,stdout='',stderr='keyring'))
    with pytest.raises(ProviderError,match='gmail_auth_unavailable'):
        GmailSendDriver().preflight({'gmail_account':'alex@rebattery.io'},row)
    assert state(row['id'])=='draft'


def test_attachment_draft_digest_and_send_flags(env,tmp_path,monkeypatch):
    from rebattery_mail import attachment
    monkeypatch.setattr(attachment,'STORE',tmp_path/'store')
    book=tmp_path/'Prices Oct 2026.xlsx'
    book.write_bytes(b'workbook-bytes')
    with connection() as db:
        plain,_=draft.prepare(db,'alex',[env+'a@example.test'],subject='Prices',body='See attached',message_id=env+'att-plain')
        row,_=draft.prepare(db,'alex',[env+'a@example.test'],subject='Prices',body='See attached',message_id=env+'att-plain',attachments=[str(book)])
    assert row['has_attachments'] and row['personalization']['attachments'][0]['filename']=='Prices Oct 2026.xlsx'
    assert digest([plain])!=digest([row])  # approval covers the attachment bytes
    calls=[]
    def runner(args,**kwargs):
        calls.append((args,kwargs))
        return NS(returncode=0,stdout='{"id":"fake-gmail-receipt"}')
    ident={'gmail_account':'alex@rebattery.io','address':'alex@rebattery.io'}
    with patch('rebattery_mail.drivers.live_gate'):
        GmailSendDriver(runner).send(ident,row)
    args=calls[0][0]
    assert args[args.index('--attach')+1]==row['personalization']['attachments'][0]['storedPath']
    assert calls[0][1]['timeout']==180
    # Tampering with the stored copy blocks the send.
    open(row['personalization']['attachments'][0]['storedPath'],'wb').write(b'changed')
    with patch('rebattery_mail.drivers.live_gate'),pytest.raises(Refused,match='attachment_changed_since_approval'):
        GmailSendDriver(runner).send(ident,row)
    assert len(calls)==1


def test_attachment_rules(env,tmp_path,monkeypatch):
    from rebattery_mail import attachment
    monkeypatch.setattr(attachment,'STORE',tmp_path/'store')
    with connection() as db:
        with pytest.raises(Refused,match='attachment_file_missing'):
            draft.prepare(db,'alex',[env+'a@example.test'],subject='x',body='y',attachments=[str(tmp_path/'nope.xlsx')])
        big=tmp_path/'big.bin'
        big.write_bytes(b'0')
        monkeypatch.setattr(attachment,'GMAIL_LIMIT_BYTES',0)
        with pytest.raises(Refused,match='attachments_too_large'):
            draft.prepare(db,'alex',[env+'a@example.test'],subject='x',body='y',attachments=[str(big)])
    with pytest.raises(Refused,match='attachments_require_gmail_transport'):
        PostmarkSendDriver(lambda *a,**k:{}).preflight({'postmark_stream':'outbound'},{'purpose':'transactional','personalization':{'attachments':[{}]}})


def test_attachment_listing_download_and_filters(env,tmp_path):
    from rebattery_mail import attachment,read
    full={'message':{'payload':{'parts':[
        {'headers':[{'name':'Content-Disposition','value':'inline'}],'body':{'attachmentId':'inl'}},
        {'headers':[{'name':'Content-Disposition','value':'attachment; filename="Sheet.xlsx"'}],'body':{'attachmentId':'att'}}]}},
        'attachments':[{'filename':'logo.png','size':3,'mimeType':'image/png','attachmentId':'inl'},
                       {'filename':'Sheet.xlsx','size':4,'mimeType':'application/vnd.ms-excel','attachmentId':'att'}]}
    listed=attachment.describe(full)
    assert [(a['filename'],a['inline']) for a in listed]==[('logo.png',True),('Sheet.xlsx',False)]
    with pytest.raises(Refused,match='attachment_not_found'):
        attachment.pick(listed,'missing')
    assert attachment.pick(listed,'sheet')['attachmentId']=='att'
    class Driver:
        def fetch(self,account,message_id):
            return full
    with connection() as db,db.cursor() as cur:
        cur.execute("insert into mail_message(id,direction,transport,state,gmail_message_id,has_attachments,personalization) values (%s,'inbound','gmail','received','g-att',true,%s)",(env+'in',json.dumps({'attachments':listed})))
        cur.execute("insert into mail_message(id,direction,transport,state,has_attachments) values (%s,'inbound','gmail','received',false)",(env+'none',))
        assert read.search(db,filename='*.xlsx',limit=50)['messages'][0]['id']==env+'in'
        assert not [m for m in read.search(db,filename='*.pdf',limit=50)['messages'] if m['id']==env+'in']
        assert env+'in' in [m['id'] for m in read.search(db,has_attachment=True,limit=500)['messages']]
        assert attachment.live_attachments(db,{'has_attachments':False}) == []
    def runner(args,**kwargs):
        out=args[args.index('--out')+1]
        open(out,'wb').write(b'data')
        return NS(returncode=0,stdout='{}')
    out=tmp_path/'Sheet.xlsx'
    with patch.object(attachment,'account_for',return_value='alex@rebattery.io'):
        result=attachment.get(NS(message=env+'in',attachment='Sheet.xlsx',out=str(out)),driver=Driver(),runner=runner)
        assert result['sha256']==attachment.sha256_file(out) and result['sizeBytes']==4
        with pytest.raises(Refused,match='output_exists'):
            attachment.get(NS(message=env+'in',attachment='Sheet.xlsx',out=str(out)),driver=Driver(),runner=runner)
