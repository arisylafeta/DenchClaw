import importlib.util
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location("suggest", Path(__file__).with_name("marketplace_pulse_suggest.py"))
suggest = importlib.util.module_from_spec(spec)
spec.loader.exec_module(suggest)

GOOD = {"title": "Answer offers fast", "evidence": "2 expired", "action": "Check daily", "metric": "drop_offers_expired", "owner": "Alex"}


class Validate(unittest.TestCase):
    def test_accepts_known_metrics_and_owners_and_trims(self):
        out = suggest.validate([{**GOOD, "title": "  Answer offers fast "}, {**GOOD, "metric": None, "owner": "Product"}], {"drop_offers_expired"})
        self.assertEqual(out[0]["title"], "Answer offers fast")
        self.assertIsNone(out[1]["metric"])

    def test_refuses_unknown_metric_owner_missing_text_and_too_many(self):
        for bad in ([{**GOOD, "metric": "made_up"}], [{**GOOD, "owner": "Bob"}], [{**GOOD, "action": " "}], [GOOD] * 6, []):
            with self.assertRaises(SystemExit):
                suggest.validate(bad, {"drop_offers_expired"})

    def test_every_collected_metric_is_defined_for_the_agent(self):
        collect_spec = importlib.util.spec_from_file_location("collect", Path(__file__).with_name("marketplace_pulse_collect.py"))
        collect = importlib.util.module_from_spec(collect_spec)
        collect_spec.loader.exec_module(collect)
        source = Path(collect.__file__).read_text()
        for metric in (*collect.POSTHOG_METRICS, *collect.DROP_METRICS):
            self.assertIn(metric, suggest.DEFINITIONS)
        for metric in ("deals_created", "deals_paid", "paid_value_gbp", "buyer_signups", "drop_offers_expired", "listings_live"):
            self.assertIn(f'"{metric}"', source)
            self.assertIn(metric, suggest.DEFINITIONS)


if __name__ == "__main__":
    unittest.main()
