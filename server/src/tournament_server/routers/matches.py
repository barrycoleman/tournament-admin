from __future__ import annotations

import asyncio
import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role, require_scorer_or_referee
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_game_plugin_for_event, get_session_id, get_the_event
from tournament_server.match_control import (
    cancel_auto_advance,
    next_auto_phase,
    phase_after_start,
    phase_duration_seconds,
    schedule_auto_advance,
)
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.field import Field
from tournament_server.models.match import Match
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.realtime import broadcast_for_session
from tournament_server.schemas.match import (
    AllianceRead,
    MatchCreate,
    MatchRead,
    MatchResetRequest,
)

router = APIRouter(prefix="/api/matches", tags=["matches"])


def _to_match_read(match: Match, db: Session) -> MatchRead:
    alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match.id)
    ).scalars().all()
    alliance_reads = []
    for alliance in alliances:
        team_ids = [
            row.team_id
            for row in db.execute(
                select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
            )
            .scalars()
            .all()
        ]
        alliance_reads.append(
            AllianceRead(id=alliance.id, station=alliance.station, team_ids=team_ids)
        )
    return MatchRead(
        id=match.id,
        session_id=match.session_id,
        division_id=match.division_id,
        round_type=match.round_type,
        match_number=match.match_number,
        field_id=match.field_id,
        time_slot=match.time_slot,
        scheduled_time=match.scheduled_time,
        status=match.status,
        phase=match.phase,
        phase_deadline=match.phase_deadline,
        paused=match.paused,
        remaining_seconds_at_pause=match.remaining_seconds_at_pause,
        alliances=alliance_reads,
    )


@router.post("", response_model=MatchRead, status_code=201)
def create_match(
    payload: MatchCreate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> MatchRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    session_id = payload.session_id
    if session_id is None:
        session_id = event.active_session_id
    if session_id is None:
        raise HTTPException(
            status_code=422, detail="No session_id given and no active session is set"
        )
    if db.get(TournamentSession, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    game_plugin = get_game_plugin_for_event(request, db)
    alliance_count = game_plugin.module.match_format()["alliance_count"]
    if len(payload.alliances) != alliance_count:
        raise HTTPException(
            status_code=422,
            detail=f"A match must have exactly {alliance_count} alliances",
        )
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")
    if payload.field_id is not None and db.get(Field, payload.field_id) is None:
        raise HTTPException(status_code=404, detail="Field not found")
    for alliance_payload in payload.alliances:
        for team_id in alliance_payload.team_ids:
            if db.get(Team, team_id) is None:
                raise HTTPException(
                    status_code=404, detail=f"Team {team_id} not found"
                )

    match = Match(
        session_id=session_id,
        division_id=payload.division_id,
        round_type=payload.round_type,
        match_number=payload.match_number,
        field_id=payload.field_id,
        scheduled_time=payload.scheduled_time,
    )
    db.add(match)
    db.flush()

    for alliance_payload in payload.alliances:
        alliance = Alliance(match_id=match.id, station=alliance_payload.station)
        db.add(alliance)
        db.flush()
        for team_id in alliance_payload.team_ids:
            db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))

    db.commit()
    db.refresh(match)
    return _to_match_read(match, db)


@router.get("", response_model=list[MatchRead])
def list_matches(
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[MatchRead]:
    matches = db.execute(
        select(Match).where(Match.session_id == session_id)
    ).scalars().all()
    return [_to_match_read(m, db) for m in matches]


@router.get("/{match_id}", response_model=MatchRead)
def get_match(
    match_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    return _to_match_read(match, db)


_ACTIVE_PHASES = {"countdown_autonomous", "autonomous", "countdown_driver", "driver"}


async def _auto_advance_match(
    request_app, match_id: int, override_sleep_seconds: float | None = None
) -> None:
    """Sleeps until the current phase's deadline, then performs the
    automatic transition. `override_sleep_seconds` lets a caller sleep
    for less than the full phase duration — used only by startup
    recovery (app.py's `_recover_in_flight_matches`), which resumes a
    match that was already partway through its current phase when the
    server went down; every normal call site (start/start-driver/resume/
    the chained reschedule below) always sleeps the full duration."""
    from tournament_server.models.event import Event as _Event

    db = request_app.state.session_factory()
    try:
        match = db.get(Match, match_id)
        if match is None or match.paused:
            return
        event_row = db.execute(select(_Event)).scalars().first()
        game_plugin = request_app.state.game_plugins.get(event_row.game_plugin_name)
        match_format = game_plugin.module.match_format()

        if override_sleep_seconds is not None:
            sleep_seconds = override_sleep_seconds
        else:
            sleep_seconds = phase_duration_seconds(
                match.phase, match_format["autonomous_seconds"], match_format["driver_seconds"]
            )
        if sleep_seconds is not None:
            await asyncio.sleep(sleep_seconds)

        db.refresh(match)
        if match.paused:
            return
        new_phase = next_auto_phase(match.phase)
        if new_phase is None:
            return
        match.phase = new_phase
        if new_phase == "ended":
            match.phase_deadline = None
        elif new_phase == "awaiting_driver":
            match.phase_deadline = None
        else:
            next_duration = phase_duration_seconds(
                new_phase, match_format["autonomous_seconds"], match_format["driver_seconds"]
            )
            match.phase_deadline = utc_now() + dt.timedelta(seconds=next_duration)
        db.commit()

        broadcast_for_session(
            request_app,
            db,
            match.session_id,
            "match_phase_changed",
            {"match_id": match.id, "phase": match.phase, "phase_deadline": (
                match.phase_deadline.isoformat() if match.phase_deadline else None
            )},
        )

        if new_phase in ("autonomous", "driver"):
            schedule_auto_advance(
                request_app, match.id, _auto_advance_match(request_app, match.id)
            )
    finally:
        db.close()


@router.post("/{match_id}/start", response_model=MatchRead)
def start_match(
    match_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.phase != "not_started":
        raise HTTPException(
            status_code=409, detail=f"Match is not in not_started (currently {match.phase})"
        )
    plugin = get_game_plugin_for_event(request, db)
    match_format = plugin.module.match_format()
    match.phase = phase_after_start(match_format["autonomous_seconds"])
    duration = phase_duration_seconds(
        match.phase, match_format["autonomous_seconds"], match_format["driver_seconds"]
    )
    match.phase_deadline = utc_now() + dt.timedelta(seconds=duration)
    db.commit()
    db.refresh(match)

    broadcast_for_session(
        request.app, db, match.session_id, "match_phase_changed",
        {"match_id": match.id, "phase": match.phase, "phase_deadline": match.phase_deadline.isoformat()},
    )
    schedule_auto_advance(request.app, match.id, _auto_advance_match(request.app, match.id))

    return _to_match_read(match, db)


@router.post("/{match_id}/start-driver", response_model=MatchRead)
def start_driver(
    match_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.phase != "awaiting_driver":
        raise HTTPException(
            status_code=409, detail=f"Match is not in awaiting_driver (currently {match.phase})"
        )
    plugin = get_game_plugin_for_event(request, db)
    match_format = plugin.module.match_format()
    match.phase = "countdown_driver"
    match.phase_deadline = utc_now() + dt.timedelta(seconds=phase_duration_seconds(
        "countdown_driver", match_format["autonomous_seconds"], match_format["driver_seconds"]
    ))
    db.commit()
    db.refresh(match)

    broadcast_for_session(
        request.app, db, match.session_id, "match_phase_changed",
        {"match_id": match.id, "phase": match.phase, "phase_deadline": match.phase_deadline.isoformat()},
    )
    schedule_auto_advance(request.app, match.id, _auto_advance_match(request.app, match.id))

    return _to_match_read(match, db)


@router.post("/{match_id}/pause", response_model=MatchRead)
def pause_match(
    match_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.phase not in _ACTIVE_PHASES or match.paused:
        raise HTTPException(status_code=409, detail="Match is not in an active, running phase")
    cancel_auto_advance(request.app, match.id)
    match.remaining_seconds_at_pause = (match.phase_deadline - utc_now()).total_seconds()
    match.phase_deadline = None
    match.paused = True
    db.commit()
    db.refresh(match)

    broadcast_for_session(
        request.app, db, match.session_id, "match_paused",
        {"match_id": match.id, "phase": match.phase, "remaining_seconds_at_pause": match.remaining_seconds_at_pause},
    )
    return _to_match_read(match, db)


@router.post("/{match_id}/resume", response_model=MatchRead)
def resume_match(
    match_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if not match.paused:
        raise HTTPException(status_code=409, detail="Match is not paused")
    remaining = match.remaining_seconds_at_pause
    match.phase_deadline = utc_now() + dt.timedelta(seconds=remaining)
    match.remaining_seconds_at_pause = None
    match.paused = False
    db.commit()
    db.refresh(match)

    broadcast_for_session(
        request.app, db, match.session_id, "match_resumed",
        {"match_id": match.id, "phase": match.phase, "phase_deadline": match.phase_deadline.isoformat()},
    )
    # Resume with only the actual remaining time, not the full phase
    # duration — the phase already ran partway before it was paused.
    schedule_auto_advance(
        request.app, match.id,
        _auto_advance_match(request.app, match.id, override_sleep_seconds=remaining),
    )

    return _to_match_read(match, db)


@router.post("/{match_id}/end", response_model=MatchRead)
def end_match(
    match_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.phase in ("not_started", "ended"):
        raise HTTPException(status_code=409, detail=f"Match cannot be ended from {match.phase}")
    cancel_auto_advance(request.app, match.id)
    match.phase = "ended"
    match.phase_deadline = None
    match.paused = False
    match.remaining_seconds_at_pause = None
    db.commit()
    db.refresh(match)

    broadcast_for_session(
        request.app, db, match.session_id, "match_phase_changed",
        {"match_id": match.id, "phase": "ended", "phase_deadline": None},
    )
    return _to_match_read(match, db)


@router.post("/{match_id}/reset", response_model=MatchRead)
def reset_match(
    match_id: int,
    payload: MatchResetRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> MatchRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    if match.status == "completed":
        raise HTTPException(status_code=409, detail="Cannot reset a completed match")

    cancel_auto_advance(request.app, match.id)

    if payload.scope == "section" and match.phase in ("countdown_driver", "driver"):
        new_phase = "awaiting_driver"
    elif payload.scope == "section" and match.phase in ("countdown_autonomous", "autonomous"):
        new_phase = "not_started"
    elif payload.scope == "section":
        raise HTTPException(
            status_code=409, detail=f"No section to reset from {match.phase}"
        )
    else:
        new_phase = "not_started"

    match.phase = new_phase
    match.phase_deadline = None
    match.paused = False
    match.remaining_seconds_at_pause = None
    db.commit()
    db.refresh(match)

    broadcast_for_session(
        request.app, db, match.session_id, "match_reset",
        {"match_id": match.id, "phase": match.phase},
    )
    return _to_match_read(match, db)
