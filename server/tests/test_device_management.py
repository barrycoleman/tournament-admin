from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from device_helpers import paired_device


@pytest.fixture
def admin(client):
    client.post("/api/event", json={"name": "Devices Event"})
    return client


def _device_row(admin, device_id):
    return next(d for d in admin.get("/api/devices").json() if d["id"] == device_id)


def test_rename_and_change_role(admin):
    device = paired_device(admin, name="Tab")
    response = admin.patch(f"/api/devices/{device['id']}", json={"name": "Field 2 Tablet", "role": "referee"})
    assert response.status_code == 200
    assert response.json()["name"] == "Field 2 Tablet"
    assert response.json()["role"] == "referee"


def test_rename_refuses_duplicates_ignoring_case_but_allows_a_case_change_of_itself(admin):
    paired_device(admin, name="Pit TV")
    device = paired_device(admin, name="Tab")
    assert admin.patch(f"/api/devices/{device['id']}", json={"name": "PIT tv"}).status_code == 409
    assert admin.patch(f"/api/devices/{device['id']}", json={"name": "TAB"}).status_code == 200


@pytest.mark.parametrize("body", [{"role": "admin"}, {"name": "  "}, {"name": None}, {"role": None}])
def test_patch_refuses_bad_values(admin, body):
    device = paired_device(admin)
    assert admin.patch(f"/api/devices/{device['id']}", json=body).status_code == 422


def test_a_role_change_applies_on_the_next_request(admin):
    device = paired_device(admin, role="judge")
    raw = TestClient(admin.app)
    assert raw.get("/api/devices/me", headers=device["headers"]).json()["role"] == "judge"
    admin.patch(f"/api/devices/{device['id']}", json={"role": "scorer"})
    assert raw.get("/api/devices/me", headers=device["headers"]).json()["role"] == "scorer"


def test_disable_takes_effect_on_the_next_request_and_enable_restores(admin):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    assert admin.post(f"/api/devices/{device['id']}/disable").json()["status"] == "disabled"
    assert raw.get("/api/teams", headers=device["headers"]).status_code == 403
    signed_in = raw.post("/api/auth/device", json={"device_token": device["device_token"]})
    assert signed_in.status_code == 403
    assert signed_in.json()["status"] == "disabled"
    assert admin.post(f"/api/devices/{device['id']}/enable").json()["status"] == "active"
    assert raw.get("/api/teams", headers=device["headers"]).status_code == 200


def test_enable_clears_idle(admin):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.device import Device

    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(hours=5)
    db.commit()
    db.close()
    assert _device_row(admin, device["id"])["status"] == "idle"
    assert admin.post(f"/api/devices/{device['id']}/enable").json()["status"] == "active"


def test_delete_makes_the_next_request_401(admin):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    assert admin.delete(f"/api/devices/{device['id']}").status_code == 204
    assert raw.get("/api/teams", headers=device["headers"]).status_code == 401
    assert raw.post("/api/auth/device", json={"device_token": device["device_token"]}).status_code == 401


def test_unknown_device_ids_are_404(admin):
    assert admin.patch("/api/devices/999", json={"name": "x"}).status_code == 404
    assert admin.post("/api/devices/999/disable").status_code == 404
    assert admin.post("/api/devices/999/enable").status_code == 404
    assert admin.delete("/api/devices/999").status_code == 404


def test_idle_setting_reads_writes_and_bounds(admin):
    assert admin.get("/api/devices/settings").json() == {"idle_minutes": 240}
    assert admin.put("/api/devices/settings", json={"idle_minutes": 30}).json() == {"idle_minutes": 30}
    assert admin.get("/api/devices/settings").json() == {"idle_minutes": 30}
    assert admin.put("/api/devices/settings", json={"idle_minutes": 14}).status_code == 422
    assert admin.put("/api/devices/settings", json={"idle_minutes": 1441}).status_code == 422


def test_a_shorter_idle_setting_applies_at_once(admin):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.device import Device

    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(minutes=20)
    db.commit()
    db.close()
    assert _device_row(admin, device["id"])["status"] == "active"
    admin.put("/api/devices/settings", json={"idle_minutes": 15})
    assert _device_row(admin, device["id"])["status"] == "idle"


def test_me_needs_a_paired_device(admin):
    raw = TestClient(admin.app)
    assert raw.get("/api/devices/me", headers=bearer(login_as(raw, "scorer"))).status_code == 404
    device = paired_device(admin, name="Pit TV", role="display_device")
    me = raw.get("/api/devices/me", headers=device["headers"]).json()
    assert me == {"id": device["id"], "name": "Pit TV", "role": "display_device", "status": "active"}


@pytest.mark.parametrize("role", ["scorer", "referee", "judge", "attendee", "display_device", "front_desk"])
def test_management_is_admin_only(admin, role):
    device = paired_device(admin)
    raw = TestClient(admin.app)
    headers = bearer(login_as(raw, role))
    assert raw.patch(f"/api/devices/{device['id']}", json={"name": "x"}, headers=headers).status_code == 403
    assert raw.post(f"/api/devices/{device['id']}/disable", headers=headers).status_code == 403
    assert raw.post(f"/api/devices/{device['id']}/enable", headers=headers).status_code == 403
    assert raw.delete(f"/api/devices/{device['id']}", headers=headers).status_code == 403
    assert raw.get("/api/devices/settings", headers=headers).status_code == 403
    assert raw.put("/api/devices/settings", json={"idle_minutes": 30}, headers=headers).status_code == 403


def test_each_action_writes_one_curated_audit_entry_without_the_token(admin):
    from tournament_server.audit import AuditLog

    device = paired_device(admin, name="Tab")
    admin.patch(f"/api/devices/{device['id']}", json={"name": "Tab 2"})
    admin.post(f"/api/devices/{device['id']}/disable")
    admin.post(f"/api/devices/{device['id']}/enable")
    admin.delete(f"/api/devices/{device['id']}")
    db = admin.app.state.session_factory()
    rows = db.query(AuditLog).filter(AuditLog.table_name == "devices").order_by(AuditLog.id).all()
    db.close()
    assert [r.action for r in rows] == ["pair", "update", "disable", "enable", "delete"]
    for row in rows:
        text = f"{row.before_json} {row.after_json}"
        assert "token" not in text
    assert json.loads(rows[1].after_json)["name"] == "Tab 2"
    assert rows[-1].after_json is None


def test_the_idle_setting_writes_one_curated_audit_entry(admin):
    from tournament_server.audit import AuditLog

    admin.put("/api/devices/settings", json={"idle_minutes": 30})
    db = admin.app.state.session_factory()
    rows = db.query(AuditLog).filter(AuditLog.table_name == "devices").order_by(AuditLog.id).all()
    db.close()
    assert len(rows) == 1
    assert rows[0].action == "idle_setting"
    assert rows[0].row_pk is None
    assert json.loads(rows[0].before_json) == {"idle_minutes": 240}
    assert json.loads(rows[0].after_json) == {"idle_minutes": 30}
