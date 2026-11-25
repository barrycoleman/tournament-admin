from skills_helpers import next_event
from test_finals import _rank_teams_directly, _session_socket, _setup_ranked_teams


def _ranked(client, count):
    session_id, team_ids = _setup_ranked_teams(client, count)
    _rank_teams_directly(client, session_id, team_ids)
    return session_id, team_ids


def _exclude(client, session_id, team_id, reason="left_early"):
    return client.post(
        "/api/finals/exclusions",
        json={"session_id": session_id, "division_id": None, "team_id": team_id, "reason": reason},
    )


def test_exclude_and_list(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 4)
    response = _exclude(client, session_id, team_ids[1])
    assert response.status_code == 201, response.text
    listed = client.get("/api/finals/exclusions", params={"session_id": session_id}).json()
    assert len(listed) == 1
    assert listed[0]["team_id"] == team_ids[1]
    assert listed[0]["reason"] == "left_early"
    # Re-posting the same team updates its reason rather than duplicating.
    assert _exclude(client, session_id, team_ids[1], "disqualified").status_code == 201
    listed = client.get("/api/finals/exclusions", params={"session_id": session_id}).json()
    assert [(e["team_id"], e["reason"]) for e in listed] == [(team_ids[1], "disqualified")]


def test_reason_must_be_known(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 4)
    assert _exclude(client, session_id, team_ids[0], "bored").status_code == 422


def test_unexclude(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 4)
    created = _exclude(client, session_id, team_ids[0]).json()
    assert client.delete(f"/api/finals/exclusions/{created['id']}").status_code == 204
    assert client.get("/api/finals/exclusions", params={"session_id": session_id}).json() == []


def test_start_skips_excluded_teams(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 6)
    assert _exclude(client, session_id, team_ids[2]).status_code == 201
    response = client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2})
    assert response.status_code == 201, response.text
    alliances = sorted(response.json()["alliances"], key=lambda a: a["seed"])
    assert [a["team_ids"] for a in alliances] == [
        [team_ids[0], team_ids[1]],
        [team_ids[3], team_ids[4]],
    ]


def test_exclusions_locked_while_bracket_exists(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 5)
    created = _exclude(client, session_id, team_ids[4]).json()
    assert client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2}).status_code == 201
    assert _exclude(client, session_id, team_ids[2]).status_code == 409
    assert client.delete(f"/api/finals/exclusions/{created['id']}").status_code == 409


def test_exclusions_survive_start_over(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 6)
    _exclude(client, session_id, team_ids[5])
    bracket = client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2}).json()
    assert client.delete(f"/api/finals/{bracket['id']}").status_code == 204
    assert len(client.get("/api/finals/exclusions", params={"session_id": session_id}).json()) == 1
    assert _exclude(client, session_id, team_ids[4]).status_code == 201


def test_exclusion_broadcasts_finals_changed(cooperative_client):
    client = cooperative_client
    session_id, team_ids = _ranked(client, 4)
    expected = {"session_id": session_id, "bracket_id": None}
    with _session_socket(client, session_id) as socket:
        created = _exclude(client, session_id, team_ids[0]).json()
        assert next_event(socket, "finals_changed")["data"] == expected
        assert client.delete(f"/api/finals/exclusions/{created['id']}").status_code == 204
        assert next_event(socket, "finals_changed")["data"] == expected
