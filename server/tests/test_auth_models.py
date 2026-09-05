import datetime as dt

from sqlalchemy import select

from tournament_server.db import init_db, make_engine, make_session_factory, utc_now
from tournament_server.models.auth_session import AuthSession
from tournament_server.models.role_credential import RoleCredential
from tournament_server.models.signing_key import SigningKey


def _session_factory(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_role_credential_round_trips(tmp_path):
    db = _session_factory(tmp_path)
    db.add(RoleCredential(role="admin", password_hash="hashed-value"))
    db.commit()

    row = db.execute(select(RoleCredential)).scalars().first()
    assert row.role == "admin"
    assert row.password_hash == "hashed-value"


def test_auth_session_round_trips(tmp_path):
    db = _session_factory(tmp_path)
    now = utc_now()
    db.add(
        AuthSession(
            role="scorer",
            refresh_token_hash="hashed-token",
            issued_at=now,
            expires_at=now + dt.timedelta(days=14),
            label="scoring tablet, Field 3",
        )
    )
    db.commit()

    row = db.execute(select(AuthSession)).scalars().first()
    assert row.role == "scorer"
    assert row.revoked_at is None
    assert row.label == "scoring tablet, Field 3"
    assert row.issued_at.tzinfo is not None


def test_signing_key_round_trips(tmp_path):
    db = _session_factory(tmp_path)
    db.add(SigningKey(key="a" * 64))
    db.commit()

    row = db.execute(select(SigningKey)).scalars().first()
    assert row.key == "a" * 64
