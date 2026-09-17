from auth_helpers import bearer, login_as


def test_create_event(client):
    response = client.post("/api/event", json={"name": "Regional Qualifier"})
    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "Regional Qualifier"
    assert body["active_session_id"] is None


def test_create_event_twice_fails(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/event", json={"name": "Another Event"})
    assert response.status_code == 409


def test_get_event_before_creation_returns_404(client):
    response = client.get("/api/event")
    assert response.status_code == 404


def test_get_event_after_creation(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.get("/api/event")
    assert response.status_code == 200
    assert response.json()["name"] == "Regional Qualifier"


def test_created_at_is_timezone_aware(client):
    import datetime as dt

    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.get("/api/event")
    created_at = dt.datetime.fromisoformat(response.json()["created_at"])
    assert created_at.tzinfo is not None


def test_select_game_plugin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert response.status_code == 200
    assert response.json()["game_plugin_name"] == "example-game"


def test_select_game_plugin_requires_event(client):
    response = client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert response.status_code == 401


def test_select_game_plugin_rejects_unknown_plugin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/event/game-plugin", json={"name": "no-such-plugin"})
    assert response.status_code == 404


def test_select_game_plugin_is_immutable(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})

    response = client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert response.status_code == 409


def test_create_event_requires_password(tmp_path):
    from fastapi.testclient import TestClient

    from tournament_server.app import create_app

    app = create_app(db_path=str(tmp_path / "test.db"), plugins_root=str(tmp_path / "plugins"))
    raw_client = TestClient(app)

    response = raw_client.post("/api/event", json={"name": "Regional Qualifier"})
    assert response.status_code == 422


def test_create_event_rejects_empty_password(tmp_path):
    from fastapi.testclient import TestClient

    from tournament_server.app import create_app

    app = create_app(db_path=str(tmp_path / "test.db"), plugins_root=str(tmp_path / "plugins"))
    raw_client = TestClient(app)

    response = raw_client.post(
        "/api/event", json={"name": "Regional Qualifier", "password": ""}
    )
    assert response.status_code == 422


def test_update_event_name_renames_it(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.patch("/api/event", json={"name": "State Championship"})
    assert response.status_code == 200
    assert response.json()["name"] == "State Championship"

    assert client.get("/api/event").json()["name"] == "State Championship"


def test_update_event_name_strips_surrounding_whitespace(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.patch("/api/event", json={"name": "  State Championship  "})
    assert response.status_code == 200
    assert response.json()["name"] == "State Championship"


def test_update_event_name_422s_on_an_empty_name(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.patch("/api/event", json={"name": "   "})
    assert response.status_code == 422
    assert response.json()["detail"] == "Event name cannot be empty"


def test_update_event_name_requires_event(client):
    response = client.patch("/api/event", json={"name": "State Championship"})
    assert response.status_code == 401


def test_update_event_name_401s_without_a_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    response = raw.patch("/api/event", json={"name": "State Championship"})
    assert response.status_code == 401


def test_update_event_name_403s_for_non_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.patch(
        "/api/event", json={"name": "State Championship"}, headers=bearer(attendee_token)
    )
    assert response.status_code == 403


def test_create_event_seeds_a_default_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.get("/api/divisions")
    assert response.status_code == 200
    assert [d["name"] for d in response.json()] == ["Division 1"]
    assert response.json()[0]["target_team_count"] is None
