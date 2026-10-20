from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from auth_helpers import bearer, login_as
from device_helpers import paired_device
from display_helpers import add_match
from live_helpers import (
    DRAFT,
    cooperative_setup,
    draft_rows,
    listening,
    patch_draft,
    score_chase_setup,
    scoring_setup,
    settle,
)
from ranking_helpers import finalize_qualification
from tournament_server.models.score_record import ScoreRecord
from tournament_server.routers.scores import SCORE_ALREADY_SUBMITTED_DETAIL
from tournament_server.services.qualification import NOT_PLAYED_SCORE_DETAIL

RED_DRAFT = DRAFT  # scores 9
BLUE_DRAFT = {**DRAFT, "high_balls": 1}  # scores 3


def _submit(client, match_id: int, headers=None, **body):
    return client.post(f"/api/matches/{match_id}/submit", json=body, headers=headers)


def _records(client) -> dict[int, ScoreRecord]:
    with client.app.state.session_factory() as db:
        return {record.alliance_id: record for record in db.execute(select(ScoreRecord)).scalars().all()}


def _both_drafts(client, setup, headers=None) -> None:
    assert patch_draft(client, setup, "red", RED_DRAFT, headers=headers).status_code == 200
    assert patch_draft(client, setup, "blue", BLUE_DRAFT, headers=headers).status_code == 200


def _strict_validate(monkeypatch, client) -> None:
    module = client.app.state.game_plugins["example-game"].module
    monkeypatch.setattr(
        module,
        "validate",
        lambda data: ["Low balls can't exceed high balls."] if data.get("low_balls", 0) > data.get("high_balls", 0) else [],
    )


def test_submit_makes_the_drafts_official(client):
    setup = scoring_setup(client)
    tablet = paired_device(client, role="scorer", name="Field 1 Tablet")
    _both_drafts(client, setup, headers=tablet["headers"])
    submitted = _submit(client, setup["match_id"], headers=tablet["headers"])
    assert submitted.status_code == 200, submitted.text
    assert submitted.json() == {
        "match_id": setup["match_id"],
        "submitted": True,
        "alliances": [
            {"alliance_id": setup["red"], "data": RED_DRAFT, "teams": [], "item_meta": {}, "version": 0, "score": 9},
            {"alliance_id": setup["blue"], "data": BLUE_DRAFT, "teams": [], "item_meta": {}, "version": 0, "score": 3},
        ],
    }
    records = _records(client)
    assert set(records) == {setup["red"], setup["blue"]}
    assert {record.submitted_by_device for record in records.values()} == {"Field 1 Tablet"}
    assert draft_rows(client) == []
    assert client.get(f"/api/matches/{setup['match_id']}").json()["status"] == "completed"
    assert client.get(f"/api/matches/{setup['match_id']}/draft").json() == submitted.json()

    rankings = {row["team_id"]: row for row in client.get(f"/api/rankings?session_id={setup['session_id']}").json()}
    t1, t2, t3, t4 = setup["teams"]
    assert [rankings[team]["win_points"] for team in (t1, t2, t3, t4)] == [2, 2, 0, 0]


def test_submit_needs_a_draft_for_every_alliance(client):
    setup = scoring_setup(client)
    patch_draft(client, setup, "red", RED_DRAFT)
    refused = _submit(client, setup["match_id"])
    assert refused.status_code == 409
    assert refused.json()["detail"] == f"Alliance {setup['blue']} has no draft score."
    assert _records(client) == {}
    assert [row.alliance_id for row in draft_rows(client)] == [setup["red"]]


def test_plugin_problems_are_reported_per_alliance_and_force_overrides_them(client, monkeypatch):
    _strict_validate(monkeypatch, client)
    setup = scoring_setup(client)
    patch_draft(client, setup, "red", RED_DRAFT)
    patch_draft(client, setup, "blue", {**BLUE_DRAFT, "low_balls": 2})
    refused = _submit(client, setup["match_id"])
    assert refused.status_code == 422
    assert refused.json()["detail"] == {
        "violations": [{"alliance_id": setup["blue"], "messages": ["Low balls can't exceed high balls."]}]
    }
    # All or nothing: the valid red draft wasn't written either.
    assert _records(client) == {}
    assert len(draft_rows(client)) == 2

    forced = _submit(client, setup["match_id"], force=True)
    assert forced.status_code == 200, forced.text
    assert [alliance["score"] for alliance in forced.json()["alliances"]] == [9, 5]
    assert draft_rows(client) == []


def test_a_second_submit_and_later_patches_are_refused(client):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    assert _submit(client, setup["match_id"]).status_code == 200
    again = _submit(client, setup["match_id"])
    assert again.status_code == 409
    assert again.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL
    late = patch_draft(client, setup, "red", {"high_balls": 1})
    assert late.status_code == 409
    assert late.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL
    assert draft_rows(client) == []


def test_two_submits_at_once_write_one_score(client):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(lambda _: _submit(client, setup["match_id"]), range(2)))
    assert sorted(result.status_code for result in results) == [200, 409]
    refused = next(result for result in results if result.status_code == 409)
    assert refused.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL
    assert len(_records(client)) == 2


def test_an_alliance_scored_earlier_keeps_its_score(client):
    setup = scoring_setup(client)
    tablet = paired_device(client, role="scorer")
    official = client.post(
        f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/score", json={"data": RED_DRAFT}
    )
    assert official.status_code == 200
    patch_draft(client, setup, "blue", BLUE_DRAFT, headers=tablet["headers"])
    submitted = _submit(client, setup["match_id"], headers=tablet["headers"])
    assert submitted.status_code == 200, submitted.text
    assert [alliance["score"] for alliance in submitted.json()["alliances"]] == [9, 3]


def test_only_an_admin_submit_overwrites_an_earlier_score(client):
    setup = scoring_setup(client)
    tablet = paired_device(client, role="scorer")
    client.post(f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/score", json={"data": RED_DRAFT})
    patch_draft(client, setup, "red", {**RED_DRAFT, "high_balls": 5}, headers=tablet["headers"])
    patch_draft(client, setup, "blue", BLUE_DRAFT, headers=tablet["headers"])
    refused = _submit(client, setup["match_id"], headers=tablet["headers"])
    assert refused.status_code == 409
    assert refused.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL
    assert set(_records(client)) == {setup["red"]}

    overwritten = _submit(client, setup["match_id"])
    assert overwritten.status_code == 200, overwritten.text
    assert [alliance["score"] for alliance in overwritten.json()["alliances"]] == [15, 3]


def test_submit_tells_every_device_and_clears_live_totals(client):
    setup = scoring_setup(client)
    assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
    _both_drafts(client, setup)
    with listening(client, "display_device", "scorer", "admin", "judge") as heard:
        assert _submit(client, setup["match_id"]).status_code == 200
        settle(client, heard)
    for recorder in heard.values():
        assert recorder.events("match_submitted") == [{"match_id": setup["match_id"]}]
        assert {event["alliance_id"] for event in recorder.events("score_saved")} == {setup["red"], setup["blue"]}
    assert heard["display_device"].events("live_score")[-1] == {"match_id": setup["match_id"], "cleared": True}


def test_submit_roles(client):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    judge = paired_device(client, role="judge")
    assert _submit(client, setup["match_id"], headers=judge["headers"]).status_code == 403
    token = login_as(TestClient(client.app), "scorer")
    unpaired = _submit(client, setup["match_id"], headers=bearer(token))
    assert unpaired.status_code == 403
    assert _submit(client, 999).status_code == 404
    assert _submit(client, setup["match_id"], forced=True).status_code == 422
    referee = paired_device(client, role="referee")
    assert _submit(client, setup["match_id"], headers=referee["headers"]).status_code == 200


def test_a_cooperative_submit_mirrors_the_shared_draft(cooperative_client):
    client = cooperative_client
    setup = cooperative_setup(client)
    patch_draft(client, setup, "blue", {"objects_scored": 10})
    submitted = _submit(client, setup["match_id"])
    assert submitted.status_code == 200, submitted.text
    assert [alliance["score"] for alliance in submitted.json()["alliances"]] == [20, 20]
    records = _records(client)
    assert (records[setup["red"]].mirrored, records[setup["blue"]].mirrored) == (False, True)
    assert client.get(f"/api/matches/{setup['match_id']}").json()["status"] == "completed"
    assert draft_rows(client) == []


@pytest.mark.parametrize("flagged_side", ["red", "blue"])
def test_a_cooperative_submit_keeps_each_teams_flag(cooperative_client, flagged_side):
    client = cooperative_client
    setup = cooperative_setup(client)
    t1, t2 = setup["teams"]
    flagged_team = t1 if flagged_side == "red" else t2
    other_side = "blue" if flagged_side == "red" else "red"
    patch_draft(client, setup, "red", {"objects_scored": 10}, teams=[{"team_id": flagged_team, "no_show": True}])
    assert _submit(client, setup["match_id"]).status_code == 200
    scores = {score["alliance_id"]: score for score in client.get("/api/scores").json()}
    assert scores[setup[flagged_side]]["score"] == 0
    assert scores[setup[flagged_side]]["teams"] == [{"team_id": flagged_team, "no_show": True, "dq": False}]
    assert scores[setup[other_side]]["score"] == 20
    assert scores[setup[other_side]]["teams"] == []


def test_submitting_a_finals_run_advances_the_bracket(cooperative_client):
    client = cooperative_client
    chase = score_chase_setup(client)
    [alliance_id] = chase["alliance_ids"]
    patch_draft(client, chase, alliance_id, {"objects_scored": 5})
    submitted = _submit(client, chase["match_id"])
    assert submitted.status_code == 200, submitted.text
    assert submitted.json()["alliances"][0]["score"] == 10
    bracket = client.get(f"/api/finals/{chase['bracket_id']}").json()
    assert len(bracket["runs"]) == 2


def test_a_whole_match_reset_clears_drafts_and_a_section_reset_keeps_them(client):
    setup = scoring_setup(client)
    match_url = f"/api/matches/{setup['match_id']}"
    assert client.post(f"{match_url}/start").status_code == 200
    patch_draft(client, setup, "red", RED_DRAFT)
    section = client.post(f"{match_url}/reset", json={"scope": "section"})
    assert section.status_code == 200
    assert section.json()["phase"] == "not_started"
    assert client.get(f"{match_url}/draft").json()["alliances"][0]["version"] == 1

    assert client.post(f"{match_url}/start").status_code == 200
    with listening(client, "scorer", "display_device") as heard:
        assert client.post(f"{match_url}/reset", json={"scope": "full"}).status_code == 200
        settle(client, heard)
    assert draft_rows(client) == []
    assert [alliance["version"] for alliance in client.get(f"{match_url}/draft").json()["alliances"]] == [0, 0]
    empty = {"teams": [], "item_meta": {}, "version": 0, "score": 0, "data": {}}
    assert heard["scorer"].events("score_draft_changed") == [
        {"match_id": setup["match_id"], "alliance_id": setup["red"], **empty},
        {"match_id": setup["match_id"], "alliance_id": setup["blue"], **empty},
    ]
    assert heard["display_device"].events("score_draft_changed") == []


def test_marking_a_match_not_played_deletes_its_drafts(client):
    setup = scoring_setup(client)
    second = add_match(client, setup["session_id"], setup["field_set"]["field_ids"][1], 2, setup["teams"], minutes=5)
    second_setup = {"match_id": second["id"], "red": second["alliances"][0]["id"]}
    _both_drafts(client, setup)
    assert _submit(client, setup["match_id"]).status_code == 200
    patch_draft(client, second_setup, "red", RED_DRAFT)

    finalize_qualification(client, setup["session_id"])

    assert client.get(f"/api/matches/{second['id']}").json()["status"] == "not_played"
    assert draft_rows(client) == []
    late = patch_draft(client, second_setup, "red", {"high_balls": 1})
    assert (late.status_code, late.json()["detail"]) == (409, NOT_PLAYED_SCORE_DETAIL)
    refused = _submit(client, second["id"])
    assert (refused.status_code, refused.json()["detail"]) == (409, NOT_PLAYED_SCORE_DETAIL)


@pytest.mark.parametrize("remove", ["schedule", "session"])
def test_deleting_matches_deletes_their_drafts(client, remove):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    if remove == "schedule":
        cleared = client.delete(
            "/api/schedule", params={"session_id": setup["session_id"], "round_type": "qualification"}
        )
        assert cleared.status_code == 200
        assert cleared.json()["matches_deleted"] == 1
    else:
        assert client.delete(f"/api/sessions/{setup['session_id']}").status_code == 204
    assert draft_rows(client) == []


def test_deleting_a_finals_bracket_deletes_its_drafts(cooperative_client):
    client = cooperative_client
    chase = score_chase_setup(client)
    patch_draft(client, chase, chase["alliance_ids"][0], {"objects_scored": 5})
    assert len(draft_rows(client)) == 1
    assert client.delete(f"/api/finals/{chase['bracket_id']}").status_code == 204
    assert draft_rows(client) == []


def test_an_official_score_post_that_completes_the_match_clears_drafts_and_live_totals(client):
    setup = scoring_setup(client)
    match_url = f"/api/matches/{setup['match_id']}"
    assert client.post(f"{match_url}/start").status_code == 200
    _both_drafts(client, setup)
    assert len(draft_rows(client)) == 2
    with listening(client, "display_device", "scorer") as heard:
        for side, data in (("red", RED_DRAFT), ("blue", BLUE_DRAFT)):
            posted = client.post(f"{match_url}/alliances/{setup[side]}/score", json={"data": data})
            assert posted.status_code == 200, posted.text
        settle(client, heard)
    assert draft_rows(client) == []
    draft = client.get(f"{match_url}/draft").json()
    assert draft["submitted"] is True
    assert [alliance["score"] for alliance in draft["alliances"]] == [9, 3]
    assert heard["display_device"].events("live_score")[-1] == {"match_id": setup["match_id"], "cleared": True}
    assert heard["scorer"].events("score_draft_changed") == []


def test_a_partial_official_score_post_keeps_the_drafts(client):
    setup = scoring_setup(client)
    _both_drafts(client, setup)
    posted = client.post(
        f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/score", json={"data": RED_DRAFT}
    )
    assert posted.status_code == 200
    assert len(draft_rows(client)) == 2
