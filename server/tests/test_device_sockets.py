from __future__ import annotations

import pytest
from starlette.websockets import WebSocketDisconnect

from device_helpers import paired_device
from skills_helpers import next_event


@pytest.fixture
def admin(client):
    client.post("/api/event", json={"name": "Socket Event"})
    return client


def _connect(admin, device):
    return admin.websocket_connect(f"/ws/active-session?token={device['access_token']}")


@pytest.mark.parametrize("action", ["disable", "delete", "role"])
def test_a_device_change_closes_its_sockets_with_4403(admin, action):
    device = paired_device(admin)
    with _connect(admin, device) as socket:
        if action == "disable":
            admin.post(f"/api/devices/{device['id']}/disable")
        elif action == "delete":
            admin.delete(f"/api/devices/{device['id']}")
        else:
            admin.patch(f"/api/devices/{device['id']}", json={"role": "judge"})
        with pytest.raises(WebSocketDisconnect) as closed:
            while True:
                socket.receive_json()
        assert closed.value.code == 4403


def test_a_disabled_device_cannot_open_a_socket(admin):
    device = paired_device(admin)
    admin.post(f"/api/devices/{device['id']}/disable")
    with pytest.raises(WebSocketDisconnect):
        with _connect(admin, device) as socket:
            socket.receive_json()


def test_a_rename_does_not_close_the_socket_and_device_changes_are_broadcast(admin):
    device = paired_device(admin)
    with _connect(admin, device) as socket:
        admin.patch(f"/api/devices/{device['id']}", json={"name": "Renamed"})
        assert next_event(socket, "devices_changed")["data"] == {}


def test_a_deleted_device_cannot_open_a_socket(admin):
    device = paired_device(admin)
    admin.delete(f"/api/devices/{device['id']}")
    with pytest.raises(WebSocketDisconnect):
        with _connect(admin, device) as socket:
            socket.receive_json()


def test_an_idle_device_cannot_open_a_socket(admin):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.device import Device

    device = paired_device(admin)
    db = admin.app.state.session_factory()
    db.get(Device, device["id"]).last_seen_at = utc_now() - dt.timedelta(hours=5)
    db.commit()
    db.close()
    with pytest.raises(WebSocketDisconnect):
        with _connect(admin, device) as socket:
            socket.receive_json()


def test_a_device_takes_its_socket_role_from_its_row(admin):
    from tournament_server import realtime

    device = paired_device(admin, role="scorer")
    with _connect(admin, device):
        assert device["id"] in admin.app.state.realtime.by_device
    assert device["id"] not in admin.app.state.realtime.by_device
    # The admin-only session channel refuses a device whatever its token says.
    with pytest.raises(WebSocketDisconnect):
        with admin.websocket_connect(f"/ws/session/1?token={device['access_token']}") as socket:
            socket.receive_json()
    assert realtime.DEVICE_CHANGED_CLOSE_CODE == 4403
