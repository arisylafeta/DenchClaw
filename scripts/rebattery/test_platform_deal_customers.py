import importlib.util
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
spec = importlib.util.spec_from_file_location('platform_deal_customers', Path(__file__).with_name('platform_deal_customers.py'))
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def deal(status, step, amount, sup='s', cp='c'):
    return {'status': status, 'workflow_step': step, 'agreed_amount': amount,
            'supplier_account_id': sup, 'counterparty_account_id': cp}


def test_both_parties_of_paid_deals_count():
    assert mod.paid_accounts([deal('completed', 'completed', 17106.88, 'seller', 'recycler')]) == ['recycler', 'seller']
    assert mod.paid_accounts([deal('open', 'payment_confirmed', 4000, 'a', 'b')]) == ['a', 'b']
    assert mod.paid_accounts([deal('open', 'collection_scheduled', 1550, 'a', 'b')]) == ['a', 'b']


def test_unpaid_cancelled_and_test_value_deals_are_skipped():
    assert mod.paid_accounts([deal('open', 'accepted', 410760), deal('open', 'terms_agreed', 6500)]) == []
    assert mod.paid_accounts([deal('cancelled', 'payment_confirmed', 2080)]) == []
    assert mod.paid_accounts([deal('completed', 'completed', 1.0), deal('completed', 'completed', None)]) == []
