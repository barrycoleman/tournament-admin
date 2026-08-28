def test_create_team_assigns_tiebreaker_seed(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders", "organization": "Example School"},
    )
    assert response.status_code == 201
    body = response.json()
    assert body["number"] == "1234A"
    assert body["organization"] == "Example School"
    assert isinstance(body["tiebreaker_seed"], int)


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
