"""What displays may see of a match's draft scores while it is played
(live scoring spec §7). The server decides; displays draw what they get.

A teamwork match's totals go out while its clock runs (paused included)
and the session's switch for its round is on: `live_scores_finals` for a
finals match, `live_scores_qualification` otherwise (practice included).
When it stops being allowed (time up, reset, submitted, switch off) the
displays get `{"match_id", "cleared": True}`.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.deps import get_the_event
from tournament_server.models.field_set import SKILLS, FieldSet
from tournament_server.models.match import Match
from tournament_server.models.scoring_draft import SkillsRun
from tournament_server.models.session import TournamentSession
from tournament_server.services import displays, drafts, qualification, skills_runs

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
    for skills_set_id in db.execute(
        select(FieldSet.id).where(FieldSet.session_id == session_id, FieldSet.purpose == SKILLS)
    ).scalars().all():
        on_skills_changed(app, db, skills_set_id)


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
    if field_set_id is not None:
        skills_sets = [field_set_id]
    else:
        skills_sets = db.execute(
            select(FieldSet.id)
            .where(FieldSet.session_id == event.active_session_id, FieldSet.purpose == SKILLS)
            .order_by(FieldSet.id)
        ).scalars().all()
    skills = [payload for set_id in skills_sets for payload in skills_live_payloads(db, plugin, set_id)]
    return {"matches": matches, "skills": skills}


def skills_live_payloads(db: Session, plugin: "LoadedPlugin | None", field_set_id: int) -> list[dict]:
    """What displays may show for a skills set's fields (spec §7): a run's live
    total while its timer runs and the session's live_scores_qualification
    switch is on; once its timer has ended, the breakdown and total whatever
    the switch, until it is submitted or discarded."""
    field_set = db.get(FieldSet, field_set_id)
    if plugin is None or field_set is None or field_set.purpose != SKILLS:
        return []
    session_obj = db.get(TournamentSession, field_set.session_id)
    set_timer = skills_runs.find_set_timer(db, field_set_id)
    payloads = []
    for run in db.execute(
        select(SkillsRun).where(SkillsRun.field_set_id == field_set_id).order_by(SkillsRun.field_id)
    ).scalars().all():
        phase = skills_runs.effective_timer(run, set_timer).phase
        data = json.loads(run.data_json)
        score = skills_runs.run_score(plugin, run.skills_type, data)
        if phase == skills_runs.ENDED:
            payloads.append(
                {"field_id": run.field_id, "breakdown": skills_runs.breakdown(plugin, run.skills_type, data), "score": score}
            )
        elif phase == skills_runs.RUNNING and session_obj.live_scores_qualification:
            payloads.append({"field_id": run.field_id, "score": score})
    return payloads


def on_skills_changed(app: "FastAPI", db: Session, field_set_id: int) -> None:
    """A skills set's runs or timer changed: every field of the set gets its
    payload, or `cleared` when nothing may be shown."""
    shown = {payload["field_id"]: payload for payload in skills_live_payloads(db, _plugin(app, db), field_set_id)}
    for field_id in displays.field_ids_for_set(db, field_set_id):
        realtime.broadcast_active_session(
            app, "live_score", shown.get(field_id, {"field_id": field_id, "cleared": True}), roles=LIVE_SCORE_ROLES
        )
