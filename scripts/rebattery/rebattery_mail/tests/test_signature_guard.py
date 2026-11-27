"""REB-744: supply@ and buy@ never leave without that identity's signature."""
from contextlib import nullcontext
import pytest
from rebattery_mail import policy,send
from rebattery_mail.core import Refused


SUPPLY_HTML = '<div dir="ltr"><table><tr><td>Supply team</td></tr></table><div>rebattery.io</div></div>'
BUY_HTML = '<div dir="ltr"><table><tr><td>Sourcing team</td></tr></table><div>rebattery.io</div></div>'


def author(key, signature_html):
    return {'key':key,'address':key+'@rebattery.io','signature_html':signature_html}


def test_supply_and_buy_need_their_own_signature():
    policy.signature(author('supply',SUPPLY_HTML),{'body_html':'<p>Hello</p>'+SUPPLY_HTML})
    policy.signature(author('buy',BUY_HTML),{'body_html':'<p>Hello</p>'+BUY_HTML})
    with pytest.raises(Refused,match='signature_missing') as supply:
        policy.signature(author('supply',SUPPLY_HTML),{'body_html':'<p>Hello</p>'})
    assert supply.value.detail['identity'] == 'supply'
    assert 'Re-create the draft' in supply.value.detail['hint']
    with pytest.raises(Refused,match='signature_missing'):
        policy.signature(author('buy',BUY_HTML),{'body_html':'<p>Hello</p>'+SUPPLY_HTML})


def test_supply_signature_refused_when_identity_has_no_signature_configured():
    with pytest.raises(Refused,match='signature_missing'):
        policy.signature(author('supply',''),{'body_html':'<p>Hello</p>'})


def test_other_identities_are_untouched():
    policy.signature(author('alex','<div>Alex</div>'),{'body_html':'<p>Hello</p>'})
    policy.signature({'key':'hello','address':'hello@rebattery.io'},{'body_html':''})


def test_reflowed_signature_still_matches():
    reflowed = SUPPLY_HTML.replace('><','>\n  <')
    policy.signature(author('supply',SUPPLY_HTML),{'body_html':'<p>Hello</p>'+reflowed})


class FakeCursor:
    def __enter__(self): return self
    def __exit__(self,*exc): return False
    def execute(self,*args): return None
    def fetchone(self): return None
    def fetchall(self): return []


class FakeDb:
    def __enter__(self): return self
    def __exit__(self,*exc): return False
    def cursor(self,**kwargs): return FakeCursor()


class FakeDriver:
    def preflight(self,identity,message): return {}
    def refresh_replies(self,identity,message): return None


def test_preflight_refuses_an_unsigned_supply_send(monkeypatch):
    message = {'id':'m1','identity_key':'supply','purpose':'transactional','transport':'postmark-transactional',
               'personalization':{'identity_snapshot':{'key':'supply','address':'supply@rebattery.io'}},'body_html':'<p>Hello</p>','body_text':'Hello',
               'subject':'Hi','to_emails':[]}
    monkeypatch.setattr(send,'connection',lambda read_only=False: FakeDb())
    monkeypatch.setattr(send,'refresh_replies',lambda *args: None)
    monkeypatch.setattr(send.policy,'identity',lambda db,key,purpose,transport=None: (author(key,SUPPLY_HTML),transport))
    monkeypatch.setattr(send.policy,'thread_reply',lambda db,message: False)
    with pytest.raises(Refused,match='signature_missing'):
        send.preflight(message,FakeDriver())
    message['body_html'] = '<p>Hello</p>' + SUPPLY_HTML
    assert send.preflight(message,FakeDriver())['key'] == 'supply'
