"""Synthetic, provider-free integration checks for mail-log read and sync commands."""
import json
import os
import unittest
from datetime import datetime, timezone
from unittest.mock import patch

import psycopg2
import pytest
from rebattery_mail.core import Refused
from rebattery_mail.templating import render_template, render_message
from rebattery_mail.read import search, status, message, thread, person
from rebattery_mail.identity import identities
from rebattery_mail.gmail_sync import sync_gmail
from rebattery_mail.ingest import ingest_postmark_event
from rebattery_mail.sync import sync_postmark
from rebattery_mail.crm_visibility import normalize_email, is_common_email_provider


class RenderingTests(unittest.TestCase):
    def test_missing_and_injected_merge_tokens_are_refused(self):
        with self.assertRaises(Refused) as error:
            render_template('Hello {{name}}', {})
        self.assertEqual(error.exception.rule,'missing_variable')
        with self.assertRaises(Refused):
            render_template('{{name}}', {'name':'{{bad}}'})
        with self.assertRaises(Refused):
            render_template('{{ unsupported.token }}', {})
        with self.assertRaises(Refused):
            render_message({'required_variables':['name']},{'name':''})

    def test_postmark_tokens_pass_and_html_is_escaped(self):
        template = '{{ name }} {{{ pm:unsubscribe }}} {{{ pm:other }}}'
        self.assertEqual(render_template(template,{'name':'<A&B>'},True),'&lt;A&amp;B&gt; {{{ pm:unsubscribe }}} {{{ pm:other }}}')
        self.assertEqual(render_message({'subject':'Hi {{name}}','html':'{{name}}','text_body':'{{name}}'},{'name':'<x>'}),{'subject':'Hi <x>','html':'&lt;x&gt;','text':'<x>'})

    def test_original_address_policy(self):
        self.assertEqual(normalize_email(' Person+tag@EXAMPLE.test '),'person@example.test')
        for domain in ('gmail.com','wp.pl','yahoo.co.uk','outlook.de'):
            self.assertTrue(is_common_email_provider(domain))
        self.assertFalse(is_common_email_provider('battery.example'))


class FakeGmail:
    def __init__(self,messages,crm=(),triage=()):
        self.messages,self.crm,self.triage = messages,set(crm),set(triage)
        self.queries=[]
    def search(self,account,query):
        self.queries.append(query)
        ids = self.crm if 'label:CRM' in query else self.triage if 'label:Deal' in query else self.messages
        return [{'id':id} for id in ids]
    def fetch(self,account,id):
        return self.messages[id]


def gmail(id,sender='Unknown <stranger@unknown.test>',to='alex@rebattery.io',labels=(),rfc=None,reply=None,date='Fri, 16 Oct 2026 10:00:00 +0000',thread_id='thread-1'):
    return {'headers':{'from':sender,'to':to,'subject':'Synthetic battery discussion','date':date,'message-id':rfc or '<'+id+'@test>','in-reply-to':reply},'body':'Synthetic battery body','message':{'id':id,'threadId':thread_id,'labelIds':list(labels)}}


@pytest.mark.usefixtures('db_after_cutover')
class DatabaseTests(unittest.TestCase):
    def setUp(self):
        dsn = os.environ.get('DENCH_MAIL_DSN','')
        self.db = psycopg2.connect(dsn)
        self.addCleanup(self.db.close)
        self.addCleanup(self.db.rollback)
        with self.db.cursor() as cur:
            cur.execute("insert into crm_users(email,password_hash) values('alex@rebattery.io','synthetic-only') on conflict(email) do update set is_active=true returning id")
            self.owner = cur.fetchone()[0]
            cur.execute("insert into crm_people(id,full_name,email) values('read-person','Synthetic contact','known@battery.test') on conflict(id) do nothing")
            cur.execute("insert into crm_companies(id,name,domain) values('read-company','Synthetic Battery','battery.test') on conflict(id) do nothing")
            cur.execute("insert into campaigns(id,campaign_name) values('read-campaign','Synthetic campaign') on conflict(id) do nothing")

    def rows(self,sql,params=()):
        with self.db.cursor() as cur:
            cur.execute(sql,params)
            return cur.fetchall()

    def add_message(self,id,**values):
        fields = {'id':id,'direction':'outbound','transport':'postmark-transactional','purpose':'personal','state':'accepted','identity_key':'hello','sent_at':'2026-10-16T10:00:00Z','accepted_at':'2026-10-16T10:00:00Z','subject':'Synthetic battery cells','body_text':'Battery modules for reuse','from_email':'hello@rebattery.io','to_emails':['known@battery.test'],'recipient_email':'known@battery.test'}
        fields.update(values)
        with self.db.cursor() as cur:
            cur.execute('insert into mail_message('+','.join(fields)+') values('+','.join(['%s']*len(fields))+')',tuple(fields.values()))

    def test_search_combines_filters_and_order_and_crm_visibility(self):
        for id,visible in [('read-b',True),('read-a',True),('read-private',False)]:
            self.add_message(id,crm_visible=visible,campaign_id='read-campaign',recipient_email=id+'@battery.test')
        self.add_message('read-new',sent_at='2026-10-17T10:00:00Z',crm_visible=True)
        filters = {'q':'battery','identity':'hello','campaign':'read-campaign','direction':'outbound','transport':'postmark-transactional','purpose':'personal','state':'accepted','from':'hello@rebattery.io','to':'known@battery.test','since':'2026-10-15','until':'2026-10-17','crm_only':True}
        self.assertEqual([r['id'] for r in search(self.db,**filters)['messages']],['read-a','read-b'])
        self.assertEqual(len(search(self.db,**{**filters,'crm_only':False})['messages']),3)
        self.assertEqual(search(self.db,**{**filters,'q':'unobtainium'})['messages'],[])
        self.assertEqual(search(self.db)['messages'][0]['id'],'read-new')

    def test_status_counts_are_separate_with_scanner_evidence(self):
        self.add_message('read-status',provider_message_id='provider-status',campaign_id='read-campaign')
        with self.db.cursor() as cur:
            cur.execute("insert into mail_message_link(id,message_id,cta_key,destination_url) values('read-link-1','read-status','one','https://test/one'),('read-link-2','read-status','two','https://test/two')")
        for payload in [{'RecordType':'Delivery','DeliveredAt':'2026-10-16T10:00:01Z'}, {'RecordType':'Open','ReceivedAt':'2026-10-16T10:00:02Z','UserAgent':'GoogleImageProxy'}, {'RecordType':'Click','ReceivedAt':'2026-10-16T10:00:03Z','OriginalLink':'https://test/one'}, {'RecordType':'Click','ReceivedAt':'2026-10-16T10:00:04Z','OriginalLink':'https://test/two'}]:
            ingest_postmark_event(self.db,{'MessageID':'provider-status',**payload})
        result = status(self.db,'read-campaign')
        self.assertEqual(result['counts'],dict(sent=1,delivered=1,bounced=0,opened=1,clicked=1,unsubscribed=0,replied=0))
        self.assertEqual(result['evidence'],{key:['read-status'] for key in ('clicks_soon_after_delivery','all_links_in_short_window','google_image_proxy')})
        self.assertEqual(len(search(self.db,event='clicked')['messages']),1)
        self.assertEqual(len(message(self.db,'read-status')['events']),4)
        self.assertEqual(len(person(self.db,'known@battery.test')['messages']),1)

    def test_gmail_wide_capture_does_not_create_unknown_people(self):
        driver = FakeGmail({'unknown':gmail('unknown'),'triaged':gmail('triaged',thread_id='triage')},triage=['triaged'])
        result = sync_gmail(self.db,'alex@rebattery.io',apply=True,driver=driver)
        self.assertEqual(result['counts']['imported'],2)
        self.assertEqual(result['counts']['crm_visible'],1)
        self.assertEqual(result['counts']['auto_created'],0)
        self.assertEqual(self.rows("select count(*) from crm_people where email='stranger@unknown.test'")[0][0],0)
        self.assertEqual(self.rows('select crm_visible_reason from mail_message order by crm_visible'),[('no-match',),('triage-label',)])
        self.assertTrue(all('-label:DRAFT' in query for query in driver.queries))
        self.assertEqual(self.rows('select distinct mailbox_owner_id from mail_message'),[(self.owner,)])

    def test_crm_label_creates_person_but_triage_does_not(self):
        driver = FakeGmail({'labelled':gmail('labelled')},crm=['labelled'])
        result = sync_gmail(self.db,'alex@rebattery.io',apply=True,driver=driver)
        self.assertEqual(result['counts']['auto_created'],1)
        self.assertEqual(self.rows("select source_detail from crm_companies where domain='unknown.test'"),[('Gmail: thread labelled CRM',)])
        self.assertEqual(self.rows('select direction from crm_interactions'),[('Received',)])
        self.assertEqual(self.rows('select count(*) from mail_thread_participant')[0][0],1)

    def test_known_company_creation_only_when_original_visibility_rule_matches(self):
        messages = {'wide':gmail('wide',sender='New <new@battery.test>'),'visible':gmail('visible',sender='Other <other@battery.test>',thread_id='visible')}
        sync_gmail(self.db,'alex@rebattery.io',apply=True,driver=FakeGmail(messages,triage=['visible']))
        self.assertEqual(self.rows("select email from crm_people where email in ('new@battery.test','other@battery.test')"),[('other@battery.test',)])

    def test_sent_linking_reply_pause_and_rerun_are_idempotent(self):
        self.add_message('read-sent',transport='gmail',identity_key='alex',from_email='alex@rebattery.io',rfc_message_id='<sent@test>',gmail_message_id='sent')
        driver = FakeGmail({'sent':gmail('sent',sender='alex@rebattery.io',to='known@battery.test',labels=['SENT'],rfc='<sent@test>'), 'reply':gmail('reply',sender='known@battery.test',reply='<sent@test>',date='Fri, 16 Oct 2026 11:00:00 +0000')})
        sync_gmail(self.db,'alex@rebattery.io',apply=True,driver=driver)
        thread_id = self.rows("select thread_id from mail_message where id='read-sent'")[0][0]
        with self.db.cursor() as cur:
            cur.execute("insert into mail_followup(id,message_id,thread_id,due_at,origin) values('read-followup','read-sent',%s,now(),'commitment')",(thread_id,))
        second = sync_gmail(self.db,'alex@rebattery.io',apply=True,driver=driver)
        self.assertEqual(self.rows('select count(*) from mail_message')[0][0],2)
        self.assertEqual(self.rows("select count(*) from mail_event where type='replied'")[0][0],1)
        self.assertEqual(self.rows("select state,paused_reason from mail_followup"),[('paused','reply')])
        self.assertIsNotNone(self.rows("select replied_at from mail_message where id='read-sent'")[0][0])
        self.assertEqual(second['counts']['replies'],0)
        self.assertEqual(thread(self.db,thread_id)['thread']['message_count'],2)
        self.assertEqual(len(self.rows('select * from mail_message_recipient')),1)
        self.assertEqual(identities(self.db,'alex')['verified'],None)

    def test_rfc_id_links_outbound_without_gmail_receipt(self):
        self.add_message('read-rfc',transport='gmail',rfc_message_id='<rfc@test>')
        sync_gmail(self.db,'alex@rebattery.io',apply=True,driver=FakeGmail({'new-id':gmail('new-id',sender='alex@rebattery.io',to='known@battery.test',rfc='<rfc@test>',labels=['SENT'])}))
        self.assertEqual(self.rows('select id,gmail_message_id from mail_message'),[('read-rfc','new-id')])

    def test_gmail_dry_run_and_authoritative_draft_guard(self):
        driver = FakeGmail({'normal':gmail('normal'),'draft':gmail('draft',labels=['draft'])},crm=['normal'])
        result = sync_gmail(self.db,'alex@rebattery.io',driver=driver)
        self.assertTrue(result['dry_run'])
        self.assertEqual(result['counts']['drafts_skipped'],1)
        self.assertEqual(self.rows('select count(*) from mail_message')[0][0],0)
        self.assertEqual(self.rows("select count(*) from crm_people where email='stranger@unknown.test'")[0][0],0)
        applied = sync_gmail(self.db,'alex@rebattery.io',apply=True,driver=driver)
        self.assertEqual(result['counts'],applied['counts'])

    def test_postmark_duplicates_out_of_order_and_exact_link_attribution(self):
        self.add_message('read-events',provider_message_id='provider-events')
        with self.db.cursor() as cur:
            cur.execute("insert into mail_message_link(id,message_id,cta_key,destination_url) values('read-events-link','read-events','cta','https://test/cta')")
        later = {'MessageID':'provider-events','RecordType':'Click','ReceivedAt':'2026-10-16T12:00:00Z','OriginalLink':'https://test/cta'}
        early = {**later,'ReceivedAt':'2026-10-16T11:00:00Z'}
        self.assertTrue(ingest_postmark_event(self.db,later)['inserted'])
        self.assertFalse(ingest_postmark_event(self.db,later)['inserted'])
        ingest_postmark_event(self.db,early)
        equivalent = {'MessageID':'provider-events','Type':'LinkClicked','ReceivedAt':'2026-10-16T11:00:00+00:00','Details':{'Link':'https://test/cta'}}
        self.assertFalse(ingest_postmark_event(self.db,equivalent)['inserted'])
        ingest_postmark_event(self.db,{**early,'OriginalLink':'https://test/unsubscribe','ReceivedAt':'2026-10-16T10:30:00Z'})
        self.assertEqual(self.rows('select count(*) from mail_event')[0][0],3)
        self.assertEqual(self.rows('select first_clicked_at from mail_message_link')[0][0].hour,11)
        self.assertEqual(self.rows('select clicked_at from mail_message')[0][0].hour,10)

    def test_postmark_suppression_truth_and_no_reactivation(self):
        self.add_message('read-suppress',provider_message_id='provider-suppress')
        payload = {'RecordType':'SubscriptionChange','MessageID':'provider-suppress','Recipient':'known@battery.test','ChangedAt':'2026-10-16T10:00:00Z','SuppressSending':True}
        ingest_postmark_event(self.db,payload)
        ingest_postmark_event(self.db,{**payload,'SuppressSending':False})
        self.assertEqual(self.rows('select status from crm_subscriptions'),[('Opted out',)])
        self.assertEqual(status(self.db,'read-suppress')['counts']['unsubscribed'],1)

    def test_postmark_sync_dry_run_then_apply_then_duplicate(self):
        self.add_message('read-sync',provider_message_id='provider-sync')
        class Client:
            def details(self,id):
                return {'MessageEvents':[{'Type':'Delivered','ReceivedAt':'2026-10-16T12:00:00Z'},{'Type':'Opened','ReceivedAt':'2026-10-16T12:01:00Z'},{'Type':'Transient','ReceivedAt':'2026-10-16T12:01:00Z'}]}
            def suppressions(self,stream):
                return {}
        dry = sync_postmark(self.db,client=Client())
        self.assertTrue(dry['dry_run'])
        self.assertEqual(self.rows('select count(*) from mail_event')[0][0],0)
        self.assertEqual(dry['inserted_events'],2)
        self.assertEqual(sync_postmark(self.db,apply=True,client=Client())['inserted_events'],2)
        self.assertEqual(sync_postmark(self.db,apply=True,client=Client())['inserted_events'],0)
        self.assertEqual(status(self.db,'read-sync')['counts']['delivered'],1)

    def test_postmark_sync_never_asks_postmark_about_gmail_ids(self):
        """A Gmail receipt filed under a Postmark transport made Postmark return 400 and aborted the whole sync."""
        self.add_message('read-gmail-id',provider_message_id='gmail:abc123')
        self.add_message('read-pm-id',provider_message_id='provider-ok')
        asked = []
        class Client:
            def details(self,id):
                asked.append(id)
                return {'MessageEvents':[]}
            def suppressions(self,stream):
                return {}
        sync_postmark(self.db,client=Client())
        self.assertEqual(asked,['provider-ok'])


if __name__ == '__main__':
    unittest.main()
