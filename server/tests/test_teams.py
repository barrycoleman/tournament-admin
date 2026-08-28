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
    assert response.status_code == 404


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
