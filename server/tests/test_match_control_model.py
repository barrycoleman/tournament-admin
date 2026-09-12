from __future__ import annotations


def test_match_defaults_to_not_started_phase(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post(
        "/api/event/game-plugin", json={"name": "example-game"}
    )
    session_id = client.post(
        "/api/sessions", json={"label": "Qualification"}
    ).json()["id"]
    client.post("/api/event/active-session", json={"session_id": session_id})
    client.post(
        "/api/teams", json={"number": "101", "name": "Alpha"}
    )
    client.post(
        "/api/teams", json={"number": "102", "name": "Beta"}
    )
    match_response = client.post(
        "/api/matches",
        json={
            "round_type": "qualification",
            "match_number": 1,
            "alliances": [
                {"station": "red", "team_ids": [1]},
                {"station": "blue", "team_ids": [2]},
            ],
        },
    )
    assert match_response.status_code == 201
    body = match_response.json()
    assert body["phase"] == "not_started"
    assert body["phase_deadline"] is None
    assert body["paused"] is False
    assert body["remaining_seconds_at_pause"] is None
