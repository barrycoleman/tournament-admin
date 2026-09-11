from __future__ import annotations

from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from tournament_server.app import create_app


def test_server_info_requires_auth(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = TestClient(client.app)

    response = raw.get("/api/server-info")

    assert response.status_code == 401


def test_server_info_is_admin_only(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = TestClient(client.app)
    token = login_as(raw, "scorer")

    response = raw.get("/api/server-info", headers=bearer(token))

    assert response.status_code == 403


def test_server_info_returns_port_and_addresses(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.get("/api/server-info")

    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["port"], int)
    assert isinstance(body["addresses"], list)
    assert all(isinstance(a, str) for a in body["addresses"])
    assert "127.0.0.1" not in body["addresses"]


def test_server_info_reports_the_configured_port(tmp_path):
    db_path = str(tmp_path / "custom_port.db")
    plugins_root = str(tmp_path / "plugins")
    app = create_app(db_path=db_path, plugins_root=plugins_root, port=9123)
    raw = TestClient(app)

    raw.post(
        "/api/event", json={"name": "Regional Qualifier", "password": "test-password"}
    )
    token = login_as(raw, "admin", password="test-password")

    response = raw.get("/api/server-info", headers=bearer(token))

    assert response.status_code == 200
    assert response.json()["port"] == 9123
