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
