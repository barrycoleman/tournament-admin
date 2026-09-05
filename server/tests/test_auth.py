from __future__ import annotations

from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import TEST_PASSWORD, bearer, login_as
from tournament_server.auth import ROLES, hash_password
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
