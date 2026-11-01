"""Use the isolated mail database harness for rewired caller regressions too."""
from rebattery_mail.tests.conftest import (
    mail_test_database,
    db_pre_cutover,
    db_after_cutover,
    no_real_mail,  # autouse: no test here reaches Gmail or Postmark either
)
