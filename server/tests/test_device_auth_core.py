from __future__ import annotations

import datetime as dt

from tournament_server.auth import hash_token
from tournament_server.db import init_db, make_engine, make_session_factory, utc_now
from tournament_server.device_auth import (
    device_status,
    generate_device_token,
    generate_friendly_name,
    is_currently_admitted,
    touch_device_activity,
)
from tournament_server.models.scoring_device import ScoringDevice


def _db(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_generate_device_token_is_unique_each_call():
    tokens = {generate_device_token() for _ in range(20)}
    assert len(tokens) == 20


def test_generate_friendly_name_is_adjective_animal_shaped(tmp_path):
    db = _db(tmp_path)
    name = generate_friendly_name(db)
    parts = name.split("-")
    assert len(parts) == 2
    assert all(parts)


def test_generate_friendly_name_avoids_collisions(tmp_path):
    db = _db(tmp_path)
    first = generate_friendly_name(db)
    now = utc_now()
    db.add(
        ScoringDevice(
            friendly_name=first,
            device_token_hash="some-hash",
            registered_at=now,
            last_seen_at=now,
        )
    )
    db.commit()

    names = {generate_friendly_name(db) for _ in range(30)}
    assert first not in names


def test_is_currently_admitted_false_when_never_admitted():
    now = utc_now()
    device = ScoringDevice(
        friendly_name="brave-otter",
        device_token_hash="hash",
        registered_at=now,
        last_seen_at=now,
        admitted_at=None,
    )
    assert not is_currently_admitted(device, now, dt.timedelta(minutes=60))


def test_is_currently_admitted_true_within_timeout():
    now = utc_now()
    device = ScoringDevice(
        friendly_name="brave-otter",
        device_token_hash="hash",
        registered_at=now,
        last_seen_at=now,
        admitted_at=now,
    )
    assert is_currently_admitted(device, now, dt.timedelta(minutes=60))


def test_is_currently_admitted_false_after_idle_timeout():
    now = utc_now()
    stale = now - dt.timedelta(hours=2)
    device = ScoringDevice(
        friendly_name="brave-otter",
        device_token_hash="hash",
        registered_at=stale,
        last_seen_at=stale,
        admitted_at=stale,
    )
    assert not is_currently_admitted(device, now, dt.timedelta(minutes=60))


def test_device_status_pending_admitted_idle():
    now = utc_now()
    idle_timeout = dt.timedelta(minutes=60)

    pending = ScoringDevice(
        friendly_name="a", device_token_hash="h1", registered_at=now, last_seen_at=now,
    )
    assert device_status(pending, now, idle_timeout) == "pending"

    admitted = ScoringDevice(
        friendly_name="b", device_token_hash="h2", registered_at=now, last_seen_at=now,
        admitted_at=now,
    )
    assert device_status(admitted, now, idle_timeout) == "admitted"

    stale = now - dt.timedelta(hours=2)
    idle = ScoringDevice(
        friendly_name="c", device_token_hash="h3", registered_at=stale, last_seen_at=stale,
        admitted_at=stale,
    )
    assert device_status(idle, now, idle_timeout) == "idle"


def test_touch_device_activity_updates_last_seen(tmp_path):
    db = _db(tmp_path)
    stale = utc_now() - dt.timedelta(hours=1)
    device = ScoringDevice(
        friendly_name="quiet-hawk",
        device_token_hash=hash_token("raw-device-token"),
        registered_at=stale,
        last_seen_at=stale,
    )
    db.add(device)
    db.commit()

    touch_device_activity(db, "raw-device-token")

    db.refresh(device)
    assert device.last_seen_at > stale


def test_touch_device_activity_silently_ignores_unknown_token(tmp_path):
    db = _db(tmp_path)
    touch_device_activity(db, "no-such-token")  # must not raise
