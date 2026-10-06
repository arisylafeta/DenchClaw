import datetime as dt
import importlib.util
import re
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("pulse", Path(__file__).with_name("marketplace_pulse_collect.py"))
pulse = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pulse)

WEEK = dt.date(2026, 9, 28)
PREVIOUS = dt.date(2026, 9, 21)
EXCLUSIONS = (re.compile(r"@rebattery\.(io|invalid)$", re.I), {"acc-test"}, {"founder@gmail.com"})


def data(**rows):
    base = {"deals": [], "payments": [], "offers": [], "chats": [], "bids": [], "listings": [], "requests": [],
            "account_emails": {"acc-buyer": ["buyer@example.org"], "acc-staff": ["ari@rebattery.io"]}}
    return {**base, **rows}


class Weeks(unittest.TestCase):
    def test_weeks_start_on_monday_utc(self):
        self.assertEqual(pulse.week_of("2026-10-04T23:30:00+00:00"), WEEK)
        self.assertEqual(pulse.week_of("2026-10-04T23:30:00-02:00"), dt.date(2026, 10, 5))
        self.assertEqual(pulse.weeks_from(dt.date(2026, 9, 24), dt.date(2026, 10, 1)), [PREVIOUS, WEEK])


class PlatformMetrics(unittest.TestCase):
    def count(self, rows, today=dt.date(2026, 10, 1)):
        return pulse.platform_metrics(rows, [PREVIOUS, WEEK], today, EXCLUSIONS)

    def test_staff_and_test_buyers_do_not_count_but_rebattery_listings_do(self):
        rows = data(
            deals=[
                {"id": "d1", "status": "open", "created_at": "2026-09-29T10:00:00Z", "cancelled_at": None,
                 "supplier_account_id": "acc-staff", "counterparty_account_id": "acc-buyer"},
                {"id": "d2", "status": "open", "created_at": "2026-09-29T10:00:00Z", "cancelled_at": None,
                 "supplier_account_id": "acc-seller", "counterparty_account_id": "acc-staff"},
                {"id": "d3", "status": "open", "created_at": "2026-09-29T10:00:00Z", "cancelled_at": None,
                 "supplier_account_id": "acc-test", "counterparty_account_id": "acc-buyer"},
            ],
            offers=[{"created_at": "2026-09-30T09:00:00Z", "buyer_account_id": "acc-buyer", "listing_id": "l1"},
                    {"created_at": "2026-09-30T09:00:00Z", "buyer_account_id": "acc-test", "listing_id": "l1"}],
            listings=[{"id": "l1", "listing_status": "published", "created_at": "2026-09-22T00:00:00Z", "supplier_account_id": "acc-staff"},
                      {"id": "l2", "listing_status": "published", "created_at": "2026-09-22T00:00:00Z", "supplier_account_id": "acc-test"},
                      {"id": "l3", "listing_status": "draft", "created_at": "2026-09-22T00:00:00Z", "supplier_account_id": "acc-seller"}],
            bids=[{"created_at": "2026-09-23T00:00:00Z", "email": "ari@rebattery.io"},
                  {"created_at": "2026-09-23T00:00:00Z", "email": "Founder@gmail.com"},
                  {"created_at": "2026-09-23T00:00:00Z", "email": "buyer@example.org"}],
            requests=[{"created_at": "2026-09-23T00:00:00Z", "status": "test", "contact_email": "x@example.org"},
                      {"created_at": "2026-09-23T00:00:00Z", "status": "refused", "contact_email": "y@example.org"}],
        )
        out = self.count(rows)
        self.assertEqual(out[WEEK]["deals_created"], 1)
        self.assertEqual(out[WEEK]["offers_made"], 1)
        self.assertEqual(out[PREVIOUS]["listings_new"], 1)
        self.assertEqual(out[WEEK]["listings_live"], 1)
        self.assertEqual(out[PREVIOUS]["auction_bids"], 1)
        self.assertEqual(out[PREVIOUS]["sell_requests"], 1)

    def test_paid_counts_the_first_captured_payment_at_the_deal_amount_in_pounds(self):
        rows = data(
            deals=[{"id": "d1", "status": "open", "created_at": "2026-09-08T10:00:00Z", "cancelled_at": None,
                    "supplier_account_id": "acc-seller", "counterparty_account_id": "acc-buyer"},
                   {"id": "d2", "status": "cancelled", "created_at": "2026-09-22T10:00:00Z", "cancelled_at": "2026-09-30T10:00:00Z",
                    "supplier_account_id": "acc-seller", "counterparty_account_id": "acc-buyer"}],
            payments=[{"deal_id": "d1", "status": "captured", "payment_purpose": "initial", "captured_at": "2026-09-29T15:00:00Z",
                       "deal_amount": 4000, "currency": "eur"},
                      {"deal_id": "d1", "status": "captured", "payment_purpose": "reconciliation", "captured_at": "2026-09-30T15:00:00Z",
                       "deal_amount": 0, "currency": "eur"},
                      {"deal_id": "d2", "status": "failed", "payment_purpose": "initial", "captured_at": None,
                       "deal_amount": 900, "currency": "gbp"}],
        )
        out = self.count(rows)
        self.assertEqual(out[WEEK]["deals_paid"], 1)
        self.assertEqual(out[WEEK]["paid_value_gbp"], 3440.0)
        self.assertEqual(out[PREVIOUS]["deals_created"], 1)
        self.assertEqual(out[WEEK]["deals_cancelled"], 1)

    def test_live_listings_only_for_the_current_week(self):
        rows = data(listings=[{"id": "l1", "listing_status": "published", "created_at": "2026-09-01T00:00:00Z", "supplier_account_id": "s"}])
        out = self.count(rows, today=dt.date(2026, 10, 8))
        self.assertNotIn("listings_live", out[WEEK])
        self.assertNotIn("listings_live", out[PREVIOUS])


if __name__ == "__main__":
    unittest.main()
