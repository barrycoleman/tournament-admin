import pytest

from ranking_helpers import DEFAULT_SETTINGS, finalize_qualification


def _event(client, plugin="cooperative-game", team_count=4) -> list[int]:
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": plugin})
    return [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, team_count + 1)
    ]


def _session(client, label="Saturday") -> int:
    return client.post("/api/sessions", json={"label": label}).json()["id"]


def _match(client, session_id, number, red, blue, round_type="qualification", division_id=None) -> dict:
    body = {
        "session_id": session_id,
        "round_type": round_type,
        "match_number": number,
        "field_id": None,
        "alliances": [{"station": "red", "team_ids": [red]}, {"station": "blue", "team_ids": [blue]}],
    }
    if division_id is not None:
        body["division_id"] = division_id
    response = client.post("/api/matches", json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _alliance(match, station):
    return next(a["id"] for a in match["alliances"] if a["station"] == station)


def _score(client, match, objects, station="red", **flags):
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{_alliance(match, station)}/score",
        json={"data": {"objects_scored": objects}, **flags},
    )
    assert response.status_code == 200, response.text


def _preview(client, session_id):
    response = client.get(f"/api/sessions/{session_id}/qualification/finalize-preview")
    assert response.status_code == 200, response.text
    return response.json()


def _finalize(client, session_id, drops):
    return client.post(f"/api/sessions/{session_id}/qualification/finalize", json={"drops": drops})


def _rows(client, **params):
    return {row["team_id"]: row for row in client.get("/api/rankings", params=params).json()}


def _uneven_session(client):
    """Teams 1+2 are scheduled 10 matches and play 8; teams 3+4 play 7 of 10."""
    t1, t2, t3, t4 = _event(client)
    s1 = _session(client)
    first = [_match(client, s1, n, t1, t2) for n in range(1, 11)]
    second = [_match(client, s1, n, t3, t4) for n in range(11, 21)]
    for match, objects in zip(first[:8], range(1, 9)):  # scores 2, 4, ..., 16
        _score(client, match, objects)
    for match, objects in zip(second[:7], range(1, 8)):  # scores 2, 4, ..., 14
        _score(client, match, objects)
    return s1, (t1, t2, t3, t4), first, second


def test_preview_lists_each_played_count_with_team_counts_and_suggestions(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    preview = _preview(client, s1)
    assert preview["finalized"] is False
    assert preview["game_model"] == "cooperative_score"
    assert preview["rows"] == [
        {"played": 7, "teams": 2, "suggested": 1},
        {"played": 8, "teams": 2, "suggested": 2},
    ]
    assert preview["unplayed_matches"] == 5
    assert preview["blockers"] == []


def test_preview_counts_teams_across_divisions_in_one_row(cooperative_client):
    client = cooperative_client
    t1, t2, t3, t4 = _event(client)
    d1 = client.get("/api/divisions").json()[0]["id"]
    d2 = client.post("/api/divisions", json={"name": "Second"}).json()["id"]
    s1 = _session(client)
    _score(client, _match(client, s1, 1, t1, t2, division_id=d1), 5)
    _score(client, _match(client, s1, 2, t3, t4, division_id=d2), 5)
    assert _preview(client, s1)["rows"] == [{"played": 1, "teams": 4, "suggested": 0}]


def test_finalize_marks_unplayed_matches_and_applies_entered_drops(cooperative_client):
    client = cooperative_client
    s1, (t1, _, t3, _), first, second = _uneven_session(client)
    before = _rows(client, session_id=s1)
    assert before[t1]["average_score"] == 9.0  # 2..16, nothing earned yet

    response = _finalize(client, s1, {"7": 0, "8": 2})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["qualification_finalized_at"] is not None
    assert body["qualification_drops"] == {"7": 0, "8": 2}

    statuses = {m["id"]: m["status"] for m in client.get("/api/matches", params={"session_id": s1}).json()}
    assert [statuses[m["id"]] for m in first[8:]] == ["not_played", "not_played"]
    assert [statuses[m["id"]] for m in second[7:]] == ["not_played"] * 3
    after = _rows(client, session_id=s1)
    assert after[t1]["average_score"] == 11.0  # drops 2 and 4: (6+...+16)/6
    assert after[t1]["matches_played"] == 8
    assert after[t3]["average_score"] == 8.0  # 0 drops: (2+...+14)/7


def test_season_uses_finalized_session_drops(cooperative_client):
    client = cooperative_client
    s1, (t1, _, _, _), _, _ = _uneven_session(client)
    client.put("/api/ranking-settings", json={**DEFAULT_SETTINGS, "season_only_session_counted": True})
    assert _finalize(client, s1, {"7": 0, "8": 2}).status_code == 200
    assert _rows(client, event_wide="true")[t1]["average_score"] == 11.0


def test_finalize_twice_is_refused(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    again = _finalize(client, s1, {"7": 1, "8": 2})
    assert again.status_code == 409
    assert "already finalized" in again.json()["detail"]


@pytest.mark.parametrize(
    "drops",
    [
        {"8": 2},  # missing 7
        {"7": 1, "8": 2, "9": 1},  # extra key
        {"7": 7, "8": 2},  # above played - 1
        {"7": -1, "8": 2},
        {"7": "1", "8": 2},
    ],
)
def test_finalize_validates_the_drops_map(cooperative_client, drops):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    assert _finalize(client, s1, drops).status_code == 422
    assert _preview(client, s1)["finalized"] is False


def test_finalize_rejects_boolean_drop_values(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": True, "8": 2}).status_code == 422


def test_blockers_refuse_finalize(cooperative_client):
    client = cooperative_client
    s1, _, first, _ = _uneven_session(client)
    assert client.post(f"/api/matches/{first[8]['id']}/start").status_code == 200
    preview = _preview(client, s1)
    assert preview["blockers"] == [{"code": "in_progress", "count": 1}]
    refused = _finalize(client, s1, {"7": 1, "8": 2})
    assert refused.status_code == 409
    assert "in progress" in refused.json()["detail"]

    assert client.post(f"/api/matches/{first[8]['id']}/end").status_code == 200
    assert _preview(client, s1)["blockers"] == [{"code": "ended_unscored", "count": 1}]


def test_partially_scored_head_to_head_match_blocks(client):
    t1, t2 = _event(client, plugin="example-game", team_count=2)
    s1 = _session(client)
    match = _match(client, s1, 1, t1, t2)
    response = client.post(
        f"/api/matches/{match['id']}/alliances/{_alliance(match, 'red')}/score",
        json={"data": {"high_balls": 3, "low_balls": 0, "auto_winner": "tie"}},
    )
    assert response.status_code == 200, response.text
    assert _preview(client, s1)["blockers"] == [{"code": "partially_scored", "count": 1}]


def test_no_matches_blocks(cooperative_client):
    client = cooperative_client
    _event(client)
    s1 = _session(client)
    assert _preview(client, s1)["blockers"] == [{"code": "no_matches", "count": 0}]
    assert _finalize(client, s1, {}).status_code == 409


def test_head_to_head_finalize_takes_no_drops(client):
    t1, t2 = _event(client, plugin="example-game", team_count=2)
    s1 = _session(client)
    played = _match(client, s1, 1, t1, t2)
    for station in ("red", "blue"):
        client.post(
            f"/api/matches/{played['id']}/alliances/{_alliance(played, station)}/score",
            json={"data": {"high_balls": 3, "low_balls": 0, "auto_winner": "tie"}},
        )
    _match(client, s1, 2, t1, t2)
    preview = _preview(client, s1)
    assert preview["game_model"] == "head_to_head"
    assert preview["rows"] == []
    assert _finalize(client, s1, {"1": 0}).status_code == 422
    response = _finalize(client, s1, {})
    assert response.status_code == 200, response.text
    assert response.json()["qualification_drops"] == {}


def test_finalize_with_nothing_played(cooperative_client):
    client = cooperative_client
    t1, t2, _, _ = _event(client)
    s1 = _session(client)
    _match(client, s1, 1, t1, t2)
    preview = _preview(client, s1)
    assert preview["rows"] == []
    assert preview["unplayed_matches"] == 1
    assert _finalize(client, s1, {}).status_code == 200
    assert _rows(client, session_id=s1) == {}


def test_missing_played_count_in_map_drops_nothing(cooperative_client):
    from tournament_server.models.session import TournamentSession

    client = cooperative_client
    s1, (t1, _, _, _), _, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    with client.app.state.session_factory() as db:
        db.get(TournamentSession, s1).qualification_drops = {"7": 1}
        db.commit()
    client.put("/api/ranking-settings", json=DEFAULT_SETTINGS)  # recomputes every scope
    assert _rows(client, session_id=s1)[t1]["average_score"] == 9.0


def test_reopen_restores_matches_and_rankings(cooperative_client):
    client = cooperative_client
    s1, (t1, _, _, _), first, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    response = client.post(f"/api/sessions/{s1}/qualification/reopen")
    assert response.status_code == 200, response.text
    assert response.json()["qualification_finalized_at"] is None
    assert response.json()["qualification_drops"] is None
    statuses = {m["id"]: m["status"] for m in client.get("/api/matches", params={"session_id": s1}).json()}
    assert statuses[first[9]["id"]] == "scheduled"
    assert _rows(client, session_id=s1)[t1]["average_score"] == 9.0


def test_reopen_refused_when_not_finalized_or_finals_exist(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    assert client.post(f"/api/sessions/{s1}/qualification/reopen").status_code == 409
    client.post("/api/fields", json={"session_id": s1, "name": "Field 1"})
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    started = client.post("/api/finals/start", json={"session_id": s1, "bracket_size": 2})
    assert started.status_code in (200, 201), started.text
    refused = client.post(f"/api/sessions/{s1}/qualification/reopen")
    assert refused.status_code == 409
    assert refused.json()["detail"] == "Delete this session's finals brackets before reopening qualification"


def test_reopen_then_score_then_finalize_again(cooperative_client):
    client = cooperative_client
    s1, (t1, _, _, _), first, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    client.post(f"/api/sessions/{s1}/qualification/reopen")
    _score(client, first[8], 9)  # team 1 now has 9 played
    assert [row["played"] for row in _preview(client, s1)["rows"]] == [7, 9]
    assert _finalize(client, s1, {"7": 1, "9": 2}).status_code == 200
    assert _rows(client, session_id=s1)[t1]["matches_played"] == 9


def test_correcting_a_score_after_finalize_recomputes(cooperative_client):
    client = cooperative_client
    s1, (t1, _, _, _), first, _ = _uneven_session(client)
    assert _finalize(client, s1, {"7": 0, "8": 0}).status_code == 200
    _score(client, first[0], 18)  # 2 -> 36
    assert _rows(client, session_id=s1)[t1]["average_score"] == 13.25  # (36+4+...+16)/8


def test_finalize_and_reopen_broadcast_status(cooperative_client):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    token = client.headers["Authorization"].removeprefix("Bearer ")
    with client.websocket_connect(f"/ws/session/{s1}?token={token}") as socket:
        assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
        events = []
        while not any(e["event"] == "qualification_status_changed" for e in events):
            events.append(socket.receive_json())
        changed = next(e for e in events if e["event"] == "qualification_status_changed")
        assert changed["data"] == {"session_id": s1, "finalized": True}
        assert client.post(f"/api/sessions/{s1}/qualification/reopen").status_code == 200
        events = []
        while not any(e["event"] == "qualification_status_changed" for e in events):
            events.append(socket.receive_json())
        changed = next(e for e in events if e["event"] == "qualification_status_changed")
        assert changed["data"] == {"session_id": s1, "finalized": False}


def test_finalize_is_atomic_when_the_recompute_fails(cooperative_client, monkeypatch):
    from fastapi.testclient import TestClient

    client = cooperative_client
    s1, _, first, _ = _uneven_session(client)

    def boom(*args, **kwargs):
        raise RuntimeError("recompute failed")

    monkeypatch.setattr("tournament_server.routers.qualification.recompute_all_rankings", boom)
    raw = TestClient(client.app, raise_server_exceptions=False)
    response = raw.post(
        f"/api/sessions/{s1}/qualification/finalize",
        json={"drops": {"7": 1, "8": 2}},
        headers={"Authorization": client.headers["Authorization"]},
    )
    assert response.status_code == 500
    monkeypatch.undo()
    assert _preview(client, s1)["finalized"] is False
    statuses = {m["id"]: m["status"] for m in client.get("/api/matches", params={"session_id": s1}).json()}
    assert statuses[first[9]["id"]] == "scheduled"


def test_finalize_needs_admin(cooperative_client):
    from fastapi.testclient import TestClient
    from auth_helpers import bearer, login_as

    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    raw = TestClient(client.app)
    scorer = bearer(login_as(raw, "scorer"))
    assert raw.post(
        f"/api/sessions/{s1}/qualification/finalize", json={"drops": {}}, headers=scorer
    ).status_code == 403
