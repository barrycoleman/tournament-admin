"""Shared setup for the live scoring tests: scoring-ready matches, draft
patches, and recorders registered on the active-session channel under a
role, so a test can see which roles an event reached and which it didn't."""
from __future__ import annotations

import contextlib
import time
import uuid

from sqlalchemy import select

from display_helpers import add_field_set, add_match, add_teams, setup_event
from ranking_helpers import finalize_qualification
from tournament_server import realtime
from tournament_server.models.scoring_draft import ScoreDraft

# A complete example-game alliance sheet: 3 * high_balls + low_balls, and
# "tie" adds no autonomous bonus, so this one scores 9.
DRAFT = {"high_balls": 3, "low_balls": 0, "parked": False, "auto_winner": "tie"}


def _by_station(match: dict) -> tuple[int, int]:
    alliances = {alliance["station"]: alliance["id"] for alliance in match["alliances"]}
    return alliances["red"], alliances["blue"]


def scoring_setup(client, *, round_type: str = "qualification") -> dict:
    """An example-game event with an active session, one field set of two
    fields, four teams and one match on the first field."""
    session_id = setup_event(client)
    field_set = add_field_set(client, session_id)
    teams = add_teams(client)
    match = add_match(client, session_id, field_set["field_ids"][0], 1, teams, round_type=round_type)
    red, blue = _by_station(match)
    return {
        "session_id": session_id,
        "field_set": field_set,
        "teams": teams,
        "match": match,
        "match_id": match["id"],
        "red": red,
        "blue": blue,
    }


def cooperative_setup(client) -> dict:
    """A cooperative-game event with one qualification match: one team per alliance."""
    session_id = setup_event(client, game="cooperative-game")
    t1, t2 = add_teams(client, count=2)
    created = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [{"station": "red", "team_ids": [t1]}, {"station": "blue", "team_ids": [t2]}],
        },
    )
    assert created.status_code == 201, created.text
    match = created.json()
    red, blue = _by_station(match)
    return {"session_id": session_id, "teams": [t1, t2], "match": match, "match_id": match["id"], "red": red, "blue": blue}


def score_chase_setup(client) -> dict:
    """A cooperative-game score chase with two runs, started in the active
    session: returns the bracket id, the first run's match id and its one
    alliance (a run has a single alliance holding both teams)."""
    client.post("/api/event", json={"name": "Finals Event"})
    client.post("/api/event/game-plugin", json={"name": "cooperative-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    team_ids = [
        client.post("/api/teams", json={"number": str(n + 1), "name": f"Team {n + 1}"}).json()["id"]
        for n in range(4)
    ]
    for n, team_id in enumerate(team_ids):
        match = client.post(
            "/api/matches",
            json={
                "session_id": session_id,
                "round_type": "qualification",
                "match_number": 100 + n,
                "field_id": None,
                "alliances": [{"station": "red", "team_ids": [team_id]}, {"station": "blue", "team_ids": [team_id]}],
            },
        ).json()
        red = next(a["id"] for a in match["alliances"] if a["station"] == "red")
        client.post(
            f"/api/matches/{match['id']}/alliances/{red}/score",
            json={"data": {"objects_scored": (len(team_ids) - n) * 10}},
        )
    finalize_qualification(client, session_id)
    bracket = client.post("/api/finals/start", json={"session_id": session_id, "bracket_size": 2}).json()
    match_id = bracket["runs"][0]["match_id"]
    alliance_ids = [a["id"] for a in client.get(f"/api/matches/{match_id}").json()["alliances"]]
    return {"session_id": session_id, "bracket_id": bracket["id"], "match_id": match_id, "alliance_ids": alliance_ids}


def patch_draft(client, setup: dict, side, changes: dict | None = None, teams: list | None = None, headers=None):
    """PATCHes one alliance's draft. `side` is "red"/"blue" (a key of `setup`) or an alliance id."""
    alliance_id = setup[side] if isinstance(side, str) else side
    body: dict = {"changes": changes or {}}
    if teams is not None:
        body["teams"] = teams
    return client.patch(
        f"/api/matches/{setup['match_id']}/alliances/{alliance_id}/draft", json=body, headers=headers
    )


def draft_rows(client) -> list[ScoreDraft]:
    with client.app.state.session_factory() as db:
        return list(db.execute(select(ScoreDraft).order_by(ScoreDraft.id)).scalars().all())


class Recorder:
    """A stand-in socket on the active-session channel that keeps every message it is sent."""

    def __init__(self) -> None:
        self.received: list[dict] = []

    async def send_json(self, message: dict) -> None:
        self.received.append(message)

    def events(self, name: str) -> list[dict]:
        return [message["data"] for message in self.received if message["event"] == name]


@contextlib.contextmanager
def listening(client, *roles: str):
    """Registers one Recorder per role on the active-session channel; yields {role: Recorder}."""
    recorders = {role: Recorder() for role in roles}
    for role, recorder in recorders.items():
        realtime.register_active_session(client.app, recorder, role)
    try:
        yield recorders
    finally:
        for recorder in recorders.values():
            realtime.unregister_active_session(client.app, recorder)


def settle(client, recorders: dict, timeout: float = 3.0) -> None:
    """Waits until every broadcast sent so far has reached the recorders:
    broadcasts run in order on the server's loop, so once a marker sent to
    everyone arrives, everything before it has too."""
    marker = uuid.uuid4().hex
    realtime.broadcast_active_session(client.app, "test_marker", {"id": marker})
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if all(
            any(data["id"] == marker for data in recorder.events("test_marker"))
            for recorder in recorders.values()
        ):
            return
        time.sleep(0.01)
    raise AssertionError("broadcasts never reached the recorders")
