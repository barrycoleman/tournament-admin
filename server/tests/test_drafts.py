from __future__ import annotations

import datetime as dt
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from auth_helpers import bearer, login_as
from device_helpers import paired_device
from display_helpers import add_match, score_match
from live_helpers import DRAFT, cooperative_setup, draft_rows, listening, patch_draft, scoring_setup, settle
from tournament_server.db import utc_now
from tournament_server.models.match import Match
from tournament_server.services.score_submission import SCORE_ALREADY_SUBMITTED_DETAIL
from tournament_server.services.qualification import NOT_PLAYED, NOT_PLAYED_SCORE_DETAIL


def _empty(alliance_id: int) -> dict:
    return {"alliance_id": alliance_id, "data": {}, "teams": [], "item_meta": {}, "version": 0, "score": 0}


def test_a_match_without_drafts_reads_empty(client):
    setup = scoring_setup(client)
    body = client.get(f"/api/matches/{setup['match_id']}/draft")
    assert body.status_code == 200
    assert body.json() == {
        "match_id": setup["match_id"],
        "submitted": False,
        "alliances": [_empty(setup["red"]), _empty(setup["blue"])],
    }


def test_patches_merge_item_by_item_and_record_who_and_when(client):
    setup = scoring_setup(client)
    tablet = paired_device(client, role="scorer", name="Red Tablet")
    before = utc_now()
    first = patch_draft(client, setup, "red", {"high_balls": 3, "auto_winner": "tie"}, headers=tablet["headers"])
    assert first.status_code == 200, first.text
    assert first.json()["version"] == 1
    second = patch_draft(client, setup, "red", {"low_balls": 2})
    after = utc_now()
    assert second.status_code == 200, second.text
    body = second.json()
    assert body["alliance_id"] == setup["red"]
    assert body["data"] == {"high_balls": 3, "auto_winner": "tie", "low_balls": 2}
    assert body["version"] == 2
    assert body["score"] == 3 * 3 + 2
    assert {key: meta["device_name"] for key, meta in body["item_meta"].items()} == {
        "high_balls": "Red Tablet",
        "auto_winner": "Red Tablet",
        "low_balls": "Admin",
    }
    for meta in body["item_meta"].values():
        assert before <= dt.datetime.fromisoformat(meta["at"]) <= after
    read = client.get(f"/api/matches/{setup['match_id']}/draft").json()
    assert read["alliances"][0] == body
    assert read["alliances"][1] == _empty(setup["blue"])


def test_the_last_write_wins_on_one_item(client):
    setup = scoring_setup(client)
    first = paired_device(client, role="scorer", name="Tablet A")
    second = paired_device(client, role="referee", name="Tablet B")
    patch_draft(client, setup, "red", {"high_balls": 3, "low_balls": 1}, headers=first["headers"])
    body = patch_draft(client, setup, "red", {"high_balls": 5}, headers=second["headers"]).json()
    assert body["data"] == {"high_balls": 5, "low_balls": 1}
    assert body["item_meta"]["high_balls"]["device_name"] == "Tablet B"
    assert body["item_meta"]["low_balls"]["device_name"] == "Tablet A"
    assert body["version"] == 2


@pytest.mark.parametrize(
    "changes, message",
    [
        ({"goals": 1}, "goals: Unknown item."),
        ({"high_balls": "3"}, "high_balls: Must be a whole number."),
        ({"high_balls": True}, "high_balls: Must be a whole number."),
        ({"high_balls": 21}, "high_balls: Must be at most 20."),
        ({"low_balls": -1}, "low_balls: Must be at least 0."),
        ({"parked": 1}, "parked: Must be true or false."),
        ({"auto_winner": "green"}, "auto_winner: Must be one of: red, blue, tie."),
        ({"team:5:dq": True}, "team:5:dq: Send team flags in teams."),
    ],
)
def test_each_item_is_checked_on_its_own(client, changes, message):
    setup = scoring_setup(client)
    refused = patch_draft(client, setup, "red", changes)
    assert refused.status_code == 422
    assert refused.json()["detail"] == {"violations": [message]}
    assert draft_rows(client) == []


def test_one_bad_item_refuses_the_whole_patch(client):
    setup = scoring_setup(client)
    patch_draft(client, setup, "red", {"high_balls": 2})
    refused = patch_draft(client, setup, "red", {"high_balls": 4, "low_balls": 99})
    assert refused.status_code == 422
    assert refused.json()["detail"] == {"violations": ["low_balls: Must be at most 20."]}
    red = client.get(f"/api/matches/{setup['match_id']}/draft").json()["alliances"][0]
    assert (red["data"], red["version"]) == ({"high_balls": 2}, 1)


def test_unknown_fields_in_the_body_are_refused(client):
    setup = scoring_setup(client)
    refused = client.patch(
        f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/draft",
        json={"changes": {"high_balls": 1}, "force": True},
    )
    assert refused.status_code == 422


def test_team_flags_stay_on_their_alliance(client):
    setup = scoring_setup(client)
    t1, t2, t3, _ = setup["teams"]
    flagged = patch_draft(
        client, setup, "red", {"high_balls": 4, "auto_winner": "tie"}, teams=[{"team_id": t1, "no_show": True}]
    )
    assert flagged.status_code == 200, flagged.text
    body = flagged.json()
    assert body["teams"] == [{"team_id": t1, "no_show": True, "dq": False}]
    assert {f"team:{t1}:no_show", f"team:{t1}:dq"} <= set(body["item_meta"])
    # One of two teams out: in qualification the alliance still scores.
    assert body["score"] == 12

    both = patch_draft(client, setup, "red", teams=[{"team_id": t2, "dq": True}]).json()
    assert both["teams"] == [
        {"team_id": t1, "no_show": True, "dq": False},
        {"team_id": t2, "no_show": False, "dq": True},
    ]
    assert both["score"] == 0

    cleared = patch_draft(client, setup, "red", teams=[{"team_id": t1}]).json()
    assert cleared["teams"] == [{"team_id": t2, "no_show": False, "dq": True}]
    assert cleared["version"] == 3

    other = patch_draft(client, setup, "red", teams=[{"team_id": t3, "dq": True}])
    assert other.status_code == 422
    assert other.json()["detail"] == {"violations": [f"Team {t3} is not on this alliance."]}
    twice = patch_draft(client, setup, "red", teams=[{"team_id": t1}, {"team_id": t1, "dq": True}])
    assert twice.status_code == 422
    assert twice.json()["detail"] == {"violations": [f"Team {t1} is listed more than once."]}


def test_a_submitted_match_refuses_patches(client):
    setup = scoring_setup(client)
    red_only = client.post(
        f"/api/matches/{setup['match_id']}/alliances/{setup['red']}/score", json={"data": DRAFT}
    )
    assert red_only.status_code == 200
    # Only one alliance has an official score: the match is still being scored.
    assert patch_draft(client, setup, "blue", {"high_balls": 1}).status_code == 200
    score_match(client, setup["match"])
    refused = patch_draft(client, setup, "red", {"high_balls": 1})
    assert refused.status_code == 409
    assert refused.json()["detail"] == SCORE_ALREADY_SUBMITTED_DETAIL


def test_a_not_played_match_refuses_patches(client):
    setup = scoring_setup(client)
    with client.app.state.session_factory() as db:
        db.get(Match, setup["match_id"]).status = NOT_PLAYED
        db.commit()
    refused = patch_draft(client, setup, "red", {"high_balls": 1})
    assert refused.status_code == 409
    assert refused.json()["detail"] == NOT_PLAYED_SCORE_DETAIL


def test_unknown_matches_and_foreign_alliances_are_404(client):
    setup = scoring_setup(client)
    other = add_match(client, setup["session_id"], None, 2, setup["teams"])
    assert patch_draft(client, setup, other["alliances"][0]["id"], {"high_balls": 1}).status_code == 404
    assert client.get("/api/matches/999/draft").status_code == 404
    missing = client.patch("/api/matches/999/alliances/1/draft", json={"changes": {}})
    assert missing.status_code == 404


def test_only_scoring_roles_read_and_patch(client):
    setup = scoring_setup(client)
    url = f"/api/matches/{setup['match_id']}/draft"
    for role in ("judge", "display_device"):
        device = paired_device(client, role=role)
        assert client.get(url, headers=device["headers"]).status_code == 403
        assert patch_draft(client, setup, "red", {"high_balls": 1}, headers=device["headers"]).status_code == 403
    token = login_as(TestClient(client.app), "scorer")
    unpaired = patch_draft(client, setup, "red", {"high_balls": 1}, headers=bearer(token))
    assert unpaired.status_code == 403
    assert unpaired.json()["detail"] == "Only a paired device can submit scores."
    referee = paired_device(client, role="referee")
    assert client.get(url, headers=referee["headers"]).status_code == 200
    assert patch_draft(client, setup, "red", {"high_balls": 1}, headers=referee["headers"]).status_code == 200


def test_a_cooperative_game_shares_one_draft(cooperative_client):
    client = cooperative_client
    setup = cooperative_setup(client)
    _, t2 = setup["teams"]
    shared = min(setup["red"], setup["blue"])
    body = patch_draft(client, setup, "blue", {"objects_scored": 7}).json()
    assert (body["alliance_id"], body["data"], body["score"]) == (setup["blue"], {"objects_scored": 7}, 14)
    assert [row.alliance_id for row in draft_rows(client)] == [shared]

    with listening(client, "admin") as heard:
        # The shared draft holds every team's flags, so either alliance may set them.
        flagged = patch_draft(client, setup, "red", teams=[{"team_id": t2, "no_show": True}])
        assert flagged.status_code == 200, flagged.text
        settle(client, heard)
    assert sorted(event["alliance_id"] for event in heard["admin"].events("score_draft_changed")) == sorted(
        [setup["red"], setup["blue"]]
    )

    red, blue = client.get(f"/api/matches/{setup['match_id']}/draft").json()["alliances"]
    assert red["data"] == blue["data"] == {"objects_scored": 7}
    assert red["version"] == blue["version"] == 2
    assert red["teams"] == []
    assert blue["teams"] == [{"team_id": t2, "no_show": True, "dq": False}]
    assert (red["score"], blue["score"]) == (14, 0)
    assert len(draft_rows(client)) == 1


def test_patches_reach_the_scoring_roles_only(client):
    setup = scoring_setup(client)
    with listening(client, "admin", "scorer", "referee", "display_device", "judge") as heard:
        assert patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"}).status_code == 200
        settle(client, heard)
    for role in ("admin", "scorer", "referee"):
        [event] = heard[role].events("score_draft_changed")
        assert (event["match_id"], event["alliance_id"], event["version"], event["score"]) == (
            setup["match_id"],
            setup["red"],
            1,
            6,
        )
        assert event["data"] == {"high_balls": 2, "auto_winner": "tie"}
        assert event["teams"] == []
        assert event["item_meta"]["high_balls"]["device_name"] == "Admin"
    for role in ("display_device", "judge"):
        assert heard[role].events("score_draft_changed") == []


def test_concurrent_patches_never_lose_a_change(client):
    setup = scoring_setup(client)
    changes = [{name: n} for n in range(10) for name in ("high_balls", "low_balls")]
    with ThreadPoolExecutor(max_workers=4) as pool:
        responses = list(pool.map(lambda change: patch_draft(client, setup, "red", change), changes))
    assert [response.status_code for response in responses] == [200] * len(changes)
    assert sorted(response.json()["version"] for response in responses) == list(range(1, len(changes) + 1))
    red = client.get(f"/api/matches/{setup['match_id']}/draft").json()["alliances"][0]
    assert red["version"] == len(changes)
    assert set(red["data"]) == {"high_balls", "low_balls"}
