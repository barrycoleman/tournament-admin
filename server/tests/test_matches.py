def _setup_two_teams(client):
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    team1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    team2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    team3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]
    team4 = client.post("/api/teams", json={"number": "4", "name": "Team Four"}).json()["id"]
    return session_id, team1, team2, team3, team4


def test_create_match_with_two_alliances(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["status"] == "scheduled"
    assert len(body["alliances"]) == 2

    alliances_by_station = {a["station"]: a for a in body["alliances"]}
    assert set(alliances_by_station) == {"red", "blue"}
    assert set(alliances_by_station["red"]["team_ids"]) == {t1, t2}
    assert set(alliances_by_station["blue"]["team_ids"]) == {t3, t4}


def test_create_match_uses_active_session_when_omitted(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)
    client.post("/api/event/active-session", json={"session_id": session_id})

    response = client.post(
        "/api/matches",
        json={
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )
    assert response.status_code == 201
    assert response.json()["session_id"] == session_id


def test_create_match_rejects_wrong_alliance_count(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [{"station": "red", "team_ids": [t1, t2]}],
        },
    )
    assert response.status_code == 422


def test_create_match_rejects_unknown_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [999]},
            ],
        },
    )
    assert response.status_code == 404


def test_create_match_rejects_unknown_division(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "division_id": 999,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )
    assert response.status_code == 404


def test_create_match_rejects_unknown_field(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": 999,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )
    assert response.status_code == 404


def test_list_matches_defaults_to_active_session(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)
    client.post("/api/event/active-session", json={"session_id": session_id})
    client.post(
        "/api/matches",
        json={
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    )

    response = client.get("/api/matches")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_list_matches_with_explicit_session_id(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)

    response = client.get(f"/api/matches?session_id={session_id}")
    assert response.status_code == 200
    assert response.json() == []


def test_get_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id, t1, t2, t3, t4 = _setup_two_teams(client)
    match_id = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()["id"]

    response = client.get(f"/api/matches/{match_id}")
    assert response.status_code == 200
    assert response.json()["id"] == match_id


def test_get_missing_match_returns_404(client):
    response = client.get("/api/matches/999")
    assert response.status_code == 404
