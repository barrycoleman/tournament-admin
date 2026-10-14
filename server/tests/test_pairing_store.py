from __future__ import annotations

import datetime as dt

from tournament_server.services.pairing import MAX_OPEN_CODES, PairingStore


class Clock:
    def __init__(self):
        self.now = dt.datetime(2026, 10, 13, 12, 0, tzinfo=dt.timezone.utc)

    def __call__(self):
        return self.now

    def advance(self, **kwargs):
        self.now += dt.timedelta(**kwargs)


def test_open_returns_a_code_that_lasts_five_minutes():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    assert len(pending.code) == 6
    assert pending.expires_at == clock.now + dt.timedelta(minutes=5)
    assert store.find_open(pending.code) is pending


def test_find_open_ignores_case_spaces_and_dashes():
    store = PairingStore(now=Clock())
    pending = store.open(set())
    loose = f"{pending.code[:3].lower()} - {pending.code[3:].lower()}"
    assert store.find_open(loose) is pending


def test_an_expired_code_is_not_found():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    clock.advance(minutes=5)
    assert store.find_open(pending.code) is None


def test_open_codes_are_unique():
    store = PairingStore(now=Clock())
    codes = {store.open(set()).code for _ in range(MAX_OPEN_CODES)}
    assert len(codes) == MAX_OPEN_CODES


def test_past_the_cap_the_oldest_code_is_dropped():
    store = PairingStore(now=Clock())
    first = store.open(set())
    for _ in range(MAX_OPEN_CODES):
        store.open(set())
    assert store.find_open(first.code) is None


def test_past_the_cap_a_paired_code_is_kept_and_the_oldest_unpaired_is_dropped():
    store = PairingStore(now=Clock())
    paired = store.open(set())
    oldest_unpaired = store.open(set())
    for _ in range(MAX_OPEN_CODES - 2):
        store.open(set())
    assert store.attach_token(paired.id, "kept") is True
    store.open(set())
    assert store.poll(paired.id, paired.poll_key) == ("paired", "kept")
    assert store.find_open(oldest_unpaired.code) is None


def test_past_the_cap_with_every_code_paired_the_oldest_is_dropped():
    store = PairingStore(now=Clock())
    pendings = [store.open(set()) for _ in range(MAX_OPEN_CODES)]
    for p in pendings:
        assert store.attach_token(p.id, "t") is True
    store.open(set())
    assert store.poll(pendings[0].id, pendings[0].poll_key) is None
    assert store.poll(pendings[1].id, pendings[1].poll_key) == ("paired", "t")


def test_suggested_names_avoid_taken_names_and_each_other():
    store = PairingStore(now=Clock())
    a = store.open({"brave-otter"})
    b = store.open({"brave-otter"})
    assert a.suggested_name != "brave-otter"
    assert a.suggested_name.casefold() != b.suggested_name.casefold()


def test_poll_waits_then_hands_over_the_token_once():
    store = PairingStore(now=Clock())
    pending = store.open(set())
    assert store.poll(pending.id, pending.poll_key) == ("waiting", None)
    assert store.attach_token(pending.id, "secret-token") is True
    assert store.poll(pending.id, pending.poll_key) == ("paired", "secret-token")
    assert store.poll(pending.id, pending.poll_key) is None


def test_poll_with_a_wrong_key_or_id_is_none():
    store = PairingStore(now=Clock())
    pending = store.open(set())
    assert store.poll(pending.id, "wrong") is None
    assert store.poll("nope", pending.poll_key) is None


def test_poll_after_expiry_reports_expired():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    clock.advance(minutes=5, seconds=1)
    assert store.poll(pending.id, pending.poll_key) == ("expired", None)


def test_a_paired_code_is_no_longer_open_and_cannot_be_paired_twice():
    store = PairingStore(now=Clock())
    pending = store.open(set())
    assert store.attach_token(pending.id, "t1") is True
    assert store.find_open(pending.code) is None
    assert store.attach_token(pending.id, "t2") is False


def test_a_token_attached_at_the_last_second_is_still_collectable():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    clock.advance(minutes=4, seconds=59)
    assert store.attach_token(pending.id, "late") is True
    clock.advance(seconds=31)
    assert store.poll(pending.id, pending.poll_key) == ("paired", "late")


def test_collect_grace_runs_from_the_codes_expiry_not_from_pairing():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    clock.advance(minutes=1)
    assert store.attach_token(pending.id, "early") is True
    clock.advance(minutes=4, seconds=59)  # 5:59
    assert store.poll(pending.id, pending.poll_key) == ("paired", "early")


def test_collect_grace_ends_a_minute_after_the_codes_expiry():
    clock = Clock()
    store = PairingStore(now=clock)
    pending = store.open(set())
    clock.advance(minutes=1)
    assert store.attach_token(pending.id, "early") is True
    clock.advance(minutes=5)  # 6:00
    assert store.poll(pending.id, pending.poll_key) == ("expired", None)
