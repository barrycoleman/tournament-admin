from __future__ import annotations

import asyncio

from device_helpers import paired_device
from display_helpers import add_field_set, add_match, add_teams
from live_helpers import listening, patch_draft, score_chase_setup, scoring_setup, settle
from tournament_server.db import utc_now
from tournament_server.match_control import cancel_auto_advance
from tournament_server.models.match import Match
from tournament_server.routers.matches import _auto_advance_match
from tournament_server.services import live_scores

LIVE_URL = "/api/displays/live-scores"


def _totals(setup: dict, red: int, blue: int) -> dict:
    return {
        "match_id": setup["match_id"],
        "alliances": [{"alliance_id": setup["red"], "score": red}, {"alliance_id": setup["blue"], "score": blue}],
    }


def _cleared(match_id: int) -> dict:
    return {"match_id": match_id, "cleared": True}


def _switch(client, session_id: int, **switches) -> None:
    assert client.patch(f"/api/sessions/{session_id}", json=switches).status_code == 200


def test_the_live_phases_are_every_running_phase():
    assert live_scores.LIVE_PHASES == {
        "countdown_autonomous",
        "autonomous",
        "awaiting_driver",
        "countdown_driver",
        "driver",
    }


def test_totals_reach_displays_and_admins_only_while_the_clock_runs(client):
    setup = scoring_setup(client)
    match_url = f"/api/matches/{setup['match_id']}"
    with listening(client, "display_device", "admin", "scorer") as heard:
        patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
        settle(client, heard)
        assert heard["display_device"].events("live_score") == []

        assert client.post(f"{match_url}/start").status_code == 200
        settle(client, heard)
        assert heard["display_device"].events("live_score") == [_totals(setup, 6, 0)]

        patch_draft(client, setup, "blue", {"high_balls": 1, "auto_winner": "tie"})
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 6, 3)

        assert client.post(f"{match_url}/pause").status_code == 200
        patch_draft(client, setup, "blue", {"low_balls": 1})
        settle(client, heard)
        # Paused still counts as running.
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 6, 4)
        assert client.post(f"{match_url}/resume").status_code == 200

        assert client.post(f"{match_url}/end").status_code == 200
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _cleared(setup["match_id"])
        sent = len(heard["display_device"].events("live_score"))

        patch_draft(client, setup, "red", {"low_balls": 1})
        settle(client, heard)
        assert len(heard["display_device"].events("live_score")) == sent
    assert heard["admin"].events("live_score") == heard["display_device"].events("live_score")
    assert heard["scorer"].events("live_score") == []


def test_the_qualification_switch_hides_and_restores_totals(client):
    setup = scoring_setup(client)
    assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
    patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
    with listening(client, "display_device") as heard:
        _switch(client, setup["session_id"], live_scores_qualification=False)
        settle(client, heard)
        # The countdown may advance meanwhile; each phase change re-sends "cleared", never totals.
        events = heard["display_device"].events("live_score")
        assert events and all(event == _cleared(setup["match_id"]) for event in events)

        patch_draft(client, setup, "red", {"high_balls": 4})
        settle(client, heard)
        events = heard["display_device"].events("live_score")
        assert all(event == _cleared(setup["match_id"]) for event in events)

        _switch(client, setup["session_id"], live_scores_qualification=True)
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 12, 0)


def test_practice_follows_the_qualification_switch(client):
    setup = scoring_setup(client, round_type="practice")
    _switch(client, setup["session_id"], live_scores_qualification=False)
    patch_draft(client, setup, "red", {"high_balls": 1, "auto_winner": "tie"})
    with listening(client, "display_device") as heard:
        assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
        _switch(client, setup["session_id"], live_scores_finals=True)
        settle(client, heard)
        assert heard["display_device"].events("live_score")
        assert all(event == _cleared(setup["match_id"]) for event in heard["display_device"].events("live_score"))

        _switch(client, setup["session_id"], live_scores_qualification=True)
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 3, 0)


def test_finals_send_no_totals_until_their_switch_is_on(cooperative_client):
    client = cooperative_client
    chase = score_chase_setup(client)
    [alliance_id] = chase["alliance_ids"]
    with listening(client, "display_device") as heard:
        assert client.post(f"/api/matches/{chase['match_id']}/start").status_code == 200
        patch_draft(client, chase, alliance_id, {"objects_scored": 5})
        settle(client, heard)
        events = heard["display_device"].events("live_score")
        assert events and all(event == _cleared(chase["match_id"]) for event in events)

        _switch(client, chase["session_id"], live_scores_finals=True)
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == {
            "match_id": chase["match_id"],
            "alliances": [{"alliance_id": alliance_id, "score": 10}],
        }


def test_the_clock_running_out_clears_the_totals(client):
    setup = scoring_setup(client)
    assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
    patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
    with client.app.state.session_factory() as db:
        row = db.get(Match, setup["match_id"])
        row.phase = "driver"
        row.phase_deadline = utc_now()
        db.commit()
    cancel_auto_advance(client.app, setup["match_id"])
    with listening(client, "display_device") as heard:
        asyncio.run_coroutine_threadsafe(
            _auto_advance_match(client.app, setup["match_id"], override_sleep_seconds=0),
            client.app.state.realtime.event_loop,
        ).result(timeout=5)
        settle(client, heard)
        assert heard["display_device"].events("live_score") == [_cleared(setup["match_id"])]
    assert client.get(f"/api/matches/{setup['match_id']}").json()["phase"] == "ended"


def test_a_reset_clears_the_totals_and_a_restart_brings_them_back(client):
    setup = scoring_setup(client)
    match_url = f"/api/matches/{setup['match_id']}"
    assert client.post(f"{match_url}/start").status_code == 200
    patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
    with listening(client, "display_device") as heard:
        assert client.post(f"{match_url}/reset", json={"scope": "section"}).status_code == 200
        settle(client, heard)
        assert heard["display_device"].events("live_score") == [_cleared(setup["match_id"])]
        assert client.post(f"{match_url}/start").status_code == 200
        settle(client, heard)
        assert heard["display_device"].events("live_score")[-1] == _totals(setup, 6, 0)


def test_the_snapshot_agrees_with_the_events(client):
    setup = scoring_setup(client)
    main_set = setup["field_set"]["id"]
    side = add_field_set(client, setup["session_id"], "Side Fields", ("Side 1",))
    other = add_match(client, setup["session_id"], side["field_ids"][0], 2, add_teams(client, start=201))
    display = paired_device(client, role="display_device")

    def snapshot(**params):
        response = client.get(LIVE_URL, params=params, headers=display["headers"])
        assert response.status_code == 200, response.text
        return response.json()

    assert snapshot(field_set_id=main_set) == {"matches": [], "skills": []}
    with listening(client, "display_device") as heard:
        assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
        patch_draft(client, setup, "red", {"high_balls": 2, "auto_winner": "tie"})
        settle(client, heard)
        latest = heard["display_device"].events("live_score")[-1]
    assert latest == _totals(setup, 6, 0)
    assert snapshot(field_set_id=main_set) == {"matches": [latest], "skills": []}
    assert snapshot(field_set_id=side["id"]) == {"matches": [], "skills": []}
    assert snapshot() == {"matches": [latest], "skills": []}

    assert client.post(f"/api/matches/{other['id']}/start").status_code == 200
    other_alliances = [{"alliance_id": a["id"], "score": 0} for a in other["alliances"]]
    assert snapshot(field_set_id=side["id"])["matches"] == [{"match_id": other["id"], "alliances": other_alliances}]

    _switch(client, setup["session_id"], live_scores_qualification=False)
    assert snapshot() == {"matches": [], "skills": []}
    _switch(client, setup["session_id"], live_scores_qualification=True)
    assert client.post(f"/api/matches/{setup['match_id']}/end").status_code == 200
    assert snapshot(field_set_id=main_set) == {"matches": [], "skills": []}


def test_matches_outside_the_active_session_send_nothing(client):
    setup = scoring_setup(client)
    later = client.post("/api/sessions", json={"label": "Sunday"}).json()["id"]
    assert client.post("/api/event/active-session", json={"session_id": later}).status_code == 200
    with listening(client, "display_device") as heard:
        assert client.post(f"/api/matches/{setup['match_id']}/start").status_code == 200
        patch_draft(client, setup, "red", {"high_balls": 2})
        settle(client, heard)
    assert heard["display_device"].events("live_score") == []
    assert client.get(LIVE_URL).json() == {"matches": [], "skills": []}
