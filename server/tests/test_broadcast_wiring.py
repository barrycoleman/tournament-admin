from __future__ import annotations

from fastapi.testclient import TestClient

from test_finals import _rank_teams_directly, _setup_ranked_teams


def test_score_saved_broadcasts_on_session_channel(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Qualification"}).json()["id"]
    client.post("/api/teams", json={"number": "101", "name": "Alpha"})
    client.post("/api/teams", json={"number": "102", "name": "Beta"})
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "alliances": [
                {"station": "red", "team_ids": [1]},
                {"station": "blue", "team_ids": [2]},
            ],
        },
    ).json()
    raw = TestClient(client.app)
    admin_token = client.headers["Authorization"].removeprefix("Bearer ")

    with raw.websocket_connect(
        f"/ws/session/{session_id}?token={admin_token}"
    ) as ws:
        alliance_id = match["alliances"][0]["id"]
        client.post(
            f"/api/matches/{match['id']}/alliances/{alliance_id}/score",
            json={"data": {"high_balls": 1, "low_balls": 0, "parked": False}, "force": True},
        )
        received = ws.receive_json()

    assert received == {
        "event": "score_saved",
        "data": {"match_id": match["id"], "alliance_id": alliance_id},
    }


def test_new_match_created_broadcasts_for_schedule_generation(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Qualification"}).json()["id"]
    for i in range(4):
        team_id = client.post(
            "/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}
        ).json()["id"]
        client.post(
            f"/api/sessions/{session_id}/participants",
            json={"team_id": team_id, "checked_in": True},
        )
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    raw = TestClient(client.app)
    admin_token = client.headers["Authorization"].removeprefix("Bearer ")

    with raw.websocket_connect(
        f"/ws/session/{session_id}?token={admin_token}"
    ) as ws:
        response = client.post(
            "/api/schedule",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "target_matches_per_team": 1,
                "scheduler_plugin_name": "simple_random",
            },
        )
        assert response.status_code == 201
        received = ws.receive_json()

    assert received["event"] == "new_match_created"
    assert received["data"]["session_id"] == session_id


def test_new_match_created_broadcasts_for_a_finals_generated_match(cooperative_client):
    """Covers `realtime.broadcast_new_finals_matches`.

    A finals match isn't created by `POST /api/matches` or by schedule
    generation — the bracket service creates it as a side effect, so it
    needs its own before/after diff to announce. cooperative-game is
    seed_pairing + score_chase, so `POST /api/finals/start` forms the
    alliances and creates the worst seed's first run in the same call.
    """
    client = cooperative_client
    session_id, team_ids = _setup_ranked_teams(client, 4)
    _rank_teams_directly(client, session_id, team_ids)

    raw = TestClient(client.app)
    admin_token = client.headers["Authorization"].removeprefix("Bearer ")

    with raw.websocket_connect(f"/ws/session/{session_id}?token={admin_token}") as ws:
        response = client.post(
            "/api/finals/start", json={"session_id": session_id, "bracket_size": 2}
        )
        assert response.status_code == 201
        received = ws.receive_json()

    assert received["event"] == "new_match_created"
    assert received["data"]["session_id"] == session_id
    assert received["data"]["match_id"] is not None

    finals_match_ids = {
        m["id"]
        for m in client.get(f"/api/matches?session_id={session_id}").json()
        if m["round_type"] == "elimination"
    }
    assert received["data"]["match_id"] in finals_match_ids


def test_ranking_updated_broadcasts_after_a_completed_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Qualification"}).json()["id"]
    client.post("/api/teams", json={"number": "101", "name": "Alpha"})
    client.post("/api/teams", json={"number": "102", "name": "Beta"})
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "alliances": [
                {"station": "red", "team_ids": [1]},
                {"station": "blue", "team_ids": [2]},
            ],
        },
    ).json()
    raw = TestClient(client.app)
    admin_token = client.headers["Authorization"].removeprefix("Bearer ")

    with raw.websocket_connect(
        f"/ws/session/{session_id}?token={admin_token}"
    ) as ws:
        for alliance in match["alliances"]:
            client.post(
                f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
                json={"data": {"high_balls": 1, "low_balls": 0, "parked": False}, "force": True},
            )
        # Each of the 2 score submissions broadcasts its own "score_saved";
        # the second submission also completes the match, triggering a
        # third message, "ranking_updated", from the recompute it causes.
        events = [ws.receive_json() for _ in range(3)]

    assert any(e["event"] == "ranking_updated" for e in events)


def test_active_session_changed_broadcasts_on_active_session_channel(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    session_id = client.post("/api/sessions", json={"label": "Qualification"}).json()["id"]
    raw = TestClient(client.app)
    admin_token = client.headers["Authorization"].removeprefix("Bearer ")

    with raw.websocket_connect(f"/ws/active-session?token={admin_token}") as ws:
        client.post("/api/event/active-session", json={"session_id": session_id})
        received = ws.receive_json()

    assert received == {
        "event": "active_session_changed",
        "data": {"active_session_id": session_id},
    }
