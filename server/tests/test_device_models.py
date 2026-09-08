from __future__ import annotations

from sqlalchemy import select

from tournament_server.db import init_db, make_engine, make_session_factory, utc_now
from tournament_server.models.scoring_device import ScoringDevice
from tournament_server.settings import Settings


def _session_factory(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_scoring_device_round_trips(tmp_path):
    db = _session_factory(tmp_path)
    now = utc_now()
    db.add(
        ScoringDevice(
            friendly_name="shifty-squirrel",
            device_token_hash="hashed-token",
            registered_at=now,
            last_seen_at=now,
        )
    )
    db.commit()

    row = db.execute(select(ScoringDevice)).scalars().first()
    assert row.friendly_name == "shifty-squirrel"
    assert row.admitted_at is None
    assert row.admitted_by is None
    assert row.registered_at.tzinfo is not None
    assert row.last_seen_at.tzinfo is not None


def test_settings_device_idle_timeout_defaults_to_sixty_minutes(monkeypatch):
    monkeypatch.delenv("TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES", raising=False)
    settings = Settings.from_env()
    assert settings.device_idle_timeout_minutes == 60


def test_settings_device_idle_timeout_reads_env_override(monkeypatch):
    monkeypatch.setenv("TOURNAMENT_DEVICE_IDLE_TIMEOUT_MINUTES", "15")
    settings = Settings.from_env()
    assert settings.device_idle_timeout_minutes == 15
