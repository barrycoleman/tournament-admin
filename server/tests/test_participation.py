def test_check_in_team_for_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
    )
    assert response.status_code == 201
    assert response.json()["team_id"] == team_id
    assert response.json()["checked_in"] is True


def test_list_participants(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]
    client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": False},
    )

    response = client.get(f"/api/sessions/{session_id}/participants")
    assert response.status_code == 200
    assert len(response.json()) == 1
    assert response.json()[0]["team_id"] == team_id


def test_check_in_requires_existing_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.post(
        "/api/sessions/999/participants", json={"team_id": team_id}
    )
    assert response.status_code == 404


def test_check_in_requires_existing_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]

    response = client.post(
        f"/api/sessions/{session_id}/participants", json={"team_id": 999}
    )
    assert response.status_code == 404


def test_duplicate_checkin_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    first = client.post(
        f"/api/sessions/{session_id}/participants", json={"team_id": team_id}
    )
    assert first.status_code == 201

    second = client.post(
        f"/api/sessions/{session_id}/participants", json={"team_id": team_id}
    )
    assert second.status_code == 409

    # Only one participation row should exist.
    listed = client.get(f"/api/sessions/{session_id}/participants").json()
    assert len(listed) == 1
