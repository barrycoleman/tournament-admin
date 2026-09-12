from __future__ import annotations

import datetime as dt

from fastapi.testclient import TestClient


def test_time_sync_requires_no_auth_and_returns_current_utc_time(client):
    raw = TestClient(client.app)

    response = raw.get("/api/time-sync")

    assert response.status_code == 200
    body = response.json()
    server_time = dt.datetime.fromisoformat(body["server_time"])
    now = dt.datetime.now(dt.timezone.utc)
    assert abs((now - server_time).total_seconds()) < 5
