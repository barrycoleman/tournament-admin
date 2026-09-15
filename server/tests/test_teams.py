def test_create_team_assigns_tiebreaker_seed(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response1 = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "organization": "Example School"},
    )
    assert response1.status_code == 201
    body1 = response1.json()
    assert body1["number"] == "1234A"
    assert body1["organization"] == "Example School"
    assert isinstance(body1["tiebreaker_seed"], int)

    response2 = client.post(
        "/api/teams",
        json={"number": "5678B", "name": "Circuit Breakers", "organization": "Another School"},
    )
    assert response2.status_code == 201
    body2 = response2.json()
    assert isinstance(body2["tiebreaker_seed"], int)

    # Verify randomness by confirming two teams have different seeds
    # With random.randint(1, 1_000_000_000), collision probability is vanishingly small
    assert body1["tiebreaker_seed"] != body2["tiebreaker_seed"]


def test_create_team_requires_event(client):
    response = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    assert response.status_code == 401


def test_list_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    client.post("/api/teams", json={"number": "5678B", "name": "Circuit Breakers"})

    response = client.get("/api/teams")
    assert response.status_code == 200
    numbers = {t["number"] for t in response.json()}
    assert numbers == {"1234A", "5678B"}


def test_get_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.get(f"/api/teams/{team_id}")
    assert response.status_code == 200
    assert response.json()["number"] == "1234A"


def test_get_missing_team_returns_404(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.get("/api/teams/999")
    assert response.status_code == 404


def test_update_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"name": "Robo Raiders Renamed"})
    assert response.status_code == 200
    assert response.json()["name"] == "Robo Raiders Renamed"
    assert response.json()["number"] == "1234A"


def test_create_team_with_nonexistent_division_returns_404(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "division_id": 999},
    )
    assert response.status_code == 404


def test_create_team_with_valid_division_succeeds(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_id = client.post("/api/divisions", json={"name": "Elementary"}).json()["id"]

    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "division_id": division_id},
    )
    assert response.status_code == 201
    assert response.json()["division_id"] == division_id


def test_update_team_with_nonexistent_division_returns_404(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"division_id": 999})
    assert response.status_code == 404


def test_update_team_with_null_name_returns_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"name": None})
    assert response.status_code == 422


def test_update_team_with_null_number_returns_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"number": None})
    assert response.status_code == 422


def test_update_team_with_valid_name_still_returns_200(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    response = client.patch(f"/api/teams/{team_id}", json={"name": "New Name"})
    assert response.status_code == 200
    assert response.json()["name"] == "New Name"


def test_create_team_with_robot_name(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "robot_name": "Ironclad"},
    )
    assert response.status_code == 201
    assert response.json()["robot_name"] == "Ironclad"


def test_create_team_duplicate_number_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    response = client.post("/api/teams", json={"number": "1234A", "name": "Circuit Breakers"})
    assert response.status_code == 409


def test_update_team_to_duplicate_number_returns_409(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    second = client.post("/api/teams", json={"number": "5678B", "name": "Circuit Breakers"})
    team_id = second.json()["id"]
    response = client.patch(f"/api/teams/{team_id}", json={"number": "1234A"})
    assert response.status_code == 409


def test_delete_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    created = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})
    team_id = created.json()["id"]

    response = client.delete(f"/api/teams/{team_id}")
    assert response.status_code == 204

    get_response = client.get(f"/api/teams/{team_id}")
    assert get_response.status_code == 404


def test_delete_team_404s_when_not_found(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.delete("/api/teams/999")
    assert response.status_code == 404


def test_delete_team_409s_with_session_participation(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team = client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"}).json()
    session = client.post("/api/sessions", json={"label": "Day 1"}).json()
    client.post(
        f"/api/sessions/{session['id']}/participants",
        json={"team_id": team["id"]},
    )

    response = client.delete(f"/api/teams/{team['id']}")
    assert response.status_code == 409
    assert "participation" in response.json()["detail"].lower()


def test_bulk_upsert_creates_new_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "1234A", "name": "Robo Raiders"},
                {"number": "5678B", "name": "Circuit Breakers", "robot_name": "Ironclad"},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert [r["status"] for r in results] == ["created", "created"]
    assert results[1]["team"]["robot_name"] == "Ironclad"


def test_bulk_upsert_updates_existing_team_by_number(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/teams", json={"number": "1234A", "name": "Robo Raiders"})

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders Renamed"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "updated"
    assert results[0]["team"]["name"] == "Robo Raiders Renamed"

    list_response = client.get("/api/teams")
    assert len(list_response.json()) == 1  # no duplicate created


def test_bulk_upsert_partial_failure_still_commits_good_rows(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "1234A", "name": "Robo Raiders"},
                {"number": "5678B", "name": "Circuit Breakers", "division": "Nonexistent Division"},
                {"number": "9999C", "name": "Third Team"},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "created"
    assert results[1]["status"] == "error"
    assert "Nonexistent Division" in results[1]["error"]
    assert results[2]["status"] == "created"

    list_response = client.get("/api/teams")
    numbers = {t["number"] for t in list_response.json()}
    assert numbers == {"1234A", "9999C"}


def test_bulk_upsert_division_name_is_case_insensitive(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()

    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "1234A", "name": "Robo Raiders", "division": "elementary"}]},
    )
    assert response.status_code == 200
    results = response.json()["results"]
    assert results[0]["status"] == "created"
    assert results[0]["team"]["division_id"] == division["id"]


def test_bulk_upsert_missing_required_field_is_a_row_error(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"number": "", "name": "Robo Raiders"}]},
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["status"] == "error"


def test_bulk_upsert_omitted_required_key_is_a_row_error_not_a_422(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post(
        "/api/teams/bulk",
        json={"rows": [{"name": "Robo Raiders"}]},  # no "number" key at all
    )
    assert response.status_code == 200
    assert response.json()["results"][0]["status"] == "error"


def test_bulk_upsert_assign_random_division_distributes_across_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/divisions", json={"name": "A"})
    client.post("/api/divisions", json={"name": "B"})

    response = client.post(
        "/api/teams/bulk",
        json={
            "rows": [
                {"number": "0001A", "name": "T1", "assign_random_division": True},
                {"number": "0002A", "name": "T2", "assign_random_division": True},
            ]
        },
    )
    assert response.status_code == 200
    results = response.json()["results"]
    division_ids = {r["team"]["division_id"] for r in results}
    assert None not in division_ids
    # With 2 teams and 2 divisions and no pre-existing teams, the
    # balanced algorithm must put one in each.
    assert len(division_ids) == 2


def test_bulk_upsert_empty_rows_is_a_no_op(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/teams/bulk", json={"rows": []})
    assert response.status_code == 200
    assert response.json()["results"] == []
