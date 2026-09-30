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


def test_recheckin_updates_existing_row_instead_of_409ing(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    first = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
    )
    assert first.status_code == 201
    participation_id = first.json()["id"]

    second = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": False},
    )
    assert second.status_code == 201
    assert second.json()["id"] == participation_id
    assert second.json()["checked_in"] is False

    third = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
    )
    assert third.status_code == 201
    assert third.json()["id"] == participation_id
    assert third.json()["checked_in"] is True

    list_response = client.get(f"/api/sessions/{session_id}/participants")
    assert len(list_response.json()) == 1


def test_front_desk_can_check_in_teams(client):
    from tests.auth_helpers import bearer, login_as

    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    front_desk_token = login_as(client, "front_desk")
    response = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
        headers=bearer(front_desk_token),
    )
    assert response.status_code == 201
    assert response.json()["checked_in"] is True


def test_front_desk_cannot_create_sessions(client):
    from tests.auth_helpers import bearer, login_as

    client.post("/api/event", json={"name": "Regional Qualifier"})
    front_desk_token = login_as(client, "front_desk")

    response = client.post(
        "/api/sessions",
        json={"label": "Session 1"},
        headers=bearer(front_desk_token),
    )
    assert response.status_code == 403


def test_other_roles_still_cannot_check_in_teams(client):
    from tests.auth_helpers import bearer, login_as

    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    scorer_token = login_as(client, "scorer")
    response = client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": team_id, "checked_in": True},
        headers=bearer(scorer_token),
    )
    assert response.status_code == 403
