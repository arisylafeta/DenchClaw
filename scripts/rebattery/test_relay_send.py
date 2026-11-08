import relay_send as rs


def test_refusal_reads_the_cli_json():
    out = 'rebattery-mail: thread_has_reply\n{\n  "refused": "thread_has_reply",\n  "message": "thread_has_reply"\n}'
    assert rs.refusal("", out)["reason"] == "thread_has_reply"
    assert rs.refusal('{"refused": "approval_digest_mismatch"}', "")["reason"] == "approval_digest_mismatch"


def test_refusal_falls_back_to_the_last_line():
    assert rs.refusal("", "Traceback...\nBoom")["detail"]["message"] == "Boom"


def test_rejects_bad_arguments():
    assert rs.main("../x y", "alex@rebattery.io") == 2
    assert rs.main("abc", "not-an-email") == 2


def _row(**kw):
    from datetime import datetime, timezone
    base = {"id": "m1", "by": "alex@rebattery.io", "at": datetime(2026, 11, 9, 8, 0, tzinfo=timezone.utc), "same_version": True, "to": "rob@x.com"}
    return {**base, **kw}


def test_due_sends_an_unchanged_draft_on_time():
    from datetime import datetime, timezone
    assert rs.decide(_row(), datetime(2026, 11, 9, 8, 1, tzinfo=timezone.utc)) is None


def test_due_refuses_a_draft_edited_after_scheduling():
    from datetime import datetime, timezone
    assert rs.decide(_row(same_version=False), datetime(2026, 11, 9, 8, 1, tzinfo=timezone.utc))["reason"] == "schedule_changed"


def test_due_refuses_a_long_missed_time():
    from datetime import datetime, timezone
    assert rs.decide(_row(), datetime(2026, 11, 9, 15, 0, tzinfo=timezone.utc))["reason"] == "schedule_missed"


def test_due_refuses_a_schedule_without_an_approver():
    from datetime import datetime, timezone
    assert rs.decide(_row(by=None), datetime(2026, 11, 9, 8, 1, tzinfo=timezone.utc))["reason"] == "schedule_invalid"
