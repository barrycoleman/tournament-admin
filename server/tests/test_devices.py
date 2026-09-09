from __future__ import annotations

import datetime as dt
import json

from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from tournament_server.db import utc_now
from tournament_server.models.scoring_device import ScoringDevice


def test_register_device_returns_pending_with_unique_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)

    response = raw.post("/api/devices/register")
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "pending"
    assert "-" in body["friendly_name"]
    assert len(body["device_token"]) > 20

    second = raw.post("/api/devices/register").json()
    assert second["friendly_name"] != body["friendly_name"]
    assert second["device_token"] != body["device_token"]


def test_register_device_requires_no_auth_and_no_event(client):
    # A completely fresh, never-logged-in client with no event created at
    # all can still register — this is a bootstrap endpoint.
    raw = TestClient(client.app)
    response = raw.post("/api/devices/register")
    assert response.status_code == 201


def test_list_devices_is_admin_only(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    raw.post("/api/devices/register")
    scorer_token = login_as(raw, "scorer")

    response = raw.get("/api/devices", headers=bearer(scorer_token))
    assert response.status_code == 403


def test_admin_can_list_and_admit_a_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    device = client.post("/api/devices/register").json()

    listed = client.get("/api/devices").json()
    assert len(listed) == 1
    assert listed[0]["status"] == "pending"
    assert listed[0]["friendly_name"] == device["friendly_name"]

    device_id = listed[0]["id"]
    admitted = client.post(f"/api/devices/{device_id}/admit")
    assert admitted.status_code == 200
    assert admitted.json()["status"] == "admitted"
    assert admitted.json()["admitted_by"] == "admin"

    listed_again = client.get("/api/devices").json()
    assert listed_again[0]["status"] == "admitted"


def test_admit_rejects_unknown_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/devices/999/admit")
    assert response.status_code == 404


def test_admit_and_revoke_are_admin_only(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    raw.post("/api/devices/register")
    scorer_token = login_as(raw, "scorer")

    admit_response = raw.post("/api/devices/1/admit", headers=bearer(scorer_token))
    assert admit_response.status_code == 403
    revoke_response = raw.post("/api/devices/1/revoke", headers=bearer(scorer_token))
    assert revoke_response.status_code == 403


def test_revoke_un_admits_a_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()

    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    response = client.post(f"/api/devices/{device_id}/revoke")
    assert response.status_code == 200
    assert response.json()["status"] == "pending"

    listed = client.get("/api/devices").json()
    matched = next(d for d in listed if d["id"] == device_id)
    assert matched["status"] == "pending"


def test_revoke_rejects_unknown_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/devices/999/revoke")
    assert response.status_code == 404


def test_revoke_is_idempotent_on_a_pending_device(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )

    response = client.post(f"/api/devices/{device_id}/revoke")
    assert response.status_code == 200
    assert response.json()["status"] == "pending"


def test_idle_timeout_flips_admitted_device_to_idle(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    # Simulate the idle timeout having lapsed by seeding a stale
    # last_seen_at directly (matching the auth phase's own pattern for
    # seeding an expired AuthSession in tests/test_auth.py).
    db = client.app.state.session_factory()
    row = db.get(ScoringDevice, device_id)
    row.last_seen_at = utc_now() - dt.timedelta(hours=2)
    db.commit()
    db.close()

    listed = client.get("/api/devices").json()
    matched = next(d for d in listed if d["id"] == device_id)
    assert matched["status"] == "idle"


def test_admit_and_revoke_write_an_audit_trail_without_leaking_the_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )

    client.post(f"/api/devices/{device_id}/admit")

    audit_log = client.get("/api/audit-log").json()
    admit_entries = [
        e for e in audit_log
        if e["table_name"] == "scoring_devices" and e["action"] == "admit"
    ]
    assert len(admit_entries) == 1
    admit_entry = admit_entries[0]
    assert admit_entry["after"]["friendly_name"] == device["friendly_name"]

    serialized = json.dumps(admit_entry)
    assert "device_token_hash" not in serialized
    assert device["device_token"] not in serialized

    client.post(f"/api/devices/{device_id}/revoke")

    audit_log_after_revoke = client.get("/api/audit-log").json()
    revoke_entries = [
        e for e in audit_log_after_revoke
        if e["table_name"] == "scoring_devices" and e["action"] == "revoke"
    ]
    assert len(revoke_entries) == 1
    revoke_entry = revoke_entries[0]
    assert revoke_entry["after"]["admitted_at"] is None
    assert revoke_entry["after"]["admitted_by"] is None

    serialized_revoke = json.dumps(revoke_entry)
    assert "device_token_hash" not in serialized_revoke
    assert device["device_token"] not in serialized_revoke


def test_activity_middleware_updates_last_seen_on_any_request(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    registration = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == registration["friendly_name"]
    )

    db = client.app.state.session_factory()
    row = db.get(ScoringDevice, device_id)
    row.last_seen_at = utc_now() - dt.timedelta(hours=2)
    db.commit()
    db.close()

    attendee_token = login_as(raw, "attendee")
    raw.get(
        "/api/divisions",
        headers={**bearer(attendee_token), "X-Device-Token": registration["device_token"]},
    )

    db2 = client.app.state.session_factory()
    refreshed = db2.get(ScoringDevice, device_id)
    db2.close()
    assert refreshed.last_seen_at > utc_now() - dt.timedelta(minutes=1)
