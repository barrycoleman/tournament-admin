from __future__ import annotations

import datetime as dt
from types import SimpleNamespace

import pytest

from tournament_server.services import devices as rules

NOW = dt.datetime(2026, 10, 13, 12, 0, tzinfo=dt.timezone.utc)


def _device(role="scorer", last_seen_minutes_ago=0, disabled=False):
    return SimpleNamespace(
        role=role,
        last_seen_at=NOW - dt.timedelta(minutes=last_seen_minutes_ago),
        disabled_at=NOW if disabled else None,
    )


def test_a_recent_device_is_active():
    assert rules.device_status(_device(last_seen_minutes_ago=239), NOW, 240) == "active"


def test_an_operator_device_goes_idle_at_the_timeout():
    assert rules.device_status(_device(last_seen_minutes_ago=240), NOW, 240) == "idle"


def test_a_display_never_goes_idle():
    device = _device(role="display_device", last_seen_minutes_ago=100_000)
    assert rules.device_status(device, NOW, 240) == "active"


def test_disabled_wins_over_idle_and_display():
    assert rules.device_status(_device(disabled=True), NOW, 240) == "disabled"
    assert rules.device_status(_device(role="display_device", disabled=True), NOW, 240) == "disabled"


def test_pairable_roles_exclude_admin_and_attendee():
    assert rules.PAIRABLE_ROLES == ("scorer", "referee", "judge", "front_desk", "display_device")
    assert rules.SCORING_ROLES == ("scorer", "referee")


@pytest.mark.parametrize("raw", ["kx49tm", "KX4 9TM", "kx4-9tm", " KX4-9TM "])
def test_codes_are_normalized(raw):
    assert rules.normalize_code(raw) == "KX49TM"


def test_generated_codes_use_only_the_alphabet_and_avoid_taken_codes():
    taken = set()
    for _ in range(200):
        code = rules.generate_code(taken)
        assert len(code) == 6
        assert set(code) <= set("ACDEFGHJKMNPQRTUVWXY34679")
        assert code not in taken
        taken.add(code)


def test_names_are_keyed_case_insensitively():
    assert rules.name_key("  Field 1 Tablet ") == "field 1 tablet"


def test_clean_name_strips_and_rejects_blank_and_overlong():
    assert rules.clean_name("  Pit TV ") == "Pit TV"
    with pytest.raises(ValueError):
        rules.clean_name("   ")
    with pytest.raises(ValueError):
        rules.clean_name("x" * 101)
    assert rules.clean_name("x" * 100) == "x" * 100


def test_suggested_names_avoid_taken_keys():
    taken = set()
    for _ in range(50):
        name = rules.suggest_name(taken)
        assert rules.name_key(name) not in taken
        taken.add(rules.name_key(name))


def test_idle_minutes_defaults_without_an_event(client):
    db = client.app.state.session_factory()
    try:
        assert rules.idle_minutes_for(db) == 240
    finally:
        db.close()


def test_idle_minutes_reads_the_event(client):
    client.post("/api/event", json={"name": "E"})
    db = client.app.state.session_factory()
    try:
        from tournament_server.models.event import Event

        event = db.query(Event).one()
        assert event.device_idle_minutes == 240
        event.device_idle_minutes = 30
        db.commit()
        assert rules.idle_minutes_for(db) == 30
    finally:
        db.close()
