from __future__ import annotations

import datetime as dt

import jwt
import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from device_helpers import paired_device
from tournament_server.db import utc_now
from tournament_server.models.device import Device


@pytest.fixture
def admin(client):
    client.post("/api/event", json={"name": "Pairing Event"})
    return client


def _open(admin):
    return TestClient(admin.app).post("/api/pairing").json()


def test_requesting_a_code_needs_no_login(admin):
    response = TestClient(admin.app).post("/api/pairing")
    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"id", "code", "poll_key", "expires_at", "expires_in"}
    assert len(body["code"]) == 6
    assert body["expires_in"] == 300


def test_checking_a_code_returns_its_suggested_name(admin):
    pending = _open(admin)
    response = admin.get(f"/api/pairing/codes/{pending['code']}")
    assert response.status_code == 200
    assert response.json()["code"] == pending["code"]
    assert response.json()["suggested_name"]


@pytest.mark.parametrize("shape", [str.lower, lambda c: f"{c[:3]} {c[3:]}", lambda c: f"{c[:3]}-{c[3:]}".lower()])
def test_codes_are_accepted_loosely_typed(admin, shape):
    pending = _open(admin)
    assert admin.get(f"/api/pairing/codes/{shape(pending['code'])}").status_code == 200
    paired = admin.post("/api/devices/pair", json={"code": shape(pending["code"]), "role": "scorer", "name": "Tab"})
    assert paired.status_code == 201


def test_an_unknown_code_is_404_with_the_message(admin):
    response = admin.get("/api/pairing/codes/AAAAAA")
    assert response.status_code == 404
    assert response.json()["detail"] == "That code isn't valid or has expired."
    paired = admin.post("/api/devices/pair", json={"code": "AAAAAA", "role": "scorer", "name": "Tab"})
    assert paired.status_code == 404
    assert paired.json()["detail"] == "That code isn't valid or has expired."


def test_checking_and_pairing_are_admin_only(admin):
    pending = _open(admin)
    raw = TestClient(admin.app)
    scorer = bearer(login_as(raw, "scorer"))
    assert raw.get(f"/api/pairing/codes/{pending['code']}", headers=scorer).status_code == 403
    body = {"code": pending["code"], "role": "scorer", "name": "Tab"}
    assert raw.post("/api/devices/pair", json=body, headers=scorer).status_code == 403
    assert raw.get("/api/devices", headers=scorer).status_code == 403


@pytest.mark.parametrize("role", ["scorer", "referee", "judge", "front_desk", "display_device"])
def test_each_pairable_role_can_be_paired(admin, role):
    device = paired_device(admin, role=role)
    listed = {d["id"]: d for d in admin.get("/api/devices").json()}
    assert listed[device["id"]]["role"] == role
    assert listed[device["id"]]["status"] == "active"


@pytest.mark.parametrize("role", ["admin", "attendee", "wizard"])
def test_admin_attendee_and_unknown_roles_cannot_be_paired(admin, role):
    pending = _open(admin)
    response = admin.post("/api/devices/pair", json={"code": pending["code"], "role": role, "name": "Tab"})
    assert response.status_code == 422


@pytest.mark.parametrize("name", ["", "   ", "x" * 101])
def test_blank_and_overlong_names_are_refused(admin, name):
    pending = _open(admin)
    response = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": name})
    assert response.status_code == 422


def test_duplicate_names_are_refused_ignoring_case(admin):
    paired_device(admin, name="Field 1 Tablet")
    pending = _open(admin)
    response = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": " field 1 tablet "})
    assert response.status_code == 409
    assert response.json()["detail"] == "A device with that name already exists."


def test_the_same_code_cannot_be_paired_twice(admin):
    pending = _open(admin)
    first = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": "One"})
    second = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "judge", "name": "Two"})
    assert first.status_code == 201
    assert second.status_code == 404
    assert [d["name"] for d in admin.get("/api/devices").json()] == ["One"]


def test_polling_needs_the_right_key_and_hands_the_token_over_once(admin):
    pending = _open(admin)
    raw = TestClient(admin.app)
    url = f"/api/pairing/{pending['id']}"
    assert raw.get(url, headers={"X-Pairing-Key": "wrong"}).status_code == 404
    assert raw.get(url, headers={"X-Pairing-Key": pending["poll_key"]}).json() == {"status": "waiting", "device_token": None}
    admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": "Tab"})
    paired = raw.get(url, headers={"X-Pairing-Key": pending["poll_key"]}).json()
    assert paired["status"] == "paired" and paired["device_token"]
    assert raw.get(url, headers={"X-Pairing-Key": pending["poll_key"]}).status_code == 404


def test_a_device_access_token_carries_its_role_and_id(admin):
    device = paired_device(admin, role="judge")
    claims = jwt.decode(device["access_token"], options={"verify_signature": False})
    assert claims["role"] == "judge"
    assert claims["device_id"] == device["id"]


def test_device_sign_in_with_an_unknown_token_is_401(admin):
    response = TestClient(admin.app).post("/api/auth/device", json={"device_token": "nope"})
    assert response.status_code == 401


def test_device_sign_in_reports_an_idle_device(admin):
    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(hours=5)
    db.commit()
    db.close()
    response = TestClient(admin.app).post("/api/auth/device", json={"device_token": device["device_token"]})
    assert response.status_code == 403
    assert response.json() == {"detail": "This device is disabled", "status": "idle", "name": device["name"]}


def test_an_idle_devices_requests_are_refused_and_do_not_revive_it(admin):
    device = paired_device(admin)
    db = admin.app.state.session_factory()
    stale = utc_now() - dt.timedelta(hours=5)
    db.get(Device, device["id"]).last_seen_at = stale
    db.commit()
    db.close()
    raw = TestClient(admin.app)
    assert raw.get("/api/event", headers=device["headers"]).status_code == 200
    assert raw.get("/api/teams", headers=device["headers"]).status_code == 403
    db = admin.app.state.session_factory()
    assert db.get(Device, device["id"]).last_seen_at == stale
    db.close()


def test_last_seen_is_written_at_most_once_a_minute(admin):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    db = admin.app.state.session_factory()
    first = db.get(Device, device["id"]).last_seen_at
    db.close()
    raw.get("/api/teams", headers=device["headers"])
    db = admin.app.state.session_factory()
    assert db.get(Device, device["id"]).last_seen_at == first
    db.get(Device, device["id"]).last_seen_at = first - dt.timedelta(minutes=2)
    db.commit()
    db.close()
    raw.get("/api/teams", headers=device["headers"])
    db = admin.app.state.session_factory()
    assert db.get(Device, device["id"]).last_seen_at > first - dt.timedelta(minutes=2)
    db.close()


def test_pairing_never_writes_the_audit_log_for_codes_and_polls(admin):
    before = len(admin.get("/api/audit-log").json())
    pending = _open(admin)
    TestClient(admin.app).get(f"/api/pairing/{pending['id']}", headers={"X-Pairing-Key": pending["poll_key"]})
    assert len(admin.get("/api/audit-log").json()) == before


def test_a_non_ascii_pairing_key_is_treated_as_a_wrong_key(admin):
    pending = _open(admin)
    raw = TestClient(admin.app)
    url = f"/api/pairing/{pending['id']}"
    wrong = raw.get(url, headers={"X-Pairing-Key": "wrong"})
    weird = raw.get(url, headers={"X-Pairing-Key": "cl\u00e9-\u043a\u043b\u044e\u0447".encode("utf-8")})
    assert weird.status_code == wrong.status_code == 404
    assert weird.json() == wrong.json()
    assert raw.get(url, headers={"X-Pairing-Key": pending["poll_key"]}).json()["status"] == "waiting"


def test_a_deleted_devices_token_is_refused_as_no_longer_paired(admin):
    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.delete(db.get(Device, device["id"]))
    db.commit()
    db.close()
    response = TestClient(admin.app).get("/api/teams", headers=device["headers"])
    assert response.status_code == 401
    assert response.json()["detail"] == "This device is no longer paired"
    signed_in = TestClient(admin.app).post("/api/auth/device", json={"device_token": device["device_token"]})
    assert signed_in.status_code == 401


def test_a_disabled_devices_requests_are_refused(admin):
    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).disabled_at = utc_now()
    db.commit()
    db.close()
    raw = TestClient(admin.app)
    response = raw.get("/api/teams", headers=device["headers"])
    assert response.status_code == 403
    assert response.json()["detail"] == "This device is disabled"
    signed_in = raw.post("/api/auth/device", json={"device_token": device["device_token"]})
    assert signed_in.status_code == 403
    assert signed_in.json()["status"] == "disabled"


def test_a_devices_role_comes_from_its_row_not_its_token(admin):
    device = paired_device(admin, role="judge")
    raw = TestClient(admin.app)
    assert raw.post("/api/teams", json={"number": "9", "name": "Nine"}, headers=device["headers"]).status_code == 403
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).role = "admin"
    db.commit()
    db.close()
    # The token still says "judge"; the row now says otherwise and wins.
    assert raw.post("/api/teams", json={"number": "9", "name": "Nine"}, headers=device["headers"]).status_code == 201


def test_a_forged_token_is_refused(admin):
    forged = jwt.encode({"role": "admin", "device_id": 1}, "x" * 32, algorithm="HS256")
    response = TestClient(admin.app).get("/api/teams", headers=bearer(forged))
    assert response.status_code == 401


def test_a_display_device_never_goes_idle(admin):
    device = paired_device(admin, role="display_device")
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(days=3)
    db.commit()
    db.close()
    assert TestClient(admin.app).get("/api/teams", headers=device["headers"]).status_code == 200


def test_signing_in_returns_the_device_and_a_fresh_token(admin):
    device = paired_device(admin, role="referee", name="Ref Tablet")
    response = TestClient(admin.app).post("/api/auth/device", json={"device_token": device["device_token"]})
    assert response.status_code == 200
    body = response.json()
    assert body["device"] == {"id": device["id"], "name": "Ref Tablet", "role": "referee", "status": "active"}
    assert body["expires_in"] == 1800


def test_pairing_writes_one_curated_audit_entry_without_the_token_hash(admin):
    before = admin.get("/api/audit-log").json()
    device = paired_device(admin, name="Audit Tab")
    after = admin.get("/api/audit-log").json()
    new = [row for row in after if row not in before]
    assert len(new) == 1
    entry = new[0]
    assert entry["table_name"] == "devices" and entry["action"] == "pair" and entry["row_pk"] == device["id"]
    assert entry["before"] is None
    assert entry["after"] == {"name": "Audit Tab", "role": "scorer", "disabled": False}


def test_a_deleted_devices_token_never_speaks_for_a_device_paired_after_it(admin):
    paired_device(admin, name="Older")
    deleted = paired_device(admin, name="Newest", role="judge")
    db = admin.app.state.session_factory()
    db.delete(db.get(Device, deleted["id"]))
    db.commit()
    db.close()
    replacement = paired_device(admin, name="Replacement", role="scorer")
    assert replacement["id"] != deleted["id"]
    raw = TestClient(admin.app)
    assert raw.get("/api/teams", headers=deleted["headers"]).status_code == 401
    assert raw.get("/api/teams", headers=replacement["headers"]).status_code == 200


def _set_last_seen(admin, device_id, value):
    db = admin.app.state.session_factory()
    db.get(Device, device_id).last_seen_at = value
    db.commit()
    db.close()


def _last_seen(admin, device_id):
    db = admin.app.state.session_factory()
    try:
        return db.get(Device, device_id).last_seen_at
    finally:
        db.close()


def test_signing_in_does_not_count_as_activity(admin):
    device = paired_device(admin)
    earlier = utc_now() - dt.timedelta(minutes=30)
    _set_last_seen(admin, device["id"], earlier)
    response = TestClient(admin.app).post("/api/auth/device", json={"device_token": device["device_token"]})
    assert response.status_code == 200
    assert _last_seen(admin, device["id"]) == earlier


def test_a_device_that_only_signs_in_still_goes_idle(admin):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    _set_last_seen(admin, device["id"], utc_now() - dt.timedelta(minutes=200))
    # Its renewals keep succeeding while it is inside the idle window...
    assert raw.post("/api/auth/device", json={"device_token": device["device_token"]}).status_code == 200
    # ...but they never moved its last real request, so once the window
    # is shorter than that, the next sign-in finds it idle.
    admin.put("/api/devices/settings", json={"idle_minutes": 180})
    response = raw.post("/api/auth/device", json={"device_token": device["device_token"]})
    assert response.status_code == 403
    assert response.json()["status"] == "idle"


def test_a_second_admin_pairing_the_same_code_with_the_same_name_gets_the_code_error(admin):
    # Two admins open the same code, so both forms are pre-filled with the
    # same suggested name. The second one's lookup ran before the first
    # pairing finished, so it still saw the code open; by the time it checks
    # the name, the first device holds it and the code is spent.
    pending = _open(admin)
    store = admin.app.state.pairing
    stale = store.find_open(pending["code"])
    first = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "scorer", "name": "Tab"})
    assert first.status_code == 201
    real_find_open = store.find_open
    calls = []

    def find_open_seen_before_the_first_pairing(code):
        calls.append(code)
        return stale if len(calls) == 1 else real_find_open(code)

    store.find_open = find_open_seen_before_the_first_pairing
    try:
        second = admin.post("/api/devices/pair", json={"code": pending["code"], "role": "judge", "name": "Tab"})
    finally:
        store.find_open = real_find_open
    assert second.status_code == 404
    assert second.json()["detail"] == "That code isn't valid or has expired."
    assert [d["name"] for d in admin.get("/api/devices").json()] == ["Tab"]
