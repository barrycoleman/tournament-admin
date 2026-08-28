def test_creating_event_logs_insert_with_default_actor(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.get("/api/audit-log")
    assert response.status_code == 200
    entries = response.json()
    event_entries = [e for e in entries if e["table_name"] == "events" and e["action"] == "insert"]
    assert len(event_entries) == 1
    assert event_entries[0]["actor"] == "admin"
    assert event_entries[0]["before"] is None
    assert event_entries[0]["after"]["name"] == "Regional Qualifier"


def test_creating_team_logs_insert_with_custom_actor(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})

    response = client.post(
        "/api/teams",
        json={"number": "1234A", "name": "Robo Raiders"},
        headers={"X-Actor-Name": "shifty-squirrel"},
    )
    team_id = response.json()["id"]

    entries = client.get("/api/audit-log").json()
    team_entries = [
        e for e in entries if e["table_name"] == "teams" and e["action"] == "insert"
    ]
    assert len(team_entries) == 1
    entry = team_entries[0]
    assert entry["row_pk"] == team_id
    assert entry["actor"] == "shifty-squirrel"
    assert entry["after"]["number"] == "1234A"


def test_updating_team_logs_before_and_after(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    client.patch(f"/api/teams/{team_id}", json={"name": "Renamed Raiders"})

    entries = client.get("/api/audit-log").json()
    update_entries = [
        e for e in entries if e["table_name"] == "teams" and e["action"] == "update"
    ]
    assert len(update_entries) == 1
    entry = update_entries[0]
    assert entry["before"]["name"] == "Robo Raiders"
    assert entry["after"]["name"] == "Renamed Raiders"
    # Unrelated fields shouldn't appear in the diff.
    assert "number" not in entry["before"]


def test_patch_with_no_changes_logs_nothing(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    team_id = client.post(
        "/api/teams", json={"number": "1234A", "name": "Robo Raiders"}
    ).json()["id"]

    before_count = len(client.get("/api/audit-log").json())
    client.patch(f"/api/teams/{team_id}", json={})
    after_count = len(client.get("/api/audit-log").json())

    assert before_count == after_count
