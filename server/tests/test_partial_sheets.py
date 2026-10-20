"""A draft holds only the items someone changed, while the scoring page shows
every other item at its default. Live totals, Submit and the stored official
sheet must count those untouched items at their defaults too."""
from __future__ import annotations

import json

from sqlalchemy import select

from live_helpers import cooperative_setup, patch_draft, scoring_setup
from tournament_server.models.score_record import ScoreRecord
from tournament_server.services.scoresheets import sheet_with_defaults

EXAMPLE_DEFAULTS = {"high_balls": 0, "low_balls": 0, "parked": False, "auto_winner": "tie"}


def _stored(client, alliance_id: int) -> dict:
    with client.app.state.session_factory() as db:
        record = db.execute(select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)).scalars().one()
        return json.loads(record.data_json)


def test_sheet_with_defaults_lays_the_data_over_every_default():
    schema = [{"name": "a", "default": 0}, {"name": "b", "default": "tie"}]
    assert sheet_with_defaults(schema, {"a": 3}) == {"a": 3, "b": "tie"}
    assert sheet_with_defaults(schema, {}) == {"a": 0, "b": "tie"}
    assert sheet_with_defaults(schema, {"a": 1, "b": "red"}) == {"a": 1, "b": "red"}


def test_a_partial_head_to_head_sheet_counts_untouched_items_at_their_defaults(client):
    s = scoring_setup(client)
    # Autonomous Winner stays at its default "tie" on screen, so no bonus.
    red = patch_draft(client, s, "red", {"high_balls": 3})
    blue = patch_draft(client, s, "blue", {"low_balls": 1})
    assert red.json()["score"] == 9
    assert blue.json()["score"] == 1
    scores = {a["alliance_id"]: a["score"] for a in client.get(f"/api/matches/{s['match_id']}/draft").json()["alliances"]}
    assert scores == {s["red"]: 9, s["blue"]: 1}

    submitted = client.post(f"/api/matches/{s['match_id']}/submit", json={})
    assert submitted.status_code == 200, submitted.text
    official = {a["alliance_id"]: a["score"] for a in submitted.json()["alliances"]}
    assert official == {s["red"]: 9, s["blue"]: 1}
    assert _stored(client, s["red"]) == {**EXAMPLE_DEFAULTS, "high_balls": 3}
    assert _stored(client, s["blue"]) == {**EXAMPLE_DEFAULTS, "low_balls": 1}


def test_a_partial_cooperative_sheet_is_stored_complete(cooperative_client):
    client = cooperative_client
    s = cooperative_setup(client)
    # Only a team flag is touched: no item was ever entered.
    team = s["teams"][0]
    drafted = patch_draft(client, s, "red", {}, teams=[{"team_id": team, "no_show": False, "dq": False}])
    assert drafted.status_code == 200, drafted.text
    assert drafted.json()["score"] == 0

    submitted = client.post(f"/api/matches/{s['match_id']}/submit", json={})
    assert submitted.status_code == 200, submitted.text
    assert [a["score"] for a in submitted.json()["alliances"]] == [0, 0]
    assert _stored(client, s["red"]) == {"objects_scored": 0}
    assert _stored(client, s["blue"]) == {"objects_scored": 0}
