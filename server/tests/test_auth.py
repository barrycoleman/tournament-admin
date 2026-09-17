from __future__ import annotations

import datetime as dt

from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import TEST_PASSWORD, bearer, login_as
from tournament_server.auth import ROLES, hash_password
from tournament_server.models.auth_session import AuthSession
from tournament_server.models.event import Event
from tournament_server.models.role_credential import RoleCredential


def _seed_event_and_credentials(app, password: str = TEST_PASSWORD) -> None:
    db = app.state.session_factory()
    try:
        db.add(Event(name="Regional Qualifier"))
        password_hash = hash_password(password)
        for role in ROLES:
            db.add(RoleCredential(role=role, password_hash=password_hash))
        db.commit()
    finally:
        db.close()


def _raw_client(client: TestClient) -> TestClient:
    # `client`'s app is already built; construct an unwrapped TestClient
    # against the same app so login state isn't auto-injected.
    raw = TestClient(client.app)
    _seed_event_and_credentials(client.app)
    return raw


def test_login_succeeds_for_every_role(client):
    raw = _raw_client(client)
    for role in ROLES:
        response = raw.post(
            "/api/auth/login", json={"role": role, "password": TEST_PASSWORD}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert "access_token" in body
        assert "refresh_token" in body
        assert body["expires_in"] == 1800


def test_login_rejects_wrong_password(client):
    raw = _raw_client(client)
    response = raw.post(
        "/api/auth/login", json={"role": "admin", "password": "wrong-password"}
    )
    assert response.status_code == 401


def test_login_rejects_unknown_role(client):
    raw = _raw_client(client)
    response = raw.post(
        "/api/auth/login", json={"role": "coach", "password": TEST_PASSWORD}
    )
    assert response.status_code == 422


def test_refresh_issues_a_new_token_pair(client):
    raw = _raw_client(client)
    login = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": TEST_PASSWORD}
    ).json()

    response = raw.post(
        "/api/auth/refresh", json={"refresh_token": login["refresh_token"]}
    )
    assert response.status_code == 200
    refreshed = response.json()
    # Access tokens carry only `role`, `iat`, `exp` (design spec §3 — no
    # jti or other uniqueness claim), so a login and an immediately
    # following refresh minted within the same wall-clock second produce
    # byte-identical, deterministically-signed JWTs. Uniqueness is only
    # guaranteed for the refresh token itself.
    assert refreshed["refresh_token"] != login["refresh_token"]


def test_replaying_a_rotated_refresh_token_fails(client):
    raw = _raw_client(client)
    login = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": TEST_PASSWORD}
    ).json()
    raw.post("/api/auth/refresh", json={"refresh_token": login["refresh_token"]})

    replay = raw.post(
        "/api/auth/refresh", json={"refresh_token": login["refresh_token"]}
    )
    assert replay.status_code == 401


def test_refresh_rejects_unknown_token(client):
    raw = _raw_client(client)
    response = raw.post(
        "/api/auth/refresh", json={"refresh_token": "not-a-real-token"}
    )
    assert response.status_code == 401


def test_logout_revokes_the_session(client):
    raw = _raw_client(client)
    login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": TEST_PASSWORD}
    ).json()

    # Per design spec §3/§4, logout is reachable by any authenticated
    # role — it is not one of the no-Authorization-header bootstrap
    # endpoints (those are only login/refresh and POST/GET /api/event).
    logout = raw.post(
        "/api/auth/logout",
        json={"refresh_token": login["refresh_token"]},
        headers=bearer(login["access_token"]),
    )
    assert logout.status_code == 204

    replay = raw.post(
        "/api/auth/refresh", json={"refresh_token": login["refresh_token"]}
    )
    assert replay.status_code == 401


def test_logout_cannot_revoke_a_different_roles_session(client):
    raw = _raw_client(client)
    judge_login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": TEST_PASSWORD}
    ).json()
    scorer_token = login_as(raw, "scorer")

    # Scorer holds judge's raw refresh token but is a different role than
    # the session it names — per design spec §3, logout only revokes the
    # caller's own current session, so this must be a no-op (still 204,
    # matching the endpoint's "no error either way" behavior).
    logout = raw.post(
        "/api/auth/logout",
        json={"refresh_token": judge_login["refresh_token"]},
        headers=bearer(scorer_token),
    )
    assert logout.status_code == 204

    # The judge session must still be active.
    replay = raw.post(
        "/api/auth/refresh", json={"refresh_token": judge_login["refresh_token"]}
    )
    assert replay.status_code == 200


def test_logout_as_admin_can_revoke_a_different_roles_session(client):
    raw = _raw_client(client)
    judge_login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": TEST_PASSWORD}
    ).json()
    admin_token = login_as(raw, "admin")

    logout = raw.post(
        "/api/auth/logout",
        json={"refresh_token": judge_login["refresh_token"]},
        headers=bearer(admin_token),
    )
    assert logout.status_code == 204

    replay = raw.post(
        "/api/auth/refresh", json={"refresh_token": judge_login["refresh_token"]}
    )
    assert replay.status_code == 401


def test_logout_requires_authentication(client):
    raw = _raw_client(client)
    response = raw.post("/api/auth/logout", json={"refresh_token": "irrelevant"})
    assert response.status_code == 401


def test_refresh_rejects_expired_token(client):
    from tournament_server.auth import hash_token
    from tournament_server.db import utc_now

    raw = _raw_client(client)
    fake_refresh_token = "expired-refresh-token"
    db = client.app.state.session_factory()
    try:
        now = utc_now()
        db.add(
            AuthSession(
                role="judge",
                refresh_token_hash=hash_token(fake_refresh_token),
                issued_at=now - dt.timedelta(days=15),
                expires_at=now - dt.timedelta(days=1),
            )
        )
        db.commit()
    finally:
        db.close()

    response = raw.post(
        "/api/auth/refresh", json={"refresh_token": fake_refresh_token}
    )
    assert response.status_code == 401


def test_password_change_is_admin_only(client):
    raw = _raw_client(client)
    judge_token = login_as(raw, "judge")

    response = raw.patch(
        "/api/auth/passwords/judge",
        json={"password": "new-password"},
        headers=bearer(judge_token),
    )
    assert response.status_code == 403


def test_password_change_revokes_existing_sessions_for_that_role(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")
    judge_login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": TEST_PASSWORD}
    ).json()

    response = raw.patch(
        "/api/auth/passwords/judge",
        json={"password": "new-judge-password"},
        headers=bearer(admin_token),
    )
    assert response.status_code == 204

    # The old session's refresh token no longer works.
    stale_refresh = raw.post(
        "/api/auth/refresh", json={"refresh_token": judge_login["refresh_token"]}
    )
    assert stale_refresh.status_code == 401

    # The old password no longer logs in; the new one does.
    old_login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": TEST_PASSWORD}
    )
    assert old_login.status_code == 401
    new_login = raw.post(
        "/api/auth/login", json={"role": "judge", "password": "new-judge-password"}
    )
    assert new_login.status_code == 200


def test_password_change_also_stores_the_reversible_copy(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")

    raw.patch(
        "/api/auth/passwords/judge",
        json={"password": "new-judge-password"},
        headers=bearer(admin_token),
    )

    response = raw.get("/api/auth/passwords/judge", headers=bearer(admin_token))
    assert response.status_code == 200
    assert response.json()["password"] == "new-judge-password"


def test_read_password_returns_the_current_plaintext(client):
    raw = TestClient(client.app)
    raw.post("/api/event", json={"name": "Regional Qualifier", "password": TEST_PASSWORD})
    admin_token = login_as(raw, "admin")

    response = raw.get("/api/auth/passwords/scorer", headers=bearer(admin_token))
    assert response.status_code == 200
    assert response.json()["password"] == TEST_PASSWORD


def test_read_password_is_admin_only(client):
    raw = _raw_client(client)
    judge_token = login_as(raw, "judge")

    response = raw.get("/api/auth/passwords/judge", headers=bearer(judge_token))
    assert response.status_code == 403


def test_read_password_401s_without_a_token(client):
    raw = _raw_client(client)

    response = raw.get("/api/auth/passwords/judge")
    assert response.status_code == 401


def test_read_password_422s_for_an_unknown_role(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")

    response = raw.get("/api/auth/passwords/coach", headers=bearer(admin_token))
    assert response.status_code == 422


def test_read_password_returns_null_for_a_credential_predating_this_feature(client):
    # `_raw_client` seeds its event/credentials directly via
    # `_seed_event_and_credentials`, which -- like a database migrated from
    # before this feature existed -- never populates password_encrypted.
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")

    response = raw.get("/api/auth/passwords/judge", headers=bearer(admin_token))
    assert response.status_code == 200
    assert response.json()["password"] is None


def test_session_list_is_admin_only(client):
    raw = _raw_client(client)
    scorer_token = login_as(raw, "scorer")

    response = raw.get("/api/auth/sessions", headers=bearer(scorer_token))
    assert response.status_code == 403


def test_session_list_shows_active_sessions(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")
    raw.post(
        "/api/auth/login",
        json={"role": "scorer", "password": TEST_PASSWORD, "label": "Field 3 tablet"},
    )

    response = raw.get("/api/auth/sessions", headers=bearer(admin_token))
    assert response.status_code == 200
    sessions = response.json()
    labels = {s["label"] for s in sessions}
    assert "Field 3 tablet" in labels
    roles = {s["role"] for s in sessions}
    assert "admin" in roles and "scorer" in roles


def test_session_revoke_is_admin_only(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")
    scorer_login = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": TEST_PASSWORD}
    ).json()
    scorer_token = login_as(raw, "attendee")

    session_id = next(
        s["id"]
        for s in raw.get("/api/auth/sessions", headers=bearer(admin_token)).json()
        if s["role"] == "scorer"
    )

    forbidden = raw.delete(
        f"/api/auth/sessions/{session_id}", headers=bearer(scorer_token)
    )
    assert forbidden.status_code == 403

    response = raw.delete(
        f"/api/auth/sessions/{session_id}", headers=bearer(admin_token)
    )
    assert response.status_code == 204

    replay = raw.post(
        "/api/auth/refresh", json={"refresh_token": scorer_login["refresh_token"]}
    )
    assert replay.status_code == 401


def test_session_revoke_rejects_unknown_id(client):
    raw = _raw_client(client)
    admin_token = login_as(raw, "admin")

    response = raw.delete("/api/auth/sessions/999999", headers=bearer(admin_token))
    assert response.status_code == 404


def test_event_creation_seeds_all_six_roles_with_the_shared_password(client):
    raw = TestClient(client.app)
    raw.post(
        "/api/event", json={"name": "Regional Qualifier", "password": TEST_PASSWORD}
    )
    for role in ROLES:
        response = raw.post(
            "/api/auth/login", json={"role": role, "password": TEST_PASSWORD}
        )
        assert response.status_code == 200, f"{role} could not log in"


def test_changing_one_roles_password_does_not_affect_others(client):
    raw = TestClient(client.app)
    raw.post(
        "/api/event", json={"name": "Regional Qualifier", "password": TEST_PASSWORD}
    )
    admin_token = login_as(raw, "admin")

    raw.patch(
        "/api/auth/passwords/scorer",
        json={"password": "scorer-only-password"},
        headers=bearer(admin_token),
    )

    scorer_old = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": TEST_PASSWORD}
    )
    assert scorer_old.status_code == 401
    scorer_new = raw.post(
        "/api/auth/login", json={"role": "scorer", "password": "scorer-only-password"}
    )
    assert scorer_new.status_code == 200

    for other_role in ("judge", "referee", "attendee", "display_device"):
        response = raw.post(
            "/api/auth/login", json={"role": other_role, "password": TEST_PASSWORD}
        )
        assert response.status_code == 200, f"{other_role} should be unaffected"
