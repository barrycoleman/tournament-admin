"""Skills challenges: settings, session overrides, scoresheets, attempts and rankings."""
from __future__ import annotations

import json
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_event_or_404, get_optional_game_plugin
from tournament_server.device_auth import require_admitted_device
from tournament_server.models.event import Event
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsAttempt, SkillsSettings
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_active_session, broadcast_session
from tournament_server.schemas.skills import (
    SessionSkillsBody,
    SessionSkillsRead,
    SkillsAttemptCreate,
    SkillsAttemptRead,
    SkillsAttemptUpdate,
    SkillsRankingRowRead,
    SkillsSettingsBody,
    SkillsSettingsRead,
)
from tournament_server.services import skills
from tournament_server.services.skills_ranking import OVERALL
from tournament_server.services.skills_rules import DEFAULT_ATTEMPTS, attempts_error, scoresheet_violations

router = APIRouter(tags=["skills"])

def _session_or_404(db: Session, session_id: int) -> TournamentSession:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_obj


def _settings_read(db: Session, event: Event, plugin: LoadedPlugin | None) -> SkillsSettingsRead:
    types = skills.plugin_types(plugin)
    stored = skills.event_attempts(db, event.id)
    return SkillsSettingsRead(
        enabled=skills.is_enabled(db, event.id),
        attempts={t["key"]: stored.get(t["key"], DEFAULT_ATTEMPTS) for t in types},
        types=types,
    )


def _session_read(db: Session, request: Request, session_obj: TournamentSession) -> SessionSkillsRead:
    types = skills.plugin_types(get_optional_game_plugin(request, get_event_or_404(db)))
    allowed = skills.session_allowed(db, session_obj, [t["key"] for t in types])
    return SessionSkillsRead(
        types=[{**t, "allowed": allowed[t["key"]]} for t in types],
        override=session_obj.skills_attempts,
    )


@router.get("/api/skills/settings", response_model=SkillsSettingsRead)
def get_skills_settings(
    request: Request, db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> SkillsSettingsRead:
    event = get_event_or_404(db)
    return _settings_read(db, event, get_optional_game_plugin(request, event))


@router.put("/api/skills/settings", response_model=SkillsSettingsRead)
def put_skills_settings(
    payload: SkillsSettingsBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SkillsSettingsRead:
    event = get_event_or_404(db)
    plugin = get_optional_game_plugin(request, event)
    if plugin is None:
        raise HTTPException(status_code=409, detail=skills.NO_PLUGIN_DETAIL)
    types = skills.plugin_types(plugin)
    error = attempts_error(payload.attempts, [t["key"] for t in types])
    if error is not None:
        raise HTTPException(status_code=422, detail=error)
    if payload.enabled and not types:
        raise HTTPException(status_code=409, detail=skills.NO_TYPES_DETAIL)
    settings = skills.find_settings(db, event.id)
    if settings is None:
        settings = SkillsSettings(event_id=event.id)
        db.add(settings)
    settings.enabled = payload.enabled
    settings.attempts = dict(payload.attempts)
    db.commit()
    broadcast_active_session(request.app, "skills_settings_changed", {"session_id": None})
    return _settings_read(db, event, plugin)


@router.get("/api/sessions/{session_id}/skills", response_model=SessionSkillsRead)
def get_session_skills(
    session_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> SessionSkillsRead:
    return _session_read(db, request, _session_or_404(db, session_id))


@router.put("/api/sessions/{session_id}/skills", response_model=SessionSkillsRead)
def put_session_skills(
    session_id: int,
    payload: SessionSkillsBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionSkillsRead:
    session_obj = _session_or_404(db, session_id)
    if payload.attempts:
        types = skills.plugin_types(get_optional_game_plugin(request, get_event_or_404(db)))
        error = attempts_error(payload.attempts, [t["key"] for t in types])
        if error is not None:
            raise HTTPException(status_code=422, detail=error)
    session_obj.skills_attempts = dict(payload.attempts) if payload.attempts else None
    db.commit()
    data = {"session_id": session_id}
    broadcast_session(request.app, session_id, "skills_settings_changed", data)
    broadcast_active_session(request.app, "skills_settings_changed", data)
    return _session_read(db, request, session_obj)


@router.get("/api/skills/types/{key}/schema", response_model=list[dict[str, Any]])
def get_skills_schema(
    key: str,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[dict[str, Any]]:
    plugin = get_optional_game_plugin(request, get_event_or_404(db))
    if key not in [t["key"] for t in skills.plugin_types(plugin)]:
        raise HTTPException(status_code=404, detail="Unknown skills type")
    return plugin.module.skills_scoresheet_schema(key)


def _require_admin_to_change(role: str = Depends(require_any_role)) -> str:
    if role != "admin":
        raise HTTPException(status_code=403, detail=skills.ADMIN_ONLY_DETAIL)
    return role


def _enabled_plugin_or_409(db: Session, request: Request, event: Event) -> LoadedPlugin:
    plugin = get_optional_game_plugin(request, event)
    if plugin is None or not skills.is_enabled(db, event.id):
        raise HTTPException(status_code=409, detail=skills.SKILLS_OFF_DETAIL)
    return plugin


def _violations_response(violations: list[dict[str, str]]) -> JSONResponse:
    return JSONResponse(
        status_code=422, content={"detail": "The scoresheet has errors.", "violations": violations}
    )


def _score(plugin: LoadedPlugin, skills_type: str, data: dict[str, Any]) -> int:
    try:
        return int(plugin.module.calculate_skills_score(skills_type, data))
    except Exception as exc:  # noqa: BLE001 - a plugin bug becomes a readable 422, not a 500
        raise HTTPException(status_code=422, detail=f"Plugin could not score this scoresheet: {exc}")


def _session_attempts(db: Session, session_id: int) -> list[SkillsAttempt]:
    return list(
        db.execute(
            select(SkillsAttempt)
            .where(SkillsAttempt.session_id == session_id)
            .order_by(SkillsAttempt.recorded_at, SkillsAttempt.id)
        ).scalars().all()
    )


def _attempt_read(attempt: SkillsAttempt, number: int) -> SkillsAttemptRead:
    return SkillsAttemptRead(
        id=attempt.id,
        team_id=attempt.team_id,
        skills_type=attempt.skills_type,
        number=number,
        score=attempt.score,
        data=json.loads(attempt.data_json),
        recorded_at=attempt.recorded_at,
        updated_at=attempt.updated_at,
    )


def _numbered_read(db: Session, attempt: SkillsAttempt) -> SkillsAttemptRead:
    return _attempt_read(attempt, skills.attempt_numbers(_session_attempts(db, attempt.session_id))[attempt.id])


def _broadcast_skills_changed(request: Request, session_id: int) -> None:
    # The active-session channel always gets it: Season Rankings listens there.
    data = {"session_id": session_id}
    broadcast_session(request.app, session_id, "skills_changed", data)
    broadcast_active_session(request.app, "skills_changed", data)


@router.get("/api/sessions/{session_id}/skills/attempts", response_model=list[SkillsAttemptRead])
def list_skills_attempts(
    session_id: int, db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[SkillsAttemptRead]:
    _session_or_404(db, session_id)
    attempts = _session_attempts(db, session_id)
    numbers = skills.attempt_numbers(attempts)
    return [_attempt_read(attempt, numbers[attempt.id]) for attempt in attempts]


@router.post("/api/sessions/{session_id}/skills/attempts", response_model=SkillsAttemptRead, status_code=201)
def create_skills_attempt(
    session_id: int,
    payload: SkillsAttemptCreate,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_admitted_device),
) -> Any:
    session_obj = _session_or_404(db, session_id)
    event = get_event_or_404(db)
    plugin = _enabled_plugin_or_409(db, request, event)
    types = {t["key"]: t for t in skills.plugin_types(plugin)}
    if payload.skills_type not in types:
        raise HTTPException(status_code=422, detail=f"Unknown skills type: {payload.skills_type!r}")
    team = db.get(Team, payload.team_id)
    if team is None or team.event_id != event.id:
        raise HTTPException(status_code=422, detail="Unknown team")
    checked_in = db.execute(
        select(SessionParticipation.id).where(
            SessionParticipation.session_id == session_id,
            SessionParticipation.team_id == team.id,
            SessionParticipation.checked_in.is_(True),
        )
    ).first()
    if checked_in is None:
        raise HTTPException(status_code=409, detail=f"Team {team.number} is not checked in for this session.")
    allowed = skills.session_allowed(db, session_obj, list(types))[payload.skills_type]
    used = db.execute(
        select(func.count(SkillsAttempt.id)).where(
            SkillsAttempt.session_id == session_id,
            SkillsAttempt.team_id == team.id,
            SkillsAttempt.skills_type == payload.skills_type,
        )
    ).scalar_one()
    if used >= allowed:
        label = types[payload.skills_type]["label"]
        raise HTTPException(
            status_code=409, detail=f"Team {team.number} has used all {allowed} {label} attempts."
        )
    violations = scoresheet_violations(plugin.module.skills_scoresheet_schema(payload.skills_type), payload.data)
    if violations:
        return _violations_response(violations)
    score = _score(plugin, payload.skills_type, payload.data)
    now = utc_now()
    attempt = SkillsAttempt(
        session_id=session_id,
        team_id=team.id,
        skills_type=payload.skills_type,
        data_json=json.dumps(payload.data),
        score=score,
        plugin_name=plugin.name,
        plugin_version=plugin.version,
        recorded_at=now,
        updated_at=now,
    )
    db.add(attempt)
    db.commit()
    db.refresh(attempt)
    _broadcast_skills_changed(request, session_id)
    return _numbered_read(db, attempt)


def _attempt_or_404(db: Session, attempt_id: int) -> SkillsAttempt:
    attempt = db.get(SkillsAttempt, attempt_id)
    if attempt is None:
        raise HTTPException(status_code=404, detail="Skills attempt not found")
    return attempt


@router.put("/api/skills/attempts/{attempt_id}", response_model=SkillsAttemptRead)
def update_skills_attempt(
    attempt_id: int,
    payload: SkillsAttemptUpdate,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(_require_admin_to_change),
) -> Any:
    attempt = _attempt_or_404(db, attempt_id)
    plugin = _enabled_plugin_or_409(db, request, get_event_or_404(db))
    violations = scoresheet_violations(plugin.module.skills_scoresheet_schema(attempt.skills_type), payload.data)
    if violations:
        return _violations_response(violations)
    attempt.score = _score(plugin, attempt.skills_type, payload.data)
    attempt.data_json = json.dumps(payload.data)
    attempt.plugin_name = plugin.name
    attempt.plugin_version = plugin.version
    attempt.updated_at = utc_now()
    db.commit()
    db.refresh(attempt)
    _broadcast_skills_changed(request, attempt.session_id)
    return _numbered_read(db, attempt)


@router.delete("/api/skills/attempts/{attempt_id}", status_code=204)
def delete_skills_attempt(
    attempt_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(_require_admin_to_change),
) -> Response:
    attempt = _attempt_or_404(db, attempt_id)
    _enabled_plugin_or_409(db, request, get_event_or_404(db))
    session_id = attempt.session_id
    db.delete(attempt)
    db.commit()
    _broadcast_skills_changed(request, session_id)
    return Response(status_code=204)


@router.get("/api/skills/rankings", response_model=list[SkillsRankingRowRead])
def get_skills_rankings(
    request: Request,
    tab: str = Query(...),
    session_id: int | None = Query(None),
    season: bool = Query(False),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[SkillsRankingRowRead]:
    if (session_id is not None) == season:
        raise HTTPException(status_code=422, detail="Give exactly one of session_id or season=true")
    event = get_event_or_404(db)
    type_keys = [t["key"] for t in skills.plugin_types(get_optional_game_plugin(request, event))]
    if tab != OVERALL and tab not in type_keys:
        raise HTTPException(status_code=404, detail="Unknown rankings tab")
    if season:
        sessions = list(
            db.execute(select(TournamentSession).where(TournamentSession.event_id == event.id)).scalars().all()
        )
    else:
        sessions = [_session_or_404(db, session_id)]
    rows = skills.compute_rankings(db, type_keys, tab, sessions)
    return [
        SkillsRankingRowRead(
            rank=row.rank, team_id=row.team_id, score=row.score, attempts=row.attempts, session_id=row.session_id
        )
        for row in rows
    ]
