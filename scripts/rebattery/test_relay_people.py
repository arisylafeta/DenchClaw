"""Relay people: which addresses are one person, on what evidence (relay_people.py)."""
import relay_people as rp

CHRIS = "threadofariadne.dev1@gmail.com"
ECO = "eco.mobility.dev.1@gmail.com"
VEGAS = "chrismoenvegas@gmail.com"

eco_mail = {"id": "e1", "from_email": ECO, "text": (
    "Hello Alex,\n\nI'm following up from Eco Mobility's email account on the same battery inventory previously discussed with "
    "Chris at threadofariadne.dev1@gmail.com. This is coordinated outreach on behalf of the same individual seller, not a second "
    "seller or a separate inventory lot.\n\nThank you,\nEco Mobility | coordinated seller outreach")}
chris_mail = {"id": "c1", "from_email": CHRIS, "text": (
    "Hi Alex,\n\nI would like to move to an active listing.\n\nThank you,\nChris Smerling\n(850) 280-0998")}
vegas_mail = {"id": "v1", "from_email": VEGAS, "text": "Hi Alex,\n\nI have the 16 modules.\n\nThanks,\nChris Smerling"}


def test_their_own_words_link_two_addresses_and_keep_the_quote():
    found = rp.evidence([eco_mail, chris_mail])
    assert [(e.a, e.b, e.how) for e in found.links] == [(ECO, CHRIS, "stated")]
    assert "same individual seller" in found.links[0].evidence


def test_the_same_name_without_a_phone_is_nothing():
    found = rp.evidence([chris_mail, vegas_mail])
    assert not found.links and not found.suggestions


def test_the_same_name_and_phone_is_only_a_suggestion():
    vegas_with_phone = {**vegas_mail, "text": vegas_mail["text"] + "\n+1 850-280-0998"}
    found = rp.evidence([chris_mail, vegas_with_phone])
    assert not found.links
    assert [(e.how, e.evidence) for e in found.suggestions] == [("signature", "Both sign as Chris Smerling with the same phone number")]


def test_a_broker_naming_a_seller_is_never_linked():
    broker = {"id": "b1", "from_email": "jo@broker.example", "text": (
        "Hi,\n\nWe are acting on behalf of a client; you can also reach their engineer at pat@plant.example.\n\nJo")}
    found = rp.evidence([broker])
    assert not found.links  # "on behalf of a client" is not "the same person": at most a suggestion
    assert [e.how for e in found.suggestions] == ["named"]


def test_a_signature_in_the_quoted_thread_is_not_theirs():
    a = {"id": "1", "from_email": "bstancil@s2a.example", "text": "Thanks\n\nOn Mon, Song Lee <song@tesla.example> wrote:\nSong Lee\n+1 650 555 0101"}
    b = {"id": "2", "from_email": "song@tesla.example", "text": "Best\nSong Lee\n+1 650 555 0101"}
    assert not rp.evidence([a, b]).links


def test_a_colleague_quoted_under_a_short_reply_is_not_the_signer():
    ruben = {"id": "1", "from_email": "rg@r3.example", "text": "Hi Alex,\n\nThanks.\n\nRuben Gihr\n+352 621 000 111\n\nHi Alex,\nAbhishek Agarwal\n+352 621 000 222"}
    abhi = {"id": "2", "from_email": "aag@r3.example", "text": "Hi Alex,\n\nSure.\n\nAbhishek Agarwal\n+352 621 000 222"}
    assert not rp.evidence([ruben, abhi]).links and not rp.evidence([ruben, abhi]).suggestions


def test_shared_inboxes_and_our_addresses_never_link():
    mail = {"id": "s1", "from_email": "info@dealer.example", "text": "This is also me: my other email is tom@dealer.example."}
    assert not rp.evidence([mail]).links
    ours = {"id": "s2", "from_email": "tom@dealer.example", "text": "My other email: alex@rebattery.io"}
    assert not rp.evidence([ours]).links


def test_groups_join_chains_and_respect_a_no():
    edges = [rp.Edge("a@x.io", "b@y.io", "stated", "", ""), rp.Edge("b@y.io", "c@z.io", "stated", "", "")]
    assert rp.groups(edges, set()) == [{"a@x.io", "b@y.io", "c@z.io"}]
    assert sorted(map(sorted, rp.groups(edges, {frozenset(("b@y.io", "c@z.io"))}))) == [["a@x.io", "b@y.io"]]


def test_fold_reads_times_per_person():
    people = {"a@x.io": {"a@x.io", "b@y.io"}, "b@y.io": {"a@x.io", "b@y.io"}}
    assert rp.fold({"a@x.io": 1, "c@z.io": 5}, people) == {"a@x.io": 1, "b@y.io": 1, "c@z.io": 5}


def test_phones_and_names_read_signatures():
    assert rp.phones("Phone: (850) 280-0998") == {"502800998"}
    assert rp.names("Best regards,\nChristopher Smerling (Chris)") == {"christopher smerling"}
    assert rp.names("Hi Alex,\nLas Vegas office") == set()


def test_a_shared_name_and_phone_with_no_tie_to_either_address_is_nothing():
    a = {"id": "1", "from_email": "x1@a.example", "text": "Thanks\nJohn Smith\n+44 7700 900123"}
    b = {"id": "2", "from_email": "y2@b.example", "text": "Thanks\nJohn Smith\n+44 7700 900123"}
    assert not rp.evidence([a, b]).suggestions


def test_a_colleagues_name_on_a_work_address_is_not_a_suggestion():
    a = {"id": "1", "from_email": "brian@s2a.example", "text": "Thanks\nBrian Kuzdas\n+1 555 010 0199"}
    b = {"id": "2", "from_email": "bstancil@s2a.example", "text": "Thanks\nBrian Kuzdas\n+1 555 010 0199"}
    assert not rp.evidence([a, b]).suggestions
    gmail = {"id": "3", "from_email": "threadofariadne.dev1@gmail.com", "text": "Thanks\nChris Smerling\n(850) 280-0998"}
    vegas = {"id": "4", "from_email": "chrismoenvegas@gmail.com", "text": "Thanks\nChris Smerling\n(850) 280-0998"}
    assert [e.how for e in rp.evidence([gmail, vegas]).suggestions] == ["signature"]
