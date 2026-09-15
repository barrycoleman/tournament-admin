from auth_helpers import bearer, login_as


def test_create_and_list_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 201
    division_id = response.json()["id"]

    list_response = client.get("/api/divisions")
    assert list_response.status_code == 200
    assert list_response.json()[0]["id"] == division_id
    assert list_response.json()[0]["name"] == "Elementary"


def test_create_division_requires_event(client):
    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 401


def test_create_division_401s_without_a_token(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)  # a client sharing the same app, no auth header
    response = raw.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 401


def test_create_division_403s_for_non_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.post(
        "/api/divisions", json={"name": "Elementary"}, headers=bearer(attendee_token)
    )
    assert response.status_code == 403


def test_list_divisions_open_to_any_authenticated_role(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.get("/api/divisions", headers=bearer(attendee_token))
    assert response.status_code == 200


def test_create_division_with_target_team_count(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/divisions", json={"name": "Elementary", "target_team_count": 24})
    assert response.status_code == 201
    assert response.json()["target_team_count"] == 24


def test_create_division_without_target_team_count_defaults_to_none(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/divisions", json={"name": "Elementary"})
    assert response.status_code == 201
    assert response.json()["target_team_count"] is None


def test_update_division_name(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()

    response = client.patch(f"/api/divisions/{division['id']}", json={"name": "Elementary School"})
    assert response.status_code == 200
    assert response.json()["name"] == "Elementary School"


def test_update_division_target_team_count(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()

    response = client.patch(f"/api/divisions/{division['id']}", json={"target_team_count": 30})
    assert response.status_code == 200
    assert response.json()["target_team_count"] == 30


def test_update_division_404s_when_not_found(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.patch("/api/divisions/999", json={"name": "x"})
    assert response.status_code == 404


def test_delete_division_unassigns_its_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()
    team = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders", "division_id": division["id"]}
    ).json()

    response = client.delete(f"/api/divisions/{division['id']}")
    assert response.status_code == 204

    team_after = client.get(f"/api/teams/{team['id']}").json()
    assert team_after["division_id"] is None

    list_response = client.get("/api/divisions")
    assert division["id"] not in [d["id"] for d in list_response.json()]


def test_delete_division_404s_when_not_found(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.delete("/api/divisions/999")
    assert response.status_code == 404


def test_randomize_unassigned_only_touches_unassigned_teams(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division = client.post("/api/divisions", json={"name": "Elementary"}).json()
    assigned = client.post(
        "/api/teams", json={"number": "0001A", "name": "Already Assigned", "division_id": division["id"]}
    ).json()
    unassigned = client.post("/api/teams", json={"number": "0002A", "name": "New Team"}).json()

    response = client.post("/api/divisions/randomize", json={"scope": "unassigned"})
    assert response.status_code == 200
    touched_ids = {t["id"] for t in response.json()}
    assert touched_ids == {unassigned["id"]}

    unassigned_after = client.get(f"/api/teams/{unassigned['id']}").json()
    assert unassigned_after["division_id"] == division["id"]
    assigned_after = client.get(f"/api/teams/{assigned['id']}").json()
    assert assigned_after["division_id"] == division["id"]  # untouched, was already here


def test_randomize_all_reassigns_every_team(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    division_a = client.post("/api/divisions", json={"name": "A"}).json()
    division_b = client.post("/api/divisions", json={"name": "B"}).json()
    team1 = client.post(
        "/api/teams", json={"number": "0001A", "name": "T1", "division_id": division_a["id"]}
    ).json()
    team2 = client.post(
        "/api/teams", json={"number": "0002A", "name": "T2", "division_id": division_a["id"]}
    ).json()

    response = client.post("/api/divisions/randomize", json={"scope": "all"})
    assert response.status_code == 200
    touched_ids = {t["id"] for t in response.json()}
    assert touched_ids == {team1["id"], team2["id"]}

    division_ids_after = {
        client.get(f"/api/teams/{team1['id']}").json()["division_id"],
        client.get(f"/api/teams/{team2['id']}").json()["division_id"],
    }
    assert division_ids_after <= {division_a["id"], division_b["id"]}


def test_randomize_404s_with_no_divisions(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/divisions/randomize", json={"scope": "all"})
    assert response.status_code == 404
