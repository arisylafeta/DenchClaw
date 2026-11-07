import relay_job as rj


def test_last_json_object_takes_the_final_draft():
    out = 'Working...\n{"note": "x"}\nDone.\n{"subject": "Re: LFP", "body": "Hi Lance,", "files": []}\nsession_id: abc'
    assert rj.last_json_object(out)["subject"] == "Re: LFP"


def test_last_json_object_none_without_a_body():
    assert rj.last_json_object('{"rows": 3}') is None
    assert rj.last_json_object("no json here") is None


def test_rejects_bad_job_ids():
    assert rj.main("../../etc") == 2


def test_last_json_object_finds_matchas_deal_result():
    out = 'Reading thread...\n{"body": "not this"}\n{"action": "created", "listing_id": "btd_1", "gaps": ["price"]}\nsession_id: x'
    assert rj.last_json_object(out, "action")["listing_id"] == "btd_1"
    assert rj.last_json_object('{"body": "a draft"}', "action") is None
