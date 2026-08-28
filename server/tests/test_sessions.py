def test_create_and_list_sessions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/sessions", json={"label": "Session 1"})
    assert response.status_code == 201
    session_id = response.json()["id"]

    list_response = client.get("/api/sessions")
    assert list_response.status_code == 200
    labels = [s["label"] for s in list_response.json()]
    assert labels == ["Session 1"]
    assert list_response.json()[0]["id"] == session_id


def test_create_session_requires_event(client):
    response = client.post("/api/sessions", json={"label": "Session 1"})
    assert response.status_code == 404


def test_set_active_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.post("/api/event/active-session", json={"session_id": session_id})
    assert response.status_code == 200
    assert response.json()["active_session_id"] == session_id


def test_set_active_session_rejects_unknown_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/event/active-session", json={"session_id": 999})
    assert response.status_code == 404
