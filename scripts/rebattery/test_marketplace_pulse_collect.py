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
    base = {"deals": [], "payments": [], "offers": [], "chats": [], "bids": [], "listings": [], "requests": [], "accounts": [],
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
            offers=[{"created_at": "2026-09-22T09:00:00Z", "status": "expired", "expires_at": "2026-09-29T09:00:00Z", "buyer_account_id": "acc-buyer", "listing_id": "l1"},
                    {"created_at": "2026-09-30T09:00:00Z", "status": "expired", "expires_at": "2026-10-07T09:00:00Z", "buyer_account_id": "acc-test", "listing_id": "l1"}],
            listings=[{"id": "l1", "listing_status": "published", "created_at": "2026-09-22T00:00:00Z", "supplier_account_id": "acc-staff"},
                      {"id": "l2", "listing_status": "published", "created_at": "2026-09-22T00:00:00Z", "supplier_account_id": "acc-test"},
                      {"id": "l3", "listing_status": "draft", "created_at": "2026-09-22T00:00:00Z", "supplier_account_id": "acc-seller"}],
            bids=[{"created_at": "2026-09-23T00:00:00Z", "email": "ari@rebattery.io"},
                  {"created_at": "2026-09-23T00:00:00Z", "email": "Founder@gmail.com"},
                  {"created_at": "2026-09-23T00:00:00Z", "email": "buyer@example.org"}],
            accounts=[{"id": "b1", "role": "buyer", "created_at": "2026-09-23T00:00:00Z"}, {"id": "acc-test", "role": "buyer", "created_at": "2026-09-23T00:00:00Z"},
                      {"id": "s1", "role": "supplier", "created_at": "2026-09-23T00:00:00Z"}],
            requests=[{"created_at": "2026-09-23T00:00:00Z", "status": "test", "contact_email": "x@example.org"},
                      {"created_at": "2026-09-23T00:00:00Z", "status": "refused", "contact_email": "y@example.org"}],
        )
        out = self.count(rows)
        self.assertEqual(out[WEEK]["deals_created"], 1)
        self.assertEqual(out[PREVIOUS]["offers_made"], 1)
        self.assertEqual(out[WEEK]["drop_offers_expired"], 1)
        self.assertEqual(out[PREVIOUS]["listings_new"], 1)
        self.assertEqual(out[WEEK]["listings_live"], 1)
        self.assertEqual(out[PREVIOUS]["auction_bids"], 1)
        self.assertEqual(out[PREVIOUS]["sell_requests"], 1)
        self.assertEqual(out[PREVIOUS]["buyer_signups"], 1)

    def test_paid_counts_the_first_captured_payment_at_the_deal_amount_in_pounds(self):
        rows = data(
            deals=[{"id": "d1", "status": "open", "created_at": "2026-09-08T10:00:00Z", "cancelled_at": None,
                    "supplier_account_id": "acc-seller", "counterparty_account_id": "acc-buyer"},
                   {"id": "d2", "status": "cancelled", "created_at": "2026-09-22T10:00:00Z", "cancelled_at": "2026-09-30T10:00:00Z",
                    "supplier_account_id": "acc-seller", "counterparty_account_id": "acc-buyer"}],
            payments=[{"deal_id": "d1", "status": "captured", "payment_purpose": "initial", "created_at": "2026-09-08T10:00:00Z", "captured_at": "2026-09-29T15:00:00Z",
                       "deal_amount": 4000, "currency": "eur"},
                      {"deal_id": "d1", "status": "captured", "payment_purpose": "reconciliation", "created_at": "2026-09-30T15:00:00Z", "captured_at": "2026-09-30T15:00:00Z",
                       "deal_amount": 0, "currency": "eur"},
                      {"deal_id": "d2", "status": "failed", "payment_purpose": "initial", "created_at": "2026-09-23T10:00:00Z", "captured_at": None,
                       "deal_amount": 900, "currency": "gbp"}],
        )
        out = self.count(rows)
        self.assertEqual(out[WEEK]["deals_paid"], 1)
        self.assertEqual(out[WEEK]["paid_value_gbp"], 3440.0)
        self.assertEqual(out[PREVIOUS]["deals_created"], 1)
        self.assertEqual(out[WEEK]["deals_cancelled"], 1)
        self.assertEqual(out[PREVIOUS]["drop_payment_failed"], 1)

    def test_live_listings_only_for_the_current_week(self):
        rows = data(listings=[{"id": "l1", "listing_status": "published", "created_at": "2026-09-01T00:00:00Z", "supplier_account_id": "s"}])
        out = self.count(rows, today=dt.date(2026, 10, 8))
        self.assertNotIn("listings_live", out[WEEK])
        self.assertNotIn("listings_live", out[PREVIOUS])


class Replies(unittest.TestCase):
    def test_replies_count_messages_and_offers_once_and_only_when_a_day_old(self):
        rows = data(
            chats=[{"id": "c1", "created_at": "2026-09-22T09:00:00Z", "conversation_type": "purchase", "supplier_account_id": "seller", "counterparty_account_id": "acc-buyer"},
                   {"id": "c2", "created_at": "2026-09-23T09:00:00Z", "conversation_type": "purchase", "supplier_account_id": "seller", "counterparty_account_id": "acc-buyer"},
                   {"id": "c3", "created_at": "2026-09-30T20:00:00Z", "conversation_type": "purchase", "supplier_account_id": "seller", "counterparty_account_id": "acc-buyer"}],
            messages=[{"conversation_id": "c1", "created_at": "2026-09-22T09:00:00Z", "sender_membership_id": "mb", "is_system_seeded": False},
                      {"conversation_id": "c1", "created_at": "2026-09-22T10:00:00Z", "sender_membership_id": None, "is_system_seeded": True},
                      {"conversation_id": "c1", "created_at": "2026-09-22T12:00:00Z", "sender_membership_id": "ms", "is_system_seeded": False},
                      {"conversation_id": "c2", "created_at": "2026-09-23T09:00:00Z", "sender_membership_id": "mb", "is_system_seeded": False},
                      {"conversation_id": "c3", "created_at": "2026-09-30T20:00:00Z", "sender_membership_id": "mb", "is_system_seeded": False}],
            sender_account={"mb": "acc-buyer", "ms": "seller"},
            offers=[{"id": "o1", "created_at": "2026-09-23T09:05:00Z", "updated_at": "2026-09-26T09:05:00Z", "status": "rejected", "expires_at": None,
                     "buyer_account_id": "acc-buyer", "listing_id": "l1", "conversation_id": "c2"},
                    {"id": "o2", "created_at": "2026-09-24T09:00:00Z", "updated_at": "2026-10-01T09:00:00Z", "status": "expired", "expires_at": "2026-10-01T09:00:00Z",
                     "buyer_account_id": "acc-buyer", "listing_id": "l1", "conversation_id": None}],
            listings=[{"id": "l1", "listing_status": "published", "created_at": "2026-09-01T00:00:00Z", "supplier_account_id": "seller"}],
        )
        out = pulse.platform_metrics(rows, [PREVIOUS, WEEK], dt.date(2026, 10, 1), EXCLUSIONS,
                                     now=dt.datetime(2026, 10, 1, 12, tzinfo=dt.timezone.utc))
        # c1 replied in 3 hours; c2 and its offer count once, replied after 72 hours; o2 never; c3 is under a day old.
        self.assertEqual((out[PREVIOUS]["reply_intents"], out[PREVIOUS]["reply_24h"], out[PREVIOUS]["reply_none"]), (3, 1, 1))
        self.assertEqual(out[PREVIOUS]["reply_median_hours"], 37.54)
        self.assertEqual(out[WEEK]["reply_intents"], 0)


class OfferReplies(unittest.TestCase):
    def test_an_offer_answered_only_in_its_chat_counts_and_a_withdrawn_one_is_left_out(self):
        rows = data(
            chats=[{"id": "c9", "created_at": "2026-09-22T09:00:00Z", "conversation_type": "purchase", "supplier_account_id": "seller", "counterparty_account_id": "acc-buyer"}],
            # The chat has only the seller's reply: no message typed by the buyer.
            messages=[{"conversation_id": "c9", "created_at": "2026-09-22T11:00:00Z", "sender_membership_id": "ms", "is_system_seeded": False}],
            sender_account={"ms": "seller"},
            offers=[{"id": "o1", "created_at": "2026-09-22T09:00:00Z", "updated_at": "2026-09-29T09:00:00Z", "status": "expired", "expires_at": None,
                     "buyer_account_id": "acc-buyer", "listing_id": "l1", "conversation_id": "c9"},
                    {"id": "o2", "created_at": "2026-09-23T09:00:00Z", "updated_at": "2026-09-23T10:00:00Z", "status": "withdrawn", "expires_at": None,
                     "buyer_account_id": "acc-buyer", "listing_id": "l1", "conversation_id": None}],
            listings=[{"id": "l1", "listing_status": "published", "created_at": "2026-09-01T00:00:00Z", "supplier_account_id": "seller"}],
        )
        out = pulse.platform_metrics(rows, [PREVIOUS, WEEK], dt.date(2026, 10, 1), EXCLUSIONS, now=dt.datetime(2026, 10, 1, 12, tzinfo=dt.timezone.utc))
        self.assertEqual((out[PREVIOUS]["reply_intents"], out[PREVIOUS]["reply_24h"], out[PREVIOUS]["reply_none"]), (1, 1, 0))


class Collect(unittest.TestCase):
    def test_a_failed_drop_off_read_keeps_the_funnel_numbers(self):
        def fake_posthog(start, end, template=None, metrics=None, **_):
            if metrics is pulse.DROP_METRICS:
                raise RuntimeError("HogQL error")
            return {WEEK: {metric: 7 for metric in metrics}}
        saved = (pulse.read_posthog, pulse.read_platform, pulse.Platform, pulse.load_exclusions, pulse.read_breakdowns)
        pulse.read_posthog, pulse.read_platform = fake_posthog, lambda platform: data()
        pulse.Platform, pulse.load_exclusions = lambda: None, lambda: EXCLUSIONS
        pulse.read_breakdowns = lambda start, end: [(WEEK, "channel_visitors", "Direct", 3), (dt.date(2020, 1, 6), "channel_visitors", "Direct", 9)]
        try:
            numbers, breakdowns, error = pulse.collect(type("Args", (), {"since": None})(), dt.date(2026, 10, 1))
        finally:
            pulse.read_posthog, pulse.read_platform, pulse.Platform, pulse.load_exclusions, pulse.read_breakdowns = saved
        self.assertEqual(numbers[WEEK]["visitors"], 7)
        self.assertNotIn("drop_no_price", numbers[WEEK])
        self.assertIn("drop-off read failed", error)
        # Only breakdowns for the weeks being written are kept.
        self.assertEqual(breakdowns, [(WEEK, "channel_visitors", "Direct", 3)])

    def test_breakdowns_make_the_ordered_funnel_cumulative_and_keep_the_top_referrers(self):
        def rows(template, start, end):
            if template is pulse.ORDERED_QUERY:
                return [{"week": "2026-09-28", "dimension": "Direct", "level": 4, "people": 1},
                        {"week": "2026-09-28", "dimension": "Direct", "level": 2, "people": 5},
                        {"week": "2026-09-28", "dimension": "AI chat", "level": 1, "people": 3},
                        {"week": "2026-09-28", "dimension": "AI chat", "level": 0, "people": 9}]
            if template is pulse.REFERRER_QUERY:
                return [{"week": "2026-09-28", "dimension": f"site{i}.com", "visitors": i} for i in range(pulse.TOP_REFERRERS + 5)] + \
                       [{"week": "2026-09-28", "dimension": None, "visitors": 50}]
            return [{"week": "2026-09-28", "dimension": "Direct", "visitors": 10, "viewed": 4, "started": 2, "sent": 1}]
        out = {(m, d): v for _, m, d, v in pulse.read_breakdowns(WEEK, WEEK, rows=rows)}
        self.assertEqual([out.get((step, "All")) for step in pulse.FUNNEL_STEPS], [9, 6, 1, 1])
        self.assertEqual([out.get((step, "Direct")) for step in pulse.FUNNEL_STEPS], [6, 6, 1, 1])
        self.assertEqual(out[("funnel_reached", "AI chat")], 3)
        self.assertNotIn(("funnel_viewed", "AI chat"), out)
        self.assertEqual(out[("channel_viewed", "Direct")], 4)
        self.assertEqual(out[("landing_sent", "Direct")], 1)
        referrers = sorted(d for m, d in out if m == "referrer_visitors")
        self.assertEqual(len(referrers), pulse.TOP_REFERRERS)
        self.assertNotIn("site0.com", referrers)


if __name__ == "__main__":
    unittest.main()
