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
