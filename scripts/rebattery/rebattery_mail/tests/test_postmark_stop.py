"""Postmark emergency stop: refuses before any claim, at preflight and at the last moment; Gmail unaffected. Fakes only."""
import json
from types import SimpleNamespace as NS

import pytest

from rebattery_mail import stop
from rebattery_mail.core import Refused
from rebattery_mail.drivers import PostmarkSendDriver


@pytest.fixture
def stop_file(tmp_path, monkeypatch):
    path = tmp_path / 'mail-postmark-stop.json'
    monkeypatch.setenv('REBATTERY_MAIL_POSTMARK_STOP_FILE', str(path))
    return path


def test_on_off_status(stop_file):
    assert stop.handle(NS(action='status', by=None, reason=None)) == {'stopped': False}
    with pytest.raises(Refused, match='postmark_stop_needs_a_name'):
        stop.handle(NS(action='on', by=' ', reason='x'))
    on = stop.handle(NS(action='on', by='Alex', reason='wrong price in the campaign'))
    assert on['stopped'] and json.loads(stop_file.read_text())['by'] == 'Alex'
    assert stop.handle(NS(action='status', by=None, reason=None))['reason'] == 'wrong price in the campaign'
    off = stop.handle(NS(action='off', by='Alex', reason=None))
    assert off['stopped'] is False and off['was']['by'] == 'Alex' and not stop_file.exists()


def test_stop_refuses_postmark_preflight_and_send(stop_file):
    calls = []
    driver = PostmarkSendDriver(client=lambda *a, **k: calls.append(a) or {'MessageID': 'x', 'ErrorCode': 0})
    identity = {'postmark_stream': 'outbound', 'display_name': 'ReBattery', 'address': 'supply@rebattery.io'}
    message = {'id': 'm1', 'purpose': 'transactional', 'personalization': {}, 'to_emails': ['a@example.test'], 'subject': 's',
               'body_html': '<p>b</p>', 'body_text': 'b', 'idempotency_key': 'k'}
    stop.handle(NS(action='on', by='Alex', reason='test'))
    with pytest.raises(Refused, match='postmark_stopped'):
        driver.preflight(identity, message)
    with pytest.raises(Refused, match='postmark_stopped'):
        driver.send(identity, message)
    assert calls == []  # nothing reached Postmark
    stop.handle(NS(action='off', by='Alex', reason=None))
    stop.check_postmark()  # no stop, no refusal


def test_unreadable_stop_file_still_stops(stop_file):
    stop_file.write_text('not json')
    with pytest.raises(Refused, match='postmark_stopped'):
        stop.check_postmark()
