from ranking_helpers import finalize_qualification


def _setup(client):
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    t1 = client.post("/api/teams", json={"number": "1", "name": "One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Two"}).json()["id"]
    s1 = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    client.post("/api/fields", json={"session_id": s1, "name": "Field 1"})

    def match(number, round_type="qualification"):
        response = client.post("/api/matches", json={
            "session_id": s1, "round_type": round_type, "match_number": number, "field_id": None,
            "alliances": [{"station": "red", "team_ids": [t1]}, {"station": "blue", "team_ids": [t2]}],
        })
        assert response.status_code == 201, response.text
        return response.json()

    played, unplayed = match(1), match(2)
    red = next(a["id"] for a in played["alliances"] if a["station"] == "red")
    assert client.post(
        f"/api/matches/{played['id']}/alliances/{red}/score", json={"data": {"objects_scored": 5}}
    ).status_code == 200
    return s1, match, played, unplayed


def test_finals_require_finalized_qualification(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _setup(client)
    refused = client.post("/api/finals/start", json={"session_id": s1, "bracket_size": 2})
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Finalize this session's qualification before generating finals."
    finalize_qualification(client, s1)
    started = client.post("/api/finals/start", json={"session_id": s1, "bracket_size": 2})
    # Two ranked teams cannot fill a bracket of 2 alliances of 2, but that
    # 422 proves the finalize gate was passed.
    assert started.status_code != 409, started.text


def test_not_played_match_cannot_be_scored_or_started(cooperative_client):
    client = cooperative_client
    s1, _, _, unplayed = _setup(client)
    finalize_qualification(client, s1)
    red = next(a["id"] for a in unplayed["alliances"] if a["station"] == "red")
    scored = client.post(
        f"/api/matches/{unplayed['id']}/alliances/{red}/score", json={"data": {"objects_scored": 5}}
    )
    assert scored.status_code == 409
    assert scored.json()["detail"] == "This match was not played; reopen qualification to score it."
    started = client.post(f"/api/matches/{unplayed['id']}/start")
    assert started.status_code == 409
    assert started.json()["detail"] == "This match was not played; reopen qualification to run it."


def test_completed_match_can_be_corrected_after_finalize(cooperative_client):
    client = cooperative_client
    s1, _, played, _ = _setup(client)
    finalize_qualification(client, s1)
    red = next(a["id"] for a in played["alliances"] if a["station"] == "red")
    assert client.post(
        f"/api/matches/{played['id']}/alliances/{red}/score", json={"data": {"objects_scored": 9}}
    ).status_code == 200


def test_qualification_schedule_changes_refused_after_finalize(cooperative_client):
    client = cooperative_client
    s1, match, _, _ = _setup(client)
    finalize_qualification(client, s1)
    detail = "Qualification is finalized; reopen it to change the schedule."

    created = client.post("/api/matches", json={
        "session_id": s1, "round_type": "qualification", "match_number": 3, "field_id": None,
        "alliances": [{"station": "red", "team_ids": []}, {"station": "blue", "team_ids": []}],
    })
    assert created.status_code == 409 and created.json()["detail"] == detail
    assert match(4, round_type="practice")["round_type"] == "practice"

    cleared = client.delete("/api/schedule", params={"session_id": s1, "round_type": "qualification"})
    assert cleared.status_code == 409 and cleared.json()["detail"] == detail

    generated = client.post("/api/schedule", json={
        "session_id": s1, "scheduler_plugin_name": "simple_random", "dry_run": True,
        "rounds": [{"round_type": "qualification", "target_matches_per_team": 1, "cycle_time_seconds": 300}],
    })
    assert generated.status_code == 409 and generated.json()["detail"] == detail
