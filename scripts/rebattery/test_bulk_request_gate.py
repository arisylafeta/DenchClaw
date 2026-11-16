import importlib.util
from pathlib import Path

spec = importlib.util.spec_from_file_location("gate", Path(__file__).with_name("bulk_request_gate.py"))
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)

MX = lambda domain: True


def req(**kw):
    return {"email": "buyer@acme-energy.com", "wants": "Nissan Leaf 40 kWh packs", "quantity": "many", **kw}


def test_a_big_pack_order_passes_and_a_single_pack_does_not():
    ok, reasons, size = gate.check(req(filters={"kwh_min": 38.5, "kwh_max": 40.49}), MX)
    assert ok and size["units"] == 11 and size["total_kwh"] == 434 and "434" in reasons[0]
    ok, reasons, _ = gate.check(req(quantity="one", filters={"kwh_min": 38.5, "kwh_max": 40.49}), MX)
    assert not ok and reasons[0].startswith("too small: 40 kWh")


def test_two_to_ten_packs_count_as_two():
    ok, reasons, size = gate.check(req(quantity="few", wants="2 Renault Zoe 52 kWh battery packs"), MX)
    assert not ok and size["total_kwh"] == 104


def test_unknown_size_never_passes():
    ok, reasons, _ = gate.check(req(wants="TOYOTA COROLLA CROSS", quantity="few"), MX)
    assert not ok and reasons == ["size unknown: no kWh and no budget"]


def test_a_mwh_total_and_an_explicit_quantity_count():
    assert gate.check(req(wants="2 MWh of LFP for a BESS project", quantity="one"), MX)[0]
    assert gate.size(req(quantity_value=25, wants="ID.3 58 kWh pack"))["total_kwh"] == 1450


def test_a_stated_budget_of_20k_passes_without_kwh():
    ok, reasons, size = gate.check(req(wants="BMW i3 modules", quantity_value=100, target_price=250, target_currency="GBP", price_unit="pack"), MX)
    assert ok and size["value_eur"] == 28750 and "budget" in reasons[0]
    assert gate.owner_for(size) == "Sean"


def test_the_25_eur_estimate_never_lets_a_request_in_on_its_own():
    size = gate.size(req(quantity_value=8, wants="Ioniq 5 77 kWh"))
    assert size["est_value_eur"] == 8 * 77 * 25
    assert gate.owner_for({"total_kwh": 616, "value_eur": None, "est_value_eur": 15400}) == "Alex"


def test_documents_and_bad_addresses_are_rejected():
    ok, reasons, _ = gate.check(req(wants="Safety data sheet and UN38.3 test summary for a Nissan Leaf 40 kWh pack",
                                    filters={"kwh_min": 38.5, "kwh_max": 40.49}), MX)
    assert not ok and any(r.startswith("not a purchase") for r in reasons)
    assert "disposable email address" in gate.check(req(email="x@mailinator.com", wants="2 MWh"), MX)[1]
    assert "nodomain.example does not receive mail" in gate.check(req(email="a@nodomain.example", wants="2 MWh"), lambda d: False)[1]
    assert gate.check(req(email="a@b.com", wants="2 MWh"), lambda d: None)[0]  # DNS down: the review catches it


def test_a_one_euro_price_is_ignored():
    assert gate.size(req(quantity="one", target_price=1, target_currency="EUR", wants="cells"))["value_eur"] is None


def test_a_count_in_their_words_beats_the_band():
    assert gate.units(req(details="Need 20 packs for a storage project")) == 20
    assert gate.units(req(quantity="few", wants="2 Renault Zoe 52 kWh battery packs")) == 2
    assert gate.units(req(quantity="one", details="looking for 40 packs")) == 1  # the form says one: keep it
