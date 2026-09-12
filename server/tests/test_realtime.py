from __future__ import annotations

import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient

from tournament_server import realtime
from tournament_server.app import create_app
from tournament_server.db import init_db, make_engine, make_session_factory
from tournament_server.models.event import Event


class _FakeWebSocket:
    def __init__(self) -> None:
        self.received: list[dict] = []
        self.closed = False

    async def send_json(self, message: dict) -> None:
        if self.closed:
            raise RuntimeError("cannot send to a closed fake websocket")
        self.received.append(message)


@pytest.fixture()
def running_loop():
    loop = asyncio.new_event_loop()
    thread = threading.Thread(target=loop.run_forever, daemon=True)
    thread.start()
    yield loop
    loop.call_soon_threadsafe(loop.stop)
    thread.join(timeout=5)
    loop.close()


class _FakeApp:
    def __init__(self) -> None:
        self.state = type("State", (), {})()


def _wait_for(predicate, timeout=2.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.01)
    return False


def test_broadcast_active_session_delivers_to_all_subscribers(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    ws1, ws2 = _FakeWebSocket(), _FakeWebSocket()
    realtime.register_active_session(app, ws1)
    realtime.register_active_session(app, ws2)

    realtime.broadcast_active_session(app, "match_phase_changed", {"match_id": 1})

    assert _wait_for(lambda: ws1.received and ws2.received)
    assert ws1.received == [{"event": "match_phase_changed", "data": {"match_id": 1}}]
    assert ws2.received == ws1.received


def test_broadcast_active_session_with_no_subscribers_is_a_noop(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)

    realtime.broadcast_active_session(app, "match_phase_changed", {"match_id": 1})
    # No exception, no hang — nothing to assert beyond "this returns".


def test_broadcast_session_only_delivers_to_that_sessions_subscribers(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    ws_session_1, ws_session_2 = _FakeWebSocket(), _FakeWebSocket()
    realtime.register_session(app, 1, ws_session_1)
    realtime.register_session(app, 2, ws_session_2)

    realtime.broadcast_session(app, 1, "score_saved", {"match_id": 5})

    assert _wait_for(lambda: ws_session_1.received)
    time.sleep(0.1)
    assert ws_session_2.received == []


def test_unregister_removes_a_subscriber(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    ws = _FakeWebSocket()
    realtime.register_active_session(app, ws)
    realtime.unregister_active_session(app, ws)

    realtime.broadcast_active_session(app, "match_phase_changed", {"match_id": 1})

    time.sleep(0.1)
    assert ws.received == []


def test_unregister_session_cleans_up_empty_session_entry(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    ws = _FakeWebSocket()
    realtime.register_session(app, 42, ws)
    realtime.unregister_session(app, 42, ws)

    assert 42 not in app.state.realtime.by_session


def test_broadcast_survives_a_dead_subscriber_and_removes_it(running_loop):
    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    dead = _FakeWebSocket()
    dead.closed = True
    alive = _FakeWebSocket()
    realtime.register_active_session(app, dead)
    realtime.register_active_session(app, alive)

    realtime.broadcast_active_session(app, "match_phase_changed", {"match_id": 1})

    assert _wait_for(lambda: alive.received)
    assert dead not in app.state.realtime.active_session


def test_lifespan_captures_the_event_loop_only_once_entered(tmp_path):
    """Regression test: a bare, un-entered TestClient never runs the ASGI
    lifespan, so app.state.realtime.event_loop stays None — only
    `with TestClient(app) as client:` actually starts it. Every fixture in
    conftest.py must enter the TestClient as a context manager, or every
    broadcast_* call silently no-ops."""
    db_path = str(tmp_path / "test.db")
    plugins_root = str(tmp_path / "plugins")

    app = create_app(db_path=db_path, plugins_root=plugins_root)
    assert app.state.realtime.event_loop is None

    with TestClient(app) as client:
        response = client.get("/health")
        assert response.status_code == 200
        assert app.state.realtime.event_loop is not None


def _session_factory(tmp_path):
    engine = make_engine(str(tmp_path / "test.db"))
    init_db(engine)
    return make_session_factory(engine)()


def test_broadcast_for_session_also_broadcasts_active_session_when_matching(
    tmp_path, running_loop
):
    db = _session_factory(tmp_path)
    db.add(Event(name="Regional Qualifier", active_session_id=1))
    db.commit()

    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    session_subscriber = _FakeWebSocket()
    active_subscriber = _FakeWebSocket()
    realtime.register_session(app, 1, session_subscriber)
    realtime.register_active_session(app, active_subscriber)

    realtime.broadcast_for_session(app, db, 1, "score_saved", {"match_id": 5})

    assert _wait_for(lambda: session_subscriber.received and active_subscriber.received)
    assert session_subscriber.received == [
        {"event": "score_saved", "data": {"match_id": 5}}
    ]
    assert active_subscriber.received == session_subscriber.received


def test_broadcast_for_session_skips_active_session_when_not_the_active_one(
    tmp_path, running_loop
):
    db = _session_factory(tmp_path)
    db.add(Event(name="Regional Qualifier", active_session_id=1))
    db.commit()

    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    session_subscriber = _FakeWebSocket()
    active_subscriber = _FakeWebSocket()
    realtime.register_session(app, 2, session_subscriber)
    realtime.register_active_session(app, active_subscriber)

    realtime.broadcast_for_session(app, db, 2, "score_saved", {"match_id": 5})

    assert _wait_for(lambda: session_subscriber.received)
    time.sleep(0.1)
    assert active_subscriber.received == []


def test_broadcast_for_session_skips_active_session_when_no_event_row(
    tmp_path, running_loop
):
    db = _session_factory(tmp_path)

    app = _FakeApp()
    realtime.init_realtime_state(app)
    realtime.set_event_loop(app, running_loop)
    session_subscriber = _FakeWebSocket()
    active_subscriber = _FakeWebSocket()
    realtime.register_session(app, 1, session_subscriber)
    realtime.register_active_session(app, active_subscriber)

    realtime.broadcast_for_session(app, db, 1, "score_saved", {"match_id": 5})

    assert _wait_for(lambda: session_subscriber.received)
    time.sleep(0.1)
    assert active_subscriber.received == []
