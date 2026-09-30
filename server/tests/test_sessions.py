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
    assert response.status_code == 401


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


def test_create_session_with_valid_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["timezone"] == "America/Los_Angeles"
    assert body["session_date"] == "2026-09-05"


def test_create_session_rejects_invalid_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/sessions",
        json={"label": "Session 1", "timezone": "Not/A/Real/Zone"},
    )
    assert response.status_code == 422


def test_create_session_without_timezone_defaults_to_none(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/sessions", json={"label": "Session 1"})
    assert response.status_code == 201
    assert response.json()["timezone"] is None


def test_create_session_rejects_empty_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/sessions",
        json={"label": "Session 1", "timezone": ""},
    )
    assert response.status_code == 422


def test_patch_session_updates_given_fields(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.patch(
        f"/api/sessions/{session_id}",
        json={"label": "Saturday", "timezone": "America/Los_Angeles"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["label"] == "Saturday"
    assert body["timezone"] == "America/Los_Angeles"
    assert body["session_date"] is None


def test_patch_session_with_empty_body_is_a_noop(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post(
        "/api/sessions",
        json={"label": "Session 1", "timezone": "America/Los_Angeles"},
    ).json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={})
    assert response.status_code == 200
    body = response.json()
    assert body["label"] == "Session 1"
    assert body["timezone"] == "America/Los_Angeles"


def test_patch_session_can_clear_timezone_and_date(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post(
        "/api/sessions",
        json={
            "label": "Session 1",
            "session_date": "2026-09-05",
            "timezone": "America/Los_Angeles",
        },
    ).json()["id"]

    response = client.patch(
        f"/api/sessions/{session_id}",
        json={"session_date": None, "timezone": None},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["session_date"] is None
    assert body["timezone"] is None


def test_patch_session_rejects_null_label(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.patch(f"/api/sessions/{session_id}", json={"label": None})
    assert response.status_code == 422


def test_patch_session_rejects_invalid_timezone(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.patch(
        f"/api/sessions/{session_id}", json={"timezone": "Not/A/Real/Zone"}
    )
    assert response.status_code == 422


def test_patch_unknown_session_404s(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.patch("/api/sessions/999", json={"label": "Nope"})
    assert response.status_code == 404
