import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from ranking_helpers import DEFAULT_SETTINGS


def test_first_read_returns_defaults_and_no_game_model(client):
    client.post("/api/event", json={"name": "League"})
    response = client.get("/api/ranking-settings")
    assert response.status_code == 200, response.text
    assert response.json() == {**DEFAULT_SETTINGS, "game_model": None}


def test_reports_head_to_head_game_model(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    assert client.get("/api/ranking-settings").json()["game_model"] == "head_to_head"


def test_reports_cooperative_game_model(cooperative_client):
    cooperative_client.post("/api/event", json={"name": "League"})
    cooperative_client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    assert cooperative_client.get("/api/ranking-settings").json()["game_model"] == "cooperative_score"


def test_put_saves_every_field(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    body = {
        "session_drop_mode": "lowest",
        "session_drop_count": 2,
        "session_drop_no_show": True,
        "session_drop_dq": False,
        "season_keep_best": 24,
        "season_only_session_counted": True,
        "season_minimum": 20,
        "season_drop_no_show": False,
        "season_drop_dq": True,
    }
    response = client.put("/api/ranking-settings", json=body)
    assert response.status_code == 200, response.text
    assert response.json() == {**body, "game_model": "cooperative_score"}
    assert client.get("/api/ranking-settings").json() == {**body, "game_model": "cooperative_score"}


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"session_drop_mode": "sometimes"}, "session_drop_mode must be one of: tiered, none, lowest"),
        ({"session_drop_count": 0}, "session_drop_count must be at least 1"),
        ({"season_keep_best": 0}, "season_keep_best must be at least 1 when set"),
        ({"season_minimum": -1}, "season_minimum must be 0 or more"),
        (
            {"season_keep_best": 10, "season_minimum": 11},
            "season_minimum cannot be more than season_keep_best",
        ),
    ],
)
def test_put_rejects_invalid_settings(client, changes, message):
    client.post("/api/event", json={"name": "League"})
    response = client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, **changes})
    assert response.status_code == 422
    assert response.json()["detail"] == message
    assert client.get("/api/ranking-settings").json() == {**DEFAULT_SETTINGS, "game_model": None}


def test_put_is_admin_only_and_get_is_open_to_any_role(client):
    client.post("/api/event", json={"name": "League"})
    raw = TestClient(client.app)
    token = login_as(raw, "scorer")
    assert raw.put("/api/ranking-settings", json=DEFAULT_SETTINGS, headers=bearer(token)).status_code == 403
    assert raw.get("/api/ranking-settings", headers=bearer(token)).status_code == 200


def test_put_without_a_game_plugin_saves(client):
    client.post("/api/event", json={"name": "League"})
    response = client.put(
        "/api/ranking-settings", json={**DEFAULT_SETTINGS, "session_drop_mode": "none"}
    )
    assert response.status_code == 200, response.text
    assert response.json()["session_drop_mode"] == "none"


def test_put_recomputes_existing_rankings(cooperative_client):
    client = cooperative_client
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1]},
                {"station": "blue", "team_ids": [t2]},
            ],
        },
    ).json()
    red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    client.post(f"/api/matches/{match['id']}/alliances/{red}/score", json={"data": {"objects_scored": 10}})

    response = client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, "season_minimum": 2})
    assert response.status_code == 200, response.text
    assert {row["team_id"] for row in client.get(f"/api/rankings?session_id={session_id}").json()} == {t1, t2}
