"""Partner picking: invite, accept, decline, cancel, undo and finish early."""

from fastapi.testclient import TestClient
from sqlalchemy import select

from device_helpers import paired_device
from skills_helpers import next_event
from test_finals import (
    _rank_teams_directly_head_to_head,
    _session_socket,
    _setup_ranked_teams_for_example_game,
)
from tournament_server.models.finals_pick import FinalsPick

STARTED_DETAIL = "Finals have started — use Start over instead."


def _ranked(client, count: int = 8) -> tuple[int, list[int]]:
    """`count` ranked, checked-in teams; returns the session and the team ids
    in rank order (R1 first)."""
    session_id, team_ids = _setup_ranked_teams_for_example_game(client, count)
    _rank_teams_directly_head_to_head(client, session_id, team_ids)
    rows = client.get(f"/api/rankings?session_id={session_id}").json()
    ranks = [r["rank"] for r in rows]
    assert len(set(ranks)) == len(ranks), "test setup needs distinct ranks"
    return session_id, [r["team_id"] for r in sorted(rows, key=lambda r: r["rank"])]


def _start(client, session_id: int, team_count: int = 4) -> dict:
    response = client.post(
        "/api/finals/start",
        json={"session_id": session_id, "team_count": team_count, "wins_to_advance": 1},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _act(client, bracket_id: int, action: str, team_id: int | None = None, headers=None):
    body = {"team_id": team_id} if team_id is not None else None
    return client.post(
        f"/api/finals/{bracket_id}/selection/{action}", json=body, headers=headers
    )


def _ok(client, bracket_id: int, action: str, team_id: int | None = None) -> dict:
    response = _act(client, bracket_id, action, team_id)
    assert response.status_code == 200, response.text
    return response.json()


def _pair(client, bracket_id: int, partner: int) -> dict:
    _ok(client, bracket_id, "invite", partner)
    return _ok(client, bracket_id, "accept", partner)


def _alliances(body: dict) -> list[set[int]]:
    return [set(a["team_ids"]) for a in sorted(body["alliances"], key=lambda a: a["seed"])]


def test_captain_is_highest_unallied_team(client):
    session_id, R = _ranked(client)
    bracket = _start(client, session_id)
    assert bracket["status"] == "selecting_alliances"
    assert bracket["alliances"] == []
    assert bracket["bracket_size"] == 2
    selection = bracket["selection"]
    assert selection["captain_team_id"] == R[0]
    assert selection["invitable_team_ids"] == R[1:]
    assert selection["declined_team_ids"] == []
    assert selection["pending_team_id"] is None
    assert selection["alliances_formed"] == 0
    assert selection["alliances_target"] == 2
    assert selection["last_step"] is None


def test_accept_forms_alliance_one_and_next_captain_follows(client):
    session_id, R = _ranked(client)
    bracket = _start(client, session_id)
    invited = _ok(client, bracket["id"], "invite", R[1])
    assert invited["selection"]["pending_team_id"] == R[1]
    body = _ok(client, bracket["id"], "accept", R[1])
    assert body["alliances"][0]["seed"] == 1
    assert body["alliances"][0]["team_ids"] == [R[0], R[1]]
    selection = body["selection"]
    assert selection["captain_team_id"] == R[2]
    assert selection["pending_team_id"] is None
    assert selection["alliances_formed"] == 1
    assert selection["last_step"] == {"kind": "accept", "captain_team_id": R[0], "team_id": R[1]}


def test_decline_blocks_invites_but_allows_captaincy(client):
    session_id, R = _ranked(client)
    bracket = _start(client, session_id, team_count=6)
    bid = bracket["id"]
    _ok(client, bid, "invite", R[3])
    body = _ok(client, bid, "decline", R[3])
    assert body["selection"]["captain_team_id"] == R[0]
    assert body["selection"]["declined_team_ids"] == [R[3]]
    assert R[3] not in body["selection"]["invitable_team_ids"]
    _pair(client, bid, R[6])
    assert _act(client, bid, "invite", R[3]).status_code == 422
    body = _pair(client, bid, R[4])
    assert body["selection"]["captain_team_id"] == R[2]
    body = _pair(client, bid, R[5])
    assert body["status"] == "in_progress"
    assert body["selection"] is None
    assert _alliances(body) == [{R[0], R[6]}, {R[1], R[4]}, {R[2], R[5]}]
    games = [
        m for m in client.get(f"/api/matches?session_id={session_id}").json()
        if m["round_type"] == "elimination"
    ]
    assert games


def test_declined_team_becomes_captain_when_reached(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id, team_count=8)["id"]
    _ok(client, bid, "invite", R[3])
    _ok(client, bid, "decline", R[3])
    _pair(client, bid, R[6])
    _pair(client, bid, R[4])
    body = _pair(client, bid, R[5])
    assert body["selection"]["captain_team_id"] == R[3]
    body = _pair(client, bid, R[7])
    assert body["status"] == "in_progress"
    assert _alliances(body)[3] == {R[3], R[7]}


def test_any_ranked_team_can_be_invited(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id, team_count=4)["id"]
    body = _pair(client, bid, R[7])
    assert _alliances(body) == [{R[0], R[7]}]
    assert body["selection"]["captain_team_id"] == R[1]


def test_cancel_clears_invite_without_record(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _ok(client, bid, "invite", R[2])
    body = _ok(client, bid, "cancel")
    assert body["selection"]["pending_team_id"] is None
    assert body["selection"]["last_step"] is None
    assert R[2] in body["selection"]["invitable_team_ids"]
    assert body["selection"]["declined_team_ids"] == []
    db = client.app.state.session_factory()
    try:
        assert db.execute(select(FinalsPick)).scalars().all() == []
    finally:
        db.close()
    assert _act(client, bid, "cancel").json()["detail"] == "No invite is open."


def test_second_invite_refused_while_one_open(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _ok(client, bid, "invite", R[1])
    response = _act(client, bid, "invite", R[2])
    assert response.status_code == 409
    assert response.json()["detail"] == "An invite is already open."


def test_second_answer_to_same_invite_is_refused(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _ok(client, bid, "invite", R[1])
    _ok(client, bid, "accept", R[1])
    response = _act(client, bid, "decline", R[1])
    assert response.status_code == 409
    assert response.json()["detail"] == "No invite is open."
    body = client.get(f"/api/finals/{bid}").json()
    assert len(body["alliances"]) == 1
    assert body["selection"]["declined_team_ids"] == []


def test_answer_naming_a_different_team_is_refused(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _ok(client, bid, "invite", R[1])
    response = _act(client, bid, "accept", R[2])
    assert response.status_code == 409
    body = client.get(f"/api/finals/{bid}").json()
    assert body["alliances"] == []
    assert body["selection"]["pending_team_id"] == R[1]


def test_undo_reverses_accept_then_decline(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _ok(client, bid, "invite", R[3])
    _ok(client, bid, "decline", R[3])
    _pair(client, bid, R[6])

    body = _ok(client, bid, "undo")
    assert body["alliances"] == []
    assert body["selection"]["captain_team_id"] == R[0]
    assert R[6] in body["selection"]["invitable_team_ids"]
    assert body["selection"]["last_step"] == {
        "kind": "decline", "captain_team_id": R[0], "team_id": R[3]
    }

    body = _ok(client, bid, "undo")
    assert body["selection"]["invitable_team_ids"] == R[1:]
    assert body["selection"]["declined_team_ids"] == []
    assert body["selection"]["last_step"] is None

    response = _act(client, bid, "undo")
    assert response.status_code == 409


def test_undo_also_clears_an_open_invite(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _pair(client, bid, R[1])
    _ok(client, bid, "invite", R[3])
    body = _ok(client, bid, "undo")
    assert body["selection"]["pending_team_id"] is None
    assert body["alliances"] == []


def test_undo_refused_once_finals_are_in_progress(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _pair(client, bid, R[1])
    body = _pair(client, bid, R[3])
    assert body["status"] == "in_progress"
    response = _act(client, bid, "undo")
    assert response.status_code == 409
    assert response.json()["detail"] == STARTED_DETAIL
    assert _act(client, bid, "invite", R[4]).status_code == 409


def test_unranked_team_is_never_captain_or_invitable(client):
    session_id, R = _ranked(client)
    extra = client.post("/api/teams", json={"number": "99", "name": "Late"}).json()["id"]
    client.post(
        f"/api/sessions/{session_id}/participants",
        json={"team_id": extra, "checked_in": True},
    )
    ranked_ids = {r["team_id"] for r in client.get(f"/api/rankings?session_id={session_id}").json()}
    assert extra not in ranked_ids
    bracket = _start(client, session_id)
    selection = bracket["selection"]
    assert selection["captain_team_id"] != extra
    assert extra not in selection["invitable_team_ids"]
    assert _act(client, bracket["id"], "invite", extra).status_code == 422
    assert _act(client, bracket["id"], "invite", 999999).status_code == 422


def test_excluded_team_is_never_captain_or_invitable(client):
    session_id, R = _ranked(client)
    response = client.post(
        "/api/finals/exclusions",
        json={"session_id": session_id, "team_id": R[0], "reason": "left_early"},
    )
    assert response.status_code == 201, response.text
    bracket = _start(client, session_id)
    selection = bracket["selection"]
    assert selection["captain_team_id"] == R[1]
    assert R[0] not in selection["invitable_team_ids"]
    assert _act(client, bracket["id"], "invite", R[0]).status_code == 422


def test_finish_early_when_teams_run_out(client):
    session_id, R = _ranked(client, 6)
    bid = _start(client, session_id, team_count=6)["id"]
    for team in R[1:]:
        _ok(client, bid, "invite", team)
        _ok(client, bid, "decline", team)
    body = client.get(f"/api/finals/{bid}").json()
    assert body["selection"]["invitable_team_ids"] == []
    assert _act(client, bid, "finish").status_code == 409

    assert client.delete(f"/api/finals/{bid}").status_code == 204
    bid = _start(client, session_id, team_count=6)["id"]
    _pair(client, bid, R[1])
    assert _act(client, bid, "finish").status_code == 409  # teams still to invite
    _pair(client, bid, R[3])
    _ok(client, bid, "invite", R[5])
    body = _ok(client, bid, "decline", R[5])
    assert body["selection"]["captain_team_id"] == R[4]
    assert body["selection"]["invitable_team_ids"] == []
    body = _ok(client, bid, "finish")
    assert body["status"] == "in_progress"
    assert body["bracket_size"] == 2
    assert body["wins_to_advance"] == [1]
    assert len(body["matchups"]) == 1


def test_tablet_can_invite_and_answer_but_not_undo(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    raw = TestClient(client.app)
    tablet = paired_device(client, "scorer", "Tablet")["headers"]
    referee = paired_device(client, "referee", "Ref")["headers"]
    judge = paired_device(client, "judge", "Judge")["headers"]

    assert _act(raw, bid, "invite", R[2], headers=judge).status_code == 403
    assert _act(raw, bid, "invite", R[1], headers=tablet).status_code == 200
    assert _act(raw, bid, "cancel", headers=referee).status_code == 200
    assert _act(raw, bid, "invite", R[1], headers=referee).status_code == 200
    assert _act(raw, bid, "decline", R[1], headers=tablet).status_code == 200
    assert _act(raw, bid, "invite", R[2], headers=tablet).status_code == 200
    assert _act(raw, bid, "accept", R[2], headers=tablet).status_code == 200
    assert _act(raw, bid, "undo", headers=tablet).status_code == 403
    assert _act(raw, bid, "finish", headers=tablet).status_code == 403
    assert _act(raw, bid, "invite", R[3], headers=judge).status_code == 403


def test_selection_broadcasts_finals_changed(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    expected = {"session_id": session_id, "bracket_id": bid}
    with _session_socket(client, session_id) as socket:
        for action, team in (
            ("invite", R[1]),
            ("cancel", None),
            ("invite", R[1]),
            ("decline", R[1]),
            ("invite", R[2]),
            ("accept", R[2]),
            ("undo", None),
        ):
            _ok(client, bid, action, team)
            assert next_event(socket, "finals_changed")["data"] == expected


def test_delete_bracket_removes_picks(client):
    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _ok(client, bid, "invite", R[1])
    _ok(client, bid, "decline", R[1])
    _pair(client, bid, R[2])
    _ok(client, bid, "invite", R[3])
    assert client.delete(f"/api/finals/{bid}").status_code == 204
    db = client.app.state.session_factory()
    try:
        assert db.execute(select(FinalsPick)).scalars().all() == []
    finally:
        db.close()


def test_two_answers_from_stale_reads_cannot_both_succeed(client):
    """Two requests that each loaded the bracket while the invite was open:
    the first answer wins and the second is refused, never both applied."""
    import pytest

    from tournament_server.models.finals_bracket import FinalsBracket
    from tournament_server.services import alliance_selection

    session_id, R = _ranked(client)
    bid = _start(client, session_id)["id"]
    _ok(client, bid, "invite", R[1])
    factory = client.app.state.session_factory
    first, second = factory(), factory()
    try:
        bracket_a = first.get(FinalsBracket, bid)
        bracket_b = second.get(FinalsBracket, bid)
        assert bracket_a.pending_team_id == bracket_b.pending_team_id == R[1]
        alliance_selection.accept(first, bracket_a, R[1])
        with pytest.raises(alliance_selection.SelectionError) as refused:
            alliance_selection.decline(second, bracket_b, R[1])
        assert refused.value.status == 409
        assert refused.value.detail == "No invite is open."
    finally:
        first.close()
        second.close()
    body = client.get(f"/api/finals/{bid}").json()
    assert _alliances(body) == [{R[0], R[1]}]
    assert body["selection"]["declined_team_ids"] == []
