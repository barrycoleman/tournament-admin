def _make_session(client) -> int:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    return client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]


def test_create_field_set(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    )
    assert response.status_code == 201
    body = response.json()
    assert body["session_id"] == session_id
    assert body["name"] == "Main Fields"


def test_create_field_set_rejects_unknown_session(client):
    response = client.post(
        "/api/field-sets", json={"session_id": 999, "name": "Main Fields"}
    )
    assert response.status_code == 404


def test_list_field_sets_for_session(client):
    session_id = _make_session(client)
    client.post("/api/field-sets", json={"session_id": session_id, "name": "Odd Fields"})
    client.post("/api/field-sets", json={"session_id": session_id, "name": "Even Fields"})

    response = client.get(f"/api/field-sets?session_id={session_id}")
    assert response.status_code == 200
    names = {fs["name"] for fs in response.json()}
    assert names == {"Odd Fields", "Even Fields"}


def test_create_field_set_with_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    division_id = client.post("/api/divisions", json={"name": "Red"}).json()["id"]

    response = client.post(
        "/api/field-sets",
        json={
            "session_id": session_id,
            "name": "Red Fields",
            "division_id": division_id,
        },
    )
    assert response.status_code == 201
    assert response.json()["division_id"] == division_id


def test_create_field_set_without_division_defaults_to_none(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/field-sets", json={"session_id": session_id, "name": "Main Fields"}
    )
    assert response.status_code == 201
    assert response.json()["division_id"] is None


def test_create_field_set_rejects_unknown_division(client):
    session_id = _make_session(client)
    response = client.post(
        "/api/field-sets",
        json={"session_id": session_id, "name": "Main Fields", "division_id": 999},
    )
    assert response.status_code == 404
