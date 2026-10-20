"""Skills runs on skills fields, and a skills field set's view (live scoring spec §6)."""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from tournament_server.auth import require_any_role
from tournament_server.deps import get_db, get_event_or_404, get_optional_game_plugin
from tournament_server.device_auth import require_paired_scoring_device
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_active_session, broadcast_session
from tournament_server.routers.skills import numbered_read
from tournament_server.schemas.draft import SubmitRequest
from tournament_server.schemas.skills import SkillsAttemptRead
from tournament_server.schemas.skills_run import (
    SkillsRunCreate,
    SkillsRunPatch,
    SkillsRunRead,
    SkillsSetRead,
    SkillsTypeWrite,
)
from tournament_server.services import skills, skills_runs

router = APIRouter(tags=["skills-runs"])

ADMIN_DEVICE_NAME = "Admin"


def _plugin_or_409(request: Request, db: Session) -> LoadedPlugin:
    event = get_event_or_404(db)
    plugin = get_optional_game_plugin(request, event)
    if plugin is None or not skills.is_enabled(db, event.id):
        raise HTTPException(status_code=409, detail=skills.SKILLS_OFF_DETAIL)
    return plugin


def _field_or_404(db: Session, field_id: int) -> Field:
    field = db.get(Field, field_id)
    if field is None:
        raise HTTPException(status_code=404, detail="Field not found")
    return field


def _field_set_or_404(db: Session, field_set_id: int) -> FieldSet:
    field_set = db.get(FieldSet, field_set_id)
    if field_set is None:
        raise HTTPException(status_code=404, detail="FieldSet not found")
    return field_set


def _refusal(refused: skills_runs.RunRefused) -> JSONResponse:
    content = refused.detail if isinstance(refused.detail, dict) else {"detail": refused.detail}
    return JSONResponse(status_code=refused.status_code, content=content)


@router.post("/api/fields/{field_id}/skills-run", response_model=SkillsRunRead, status_code=201)
def create_skills_run(
    field_id: int,
    payload: SkillsRunCreate,
    request: Request,
    db: Session = Depends(get_db),
    device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field = _field_or_404(db, field_id)
    plugin = _plugin_or_409(request, db)
    try:
        run = skills_runs.create_run(db, plugin, field, payload, device or ADMIN_DEVICE_NAME)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.notify(request.app, run.field_set_id, run.field_id)
    return skills_runs.run_read(db, plugin, run)


@router.patch("/api/fields/{field_id}/skills-run/draft", response_model=SkillsRunRead)
def patch_skills_run(
    field_id: int,
    payload: SkillsRunPatch,
    request: Request,
    db: Session = Depends(get_db),
    device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field = _field_or_404(db, field_id)
    plugin = _plugin_or_409(request, db)
    try:
        run = skills_runs.patch_run(db, plugin, field, payload.changes, device or ADMIN_DEVICE_NAME)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.notify(request.app, run.field_set_id, run.field_id)
    return skills_runs.run_read(db, plugin, run)


@router.delete("/api/fields/{field_id}/skills-run", status_code=204)
def discard_skills_run(
    field_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Response:
    field = _field_or_404(db, field_id)
    _plugin_or_409(request, db)
    try:
        skills_runs.discard_run(db, field)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.notify(request.app, field.field_set_id, field.id)
    return Response(status_code=204)


@router.get("/api/field-sets/{field_set_id}/skills", response_model=SkillsSetRead)
def read_skills_set(
    field_set_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> Any:
    field_set = _field_set_or_404(db, field_set_id)
    plugin = _plugin_or_409(request, db)
    try:
        return skills_runs.read_set(db, plugin, field_set)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)


@router.post("/api/fields/{field_id}/skills-run/submit", response_model=SkillsAttemptRead)
def submit_skills_run(
    field_id: int,
    payload: SubmitRequest,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field = _field_or_404(db, field_id)
    plugin = _plugin_or_409(request, db)
    try:
        attempt = skills_runs.submit_run(db, plugin, field, force=payload.force)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    data = {"session_id": attempt.session_id}
    broadcast_session(request.app, attempt.session_id, "skills_changed", data)
    broadcast_active_session(request.app, "skills_changed", data)
    skills_runs.notify(request.app, field.field_set_id, field.id)
    return numbered_read(db, attempt)


@router.post("/api/fields/{field_id}/skills-run/{action}", response_model=SkillsRunRead)
def field_timer(
    field_id: int,
    action: skills_runs.TimerAction,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field = _field_or_404(db, field_id)
    plugin = _plugin_or_409(request, db)
    try:
        run = skills_runs.field_timer_action(db, plugin, field, action.value)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.schedule_expiry(request.app, run.field_set_id, run.field_id, run.deadline)
    skills_runs.notify(request.app, run.field_set_id, run.field_id)
    return skills_runs.run_read(db, plugin, run)


@router.post("/api/field-sets/{field_set_id}/skills-timer/{action}", response_model=SkillsSetRead)
def set_timer(
    field_set_id: int,
    action: skills_runs.TimerAction,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field_set = _field_set_or_404(db, field_set_id)
    plugin = _plugin_or_409(request, db)
    try:
        timer = skills_runs.set_timer_action(db, plugin, field_set, action.value)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.schedule_expiry(request.app, field_set_id, None, timer.deadline)
    skills_runs.notify(request.app, field_set_id)
    return skills_runs.read_set(db, plugin, field_set)


@router.put("/api/field-sets/{field_set_id}/skills-timer", response_model=SkillsSetRead)
def set_skills_type(
    field_set_id: int,
    payload: SkillsTypeWrite,
    request: Request,
    db: Session = Depends(get_db),
    _device: str | None = Depends(require_paired_scoring_device),
) -> Any:
    field_set = _field_set_or_404(db, field_set_id)
    plugin = _plugin_or_409(request, db)
    try:
        skills_runs.set_set_type(db, plugin, field_set, payload.skills_type)
    except skills_runs.RunRefused as refused:
        return _refusal(refused)
    skills_runs.notify(request.app, field_set_id)
    return skills_runs.read_set(db, plugin, field_set)
