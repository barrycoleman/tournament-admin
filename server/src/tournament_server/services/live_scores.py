"""What displays may see of a match's draft scores while it is played
(live scoring spec §7). The server decides; displays draw what they get.

A teamwork match's totals go out while its clock runs (paused included)
and the session's switch for its round is on: `live_scores_finals` for a
finals match, `live_scores_qualification` otherwise (practice included).
When it stops being allowed (time up, reset, submitted, switch off) the
displays get `{"match_id", "cleared": True}`.
"""
from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.deps import get_the_event
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession
from tournament_server.services import displays, drafts, qualification

if TYPE_CHECKING:
    from fastapi import FastAPI

    from tournament_server.plugin_registry.loader import LoadedPlugin

LIVE_PHASES = frozenset({"countdown_autonomous", "autonomous", "awaiting_driver", "countdown_driver", "driver"})
LIVE_SCORE_ROLES = ("display_device", "admin")


def _plugin(app: "FastAPI", db: Session) -> "LoadedPlugin | None":
    event = get_the_event(db)
    if event is None or event.game_plugin_name is None:
        return None
    return app.state.game_plugins.get(event.game_plugin_name)


def _in_active_session(db: Session, session_id: int) -> bool:
    event = get_the_event(db)
    return event is not None and event.active_session_id == session_id


def match_live_allowed(db: Session, match: Match) -> bool:
    if match.phase not in LIVE_PHASES or match.status in ("completed", qualification.NOT_PLAYED):
        return False
    session_obj = db.get(TournamentSession, match.session_id)
    if session_obj is None:
        return False
    if match.finals_bracket_id is not None:
        return bool(session_obj.live_scores_finals)
    return bool(session_obj.live_scores_qualification)


def match_payload(db: Session, plugin: "LoadedPlugin", match: Match) -> dict:
    read = drafts.read_match_draft(db, plugin, match)
    return {
        "match_id": match.id,
        "alliances": [{"alliance_id": alliance.alliance_id, "score": alliance.score} for alliance in read.alliances],
    }


def _send(app: "FastAPI", data: dict) -> None:
    realtime.broadcast_active_session(app, "live_score", data, roles=LIVE_SCORE_ROLES)


def on_draft_changed(app: "FastAPI", db: Session, match: Match) -> None:
    """A draft changed: displays get the new totals if they may see them."""
    if not _in_active_session(db, match.session_id) or not match_live_allowed(db, match):
        return
    plugin = _plugin(app, db)
    if plugin is not None:
        _send(app, match_payload(db, plugin, match))


def on_match_phase_changed(app: "FastAPI", db: Session, match: Match) -> None:
    """The match's clock moved, it was reset or submitted, or a switch
    flipped: send its totals when allowed, else tell displays to drop them."""
    if not _in_active_session(db, match.session_id):
        return
    plugin = _plugin(app, db)
    if plugin is not None and match_live_allowed(db, match):
        _send(app, match_payload(db, plugin, match))
    else:
        _send(app, {"match_id": match.id, "cleared": True})


def on_switches_changed(app: "FastAPI", db: Session, session_id: int) -> None:
    """A session's live-score switches changed: re-evaluate every running match."""
    if not _in_active_session(db, session_id):
        return
    for match in db.execute(
        select(Match).where(Match.session_id == session_id, Match.phase.in_(LIVE_PHASES)).order_by(Match.id)
    ).scalars().all():
        on_match_phase_changed(app, db, match)


def live_snapshot(db: Session, plugin: "LoadedPlugin | None", field_set_id: int | None) -> dict:
    """What a display starting up or reconnecting may show now, the same as
    the `live_score` events would have told it."""
    event = get_the_event(db)
    if plugin is None or event is None or event.active_session_id is None:
        return {"matches": [], "skills": []}
    query = select(Match).where(
        Match.session_id == event.active_session_id, Match.phase.in_(LIVE_PHASES)
    ).order_by(Match.id)
    if field_set_id is not None:
        query = query.where(Match.field_id.in_(displays.field_ids_for_set(db, field_set_id)))
    matches = [
        match_payload(db, plugin, match)
        for match in db.execute(query).scalars().all()
        if match_live_allowed(db, match)
    ]
    # Skills fields join in Task 10 (skills_live_payloads).
    return {"matches": matches, "skills": []}


def on_skills_changed(app: "FastAPI", db: Session, field_set_id: int) -> None:
    """A skills run or timer on this set changed: push its live scores.
    Task 10 fills this in; until then nothing is sent."""
    return None
