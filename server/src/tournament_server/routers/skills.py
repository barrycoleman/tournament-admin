"""Skills challenges: settings, session overrides, scoresheets, attempts and rankings."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_event_or_404, get_optional_game_plugin
from tournament_server.models.event import Event
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsSettings
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_active_session, broadcast_session
from tournament_server.schemas.skills import (
    SessionSkillsBody,
    SessionSkillsRead,
    SkillsSettingsBody,
    SkillsSettingsRead,
)
from tournament_server.services import skills
from tournament_server.services.skills_rules import DEFAULT_ATTEMPTS, attempts_error

router = APIRouter(tags=["skills"])

_event_or_404 = get_event_or_404


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
    types = skills.plugin_types(get_optional_game_plugin(request, _event_or_404(db)))
    allowed = skills.session_allowed(db, session_obj, [t["key"] for t in types])
    return SessionSkillsRead(
        types=[{**t, "allowed": allowed[t["key"]]} for t in types],
        override=session_obj.skills_attempts,
    )


@router.get("/api/skills/settings", response_model=SkillsSettingsRead)
def get_skills_settings(
    request: Request, db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> SkillsSettingsRead:
    event = _event_or_404(db)
    return _settings_read(db, event, get_optional_game_plugin(request, event))


@router.put("/api/skills/settings", response_model=SkillsSettingsRead)
def put_skills_settings(
    payload: SkillsSettingsBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SkillsSettingsRead:
    event = _event_or_404(db)
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
        types = skills.plugin_types(get_optional_game_plugin(request, _event_or_404(db)))
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
    plugin = get_optional_game_plugin(request, _event_or_404(db))
    if key not in [t["key"] for t in skills.plugin_types(plugin)]:
        raise HTTPException(status_code=404, detail="Unknown skills type")
    return plugin.module.skills_scoresheet_schema(key)
