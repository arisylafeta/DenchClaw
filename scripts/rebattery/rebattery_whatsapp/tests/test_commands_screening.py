"""Synthetic-only local CLI and pending Inbox regression cases."""
import argparse
import ast
import json
from pathlib import Path
import pytest
from rebattery_whatsapp.commands_read import dispatch_read_command, register_read_commands
from rebattery_whatsapp.screening import screen
from rebattery_whatsapp.core import cursor, Refused
from test_whatsapp import person, save, event, apply, rows


@pytest.fixture
def screened_db(db):
    migration = Path(__file__).resolve().parents[4] / 'apps/web/lib/crm-postgres/migrations/056_whatsapp_demand_sources.sql'
    with db, cursor(db) as cur:
        cur.execute(migration.read_text())
    return db


def stub(system, payload, key):
    source = json.loads(payload)['SOURCES'][0]
    return {'demands': [{'source_id': source['source_id'], 'buyer_company': 'Invented company',
        'contact_email': 'invented@example.test', 'contact_name':'Invented person', 'wants': '100 LFP cells', 'quantity': '100 cells',
        'product_family': 'lfp cells', 'quote': 'We need to buy 100 LFP cells'}]}


def setup(db, tmp_path):
    person(db, company='synthetic-company')
    save(tmp_path, [event(body='We need to buy 100 LFP cells')])
    apply(tmp_path, db)


def test_pending_once_no_email_inference_and_ignored_replay(screened_db, tmp_path):
    db = screened_db
    setup(db, tmp_path)
    assert screen(db, apply=False, model=stub)['proposals'] == 1
    assert rows(db, 'crm_bulk_trade_proposals') == []
    with db:
        assert screen(db, apply=True, model=stub)['proposals'] == 1
    card = rows(db, 'crm_bulk_trade_proposals')[0]
    assert card['status'] == 'new' and card['source_kind'] == 'whatsapp'
    assert card['proposed']['person_id'] == 'person-one'
    assert card['proposed']['buyer'] == 'Synthetic Company'
    assert card['proposed']['email'] is None
    assert card['proposed']['contact'] == 'Synthetic Person'
    assert rows(db, 'crm_bulk_demand') == []
    with db, cursor(db) as cur:
        cur.execute("update crm_bulk_trade_proposals set status='ignored'")
        cur.execute('delete from whatsapp_screen_checkpoint')
    with db:
        assert screen(db, apply=True, model=stub)['proposals'] == 0
    assert len(rows(db, 'crm_bulk_trade_proposals')) == 1


def test_edits_invalidate_and_redaction_purges_copies(screened_db, tmp_path):
    db = screened_db
    setup(db, tmp_path)
    with db:
        screen(db, apply=True, model=stub)
    with db, cursor(db) as cur:
        cur.execute("""update whatsapp_message set metadata=jsonb_set(metadata,'{reactions}','{"synthetic":"observed"}')""")
    assert rows(db, 'crm_bulk_trade_proposals')[0]['status'] == 'new'
    with db, cursor(db) as cur:
        cur.execute("update whatsapp_message set body='Changed synthetic request',edit_version=edit_version+1")
    card = rows(db, 'crm_bulk_trade_proposals')[0]
    assert card['status'] == 'ignored' and card['quote'] == ''
    assert 'wants' not in card['proposed']
    with db, cursor(db) as cur:
        cur.execute('update whatsapp_message set body=null,deleted_at=now()')
    assert rows(db, 'crm_bulk_trade_proposals')[0]['quote'] == ''


def test_read_commands_dates_canonical_refs_and_confidence(screened_db, tmp_path):
    db = screened_db
    setup(db, tmp_path)
    parser = argparse.ArgumentParser()
    register_read_commands(parser.add_subparsers(dest='command', required=True))
    result = dispatch_read_command(parser.parse_args(['search','--q','LFP','--direction','inbound']), db)
    message = result['messages'][0]
    assert message['source_ref'] == 'whatsapp:message:' + message['id']
    assert message['identity_links'][0]['confidence'] == 'high'
    thread = dispatch_read_command(parser.parse_args(['thread', message['thread_id']]), db)
    assert thread['thread']['source_ref'] == message['thread_ref']
    assert thread['messages'][0]['identity_links'][0]['confidence'] == 'high'
    assert dispatch_read_command(parser.parse_args(['search','--since','2030-01-01']), db)['messages'] == []
    with pytest.raises(Refused):
        dispatch_read_command(parser.parse_args(['search','--limit','201']), db)
    threads = dispatch_read_command(parser.parse_args(['person','person-one']), db)['threads']
    assert threads[0]['source_ref'].startswith('whatsapp:thread:')


def test_package_has_no_whatsapp_transport_imports():
    # AST imports detect capabilities, not innocent documentation strings or sender column names.
    forbidden = {'requests','httpx','aiohttp','socket','websockets','baileys','whatsapp','twilio','selenium'}
    for file in Path(__file__).resolve().parents[1].glob('*.py'):
        for node in ast.walk(ast.parse(file.read_text())):
            names = [n.name for n in node.names] if isinstance(node, ast.Import) else [node.module or ''] if isinstance(node, ast.ImportFrom) else []
            assert not {name.split('.')[0] for name in names} & forbidden, file.name


def test_offered_stock_becomes_manual_observation_not_bid(screened_db, tmp_path):
    db = screened_db
    setup(db, tmp_path)
    with db, cursor(db) as cur:
        cur.execute("""insert into crm_bulk_trade_lots(id,title,lot_kind,summary,observed_outcome,confidence)
          values('synthetic-lot','Synthetic offered cells','supply','Synthetic lot','Synthetic observation','confirmed')""")
        thread = rows(db, 'whatsapp_thread')[0]['id']
        cur.execute("""insert into crm_bulk_trade_evidence_links(lot_id,evidence_kind,evidence_id)
          values('synthetic-lot','whatsapp_live_thread',%s)""", (thread,))
    def offered(system, payload, key):
        reply = stub(system, payload, key)
        reply['demands'][0].update({'offered_lot_id':'synthetic-lot','unit_price':20,'currency':'EUR','price_unit':'cell'})
        return reply
    with db:
        screen(db, apply=True, model=offered)
    cards = rows(db, 'crm_bulk_trade_proposals')
    assert len(cards) == 1 and cards[0]['kind'] == 'needs_triage'
    assert cards[0]['proposed']['observation'] == 'offered_stock_reply'
    assert rows(db, 'crm_bulk_trade_buyers') == []
    assert rows(db, 'crm_bulk_trade_bids') == []
