"""Send speed: one Gmail thread read for the reply check, and one preflight per message. Fakes only."""
from unittest.mock import patch
import psycopg2
import pytest
import os
from rebattery_mail.gmail_sync import sync_gmail
from rebattery_mail.tests.test_read_sync import FakeGmail, gmail, DatabaseTests  # noqa: F401
from rebattery_mail import send
from rebattery_mail.tests.test_send import env, one, Fake, approved, fake_execution_gate  # noqa: F401
from types import SimpleNamespace as NS


class ThreadGmail(FakeGmail):
    def __init__(self, messages, thread):
        super().__init__(messages)
        self.thread = thread
        self.thread_calls = []
    def thread_messages(self, account, thread_id):
        self.thread_calls.append(thread_id)
        return [{'id': i, 'threadId': thread_id, 'labelIds': ['Label_5'] if i == 'm2' else []} for i in self.thread]
    def label_names(self, account):
        return {'Label_5': 'CRM'}


@pytest.mark.usefixtures('db_after_cutover')
class ThreadScopedSync(DatabaseTests):
    def test_thread_mode_reads_one_thread_and_never_searches_the_mailbox(self):
        messages = {'m1': gmail('m1', thread_id='t-9'), 'm2': gmail('m2', thread_id='t-9', sender='Known <known@battery.test>')}
        driver = ThreadGmail(messages, ['m1', 'm2'])
        result = sync_gmail(self.db, 'alex@rebattery.io', apply=True, driver=driver, thread_id='t-9', skip_known=True)
        self.assertEqual(driver.queries, [])          # no mailbox search at all
        self.assertEqual(driver.thread_calls, ['t-9'])
        self.assertEqual(result['counts']['found'], 2)
        visible = dict(self.rows("select gmail_message_id, crm_visible from mail_message where gmail_message_id in ('m1','m2')"))
        self.assertTrue(visible['m2'])                # CRM label resolved from the label id

    def test_drivers_without_thread_support_keep_the_old_search(self):
        driver = FakeGmail({'m3': gmail('m3', thread_id='t-1')})
        sync_gmail(self.db, 'alex@rebattery.io', apply=True, driver=driver, thread_id='t-1')
        self.assertTrue(driver.queries)
