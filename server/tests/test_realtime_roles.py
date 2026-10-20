"""Role-filtered broadcasts on the active-session channel and the
devices-plus-admins send (live scoring design §8)."""
from __future__ import annotations

import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient

from auth_helpers import login_as
from device_helpers import paired_device
from display_helpers import admin_token, setup_event
from skills_helpers import next_event
from tournament_server import realtime

ROLES = ("admin", "scorer", "referee", "display_device", "attendee")


class _FakeWebSocket:
    def __init__(self) -> None:
        self.received: list[dict] = []
        self.closed = False

    async def send_json(self, message: dict) -> None:
        if self.closed:
            raise RuntimeError("closed")
        self.received.append(message)


class _FakeApp:
    def __init__(self) -> None:
        self.state = type("State", (), {})()


@pytest.fixture()
def app():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    fake = _FakeApp()
    realtime.init_realtime_state(fake)
    realtime.set_event_loop(fake, loop)
    yield fake
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


def _wait_for(predicate, timeout=2.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def _events(ws: _FakeWebSocket) -> list[str]:
    return [message["event"] for message in ws.received]


def _register_every_role(app) -> dict[str, _FakeWebSocket]:
    sockets = {role: _FakeWebSocket() for role in ROLES}
    for role, ws in sockets.items():
        realtime.register_active_session(app, ws, role)
    return sockets


def _then_marker(app, sockets) -> None:
    """An unfiltered marker after the event under test: once every socket has
    it, every earlier send has landed too (one loop, in order)."""
    realtime.broadcast_active_session(app, "marker", {})
    assert _wait_for(lambda: all(_events(ws)[-1:] == ["marker"] for ws in sockets.values()))


def test_a_role_filtered_broadcast_reaches_only_the_listed_roles(app):
    sockets = _register_every_role(app)
    realtime.broadcast_active_session(app, "live_score", {"match_id": 1}, roles=("display_device", "admin"))
    _then_marker(app, sockets)
    assert {role: _events(ws) for role, ws in sockets.items()} == {
        "admin": ["live_score", "marker"],
        "scorer": ["marker"],
        "referee": ["marker"],
        "display_device": ["live_score", "marker"],
        "attendee": ["marker"],
    }
    assert sockets["admin"].received[0]["data"] == {"match_id": 1}


def test_admin_is_never_implied(app):
    sockets = _register_every_role(app)
    realtime.broadcast_active_session(app, "score_draft_changed", {}, roles=("scorer", "referee"))
    _then_marker(app, sockets)
    assert _events(sockets["admin"]) == ["marker"]
    assert _events(sockets["scorer"]) == ["score_draft_changed", "marker"]


def test_without_roles_everyone_still_gets_the_broadcast(app):
    sockets = _register_every_role(app)
    realtime.broadcast_active_session(app, "match_submitted", {"match_id": 3})
    assert _wait_for(lambda: all(_events(ws) == ["match_submitted"] for ws in sockets.values()))


def test_unregistering_forgets_the_role(app):
    ws = _FakeWebSocket()
    realtime.register_active_session(app, ws, "scorer")
    assert app.state.realtime.active_roles[ws] == "scorer"
    realtime.unregister_active_session(app, ws)
    assert ws not in app.state.realtime.active_roles
    assert ws not in app.state.realtime.active_session


def test_a_dead_socket_is_dropped_with_its_role(app):
    dead, alive = _FakeWebSocket(), _FakeWebSocket()
    dead.closed = True
    realtime.register_active_session(app, dead, "display_device")
    realtime.register_active_session(app, alive, "display_device")
    realtime.broadcast_active_session(app, "live_score", {}, roles=("display_device",))
    assert _wait_for(lambda: alive.received and dead not in app.state.realtime.active_roles)
    assert dead not in app.state.realtime.active_session


def test_send_to_devices_and_admins_reaches_admins_and_the_listed_devices_once(app):
    sockets = _register_every_role(app)
    target, other = _FakeWebSocket(), _FakeWebSocket()
    for device_id, ws in ((7, target), (8, other)):
        realtime.register_active_session(app, ws, "scorer")
        realtime.register_device_socket(app, device_id, ws)
    realtime.send_to_devices_and_admins(app, [7], "scorer_binding_changed", {"device_id": 7})
    _then_marker(app, {**sockets, "target": target, "other": other})
    assert _events(sockets["admin"]) == ["scorer_binding_changed", "marker"]
    assert _events(target) == ["scorer_binding_changed", "marker"]
    for name in ("scorer", "referee", "display_device", "attendee"):
        assert _events(sockets[name]) == ["marker"]
    assert _events(other) == ["marker"]


def _events_until_marker(socket) -> list[str]:
    names = []
    while not names or names[-1] != "marker":
        names.append(socket.receive_json()["event"])
    return names


def test_real_sockets_are_registered_with_their_callers_role_and_filtered(client):
    setup_event(client)
    display = paired_device(client, role="display_device")
    scorer_token = login_as(TestClient(client.app), "scorer")
    with (
        client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_ws,
        client.websocket_connect(f"/ws/active-session?token={scorer_token}") as scorer_ws,
        client.websocket_connect(f"/ws/active-session?token={display['access_token']}") as display_ws,
    ):
        registry = client.app.state.realtime
        assert _wait_for(lambda: len(registry.active_roles) == 3)
        assert sorted(registry.active_roles.values()) == ["admin", "display_device", "scorer"]
        realtime.broadcast_active_session(client.app, "live_score", {"match_id": 1}, roles=("display_device",))
        realtime.broadcast_active_session(client.app, "marker", {})
        assert next_event(display_ws, "live_score")["data"] == {"match_id": 1}
        assert "live_score" not in _events_until_marker(admin_ws)
        assert "live_score" not in _events_until_marker(scorer_ws)
    assert _wait_for(lambda: not registry.active_roles)


def test_a_binding_change_reaches_the_device_and_admins_over_real_sockets(client):
    setup_event(client)
    bound = paired_device(client, role="scorer", name="Field 1 Tablet")
    other = paired_device(client, role="scorer", name="Field 2 Tablet")
    with (
        client.websocket_connect(f"/ws/active-session?token={admin_token(client)}") as admin_ws,
        client.websocket_connect(f"/ws/active-session?token={bound['access_token']}") as bound_ws,
        client.websocket_connect(f"/ws/active-session?token={other['access_token']}") as other_ws,
    ):
        assert _wait_for(lambda: len(client.app.state.realtime.active_roles) == 3)
        realtime.send_to_devices_and_admins(client.app, [bound["id"]], "scorer_binding_changed", {"device_id": bound["id"]})
        realtime.broadcast_active_session(client.app, "marker", {})
        assert next_event(admin_ws, "scorer_binding_changed")["data"] == {"device_id": bound["id"]}
        assert next_event(bound_ws, "scorer_binding_changed")["data"] == {"device_id": bound["id"]}
        assert "scorer_binding_changed" not in _events_until_marker(other_ws)
