def _setup_cooperative_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
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
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    return match["id"], red_id, blue_id, t1, t2


def test_submitting_to_one_alliance_mirrors_data_and_completes_match(cooperative_client):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 20

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "completed"

    blue_response = client.get(f"/api/matches/{match_id}").json()
    blue_alliance = next(a for a in blue_response["alliances"] if a["id"] == blue_id)
    assert blue_alliance["team_ids"] == [t2]


def test_dq_on_one_alliance_does_not_affect_the_other(cooperative_client):
    client = cooperative_client
    match_id, red_id, blue_id, t1, t2 = _setup_cooperative_match(client)

    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )

    dq_response = client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"objects_scored": 10}, "dq": True},
    )
    assert dq_response.status_code == 200
    assert dq_response.json()["computed_score"] == 0

    red_after = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"objects_scored": 10}},
    )
    assert red_after.status_code == 200
    assert red_after.json()["computed_score"] == 20
    assert red_after.json()["dq"] is False
