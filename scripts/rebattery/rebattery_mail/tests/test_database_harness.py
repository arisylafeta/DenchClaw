"""The disposable-database guard must reject production-looking targets."""
import pytest
from rebattery_mail.tests.conftest import guard_test_dsn


@pytest.mark.parametrize('dsn', [
    'dbname=mail_test_synthetic host=127.0.0.1 port=5432',
    'dbname=mail_test_synthetic host=database.example port=55470',
    'dbname=denchclaw host=127.0.0.1 port=55470',
    'dbname=mail_test_synthetic port=55470',
])
def test_rejects_unsafe_database_targets(dsn):
    with pytest.raises(pytest.skip.Exception, match='mail_test_'):
        guard_test_dsn(dsn)


@pytest.mark.parametrize('host', ['127.0.0.1', 'localhost'])
def test_accepts_only_throwaway_local_targets(host):
    assert guard_test_dsn(f'dbname=mail_test_synthetic host={host} port=55470')['dbname'] == 'mail_test_synthetic'
