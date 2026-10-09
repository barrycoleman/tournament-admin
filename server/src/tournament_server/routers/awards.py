"""Awards: definitions, winners, finalize, team history and the CSV export."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_event_or_404, get_optional_game_plugin
from tournament_server.models.award import Award, AwardWinner
from tournament_server.models.division import Division
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_for_session
from tournament_server.schemas.award import (
    AwardBody,
    AwardCopyBody,
    AwardOrderBody,
    AwardPatch,
    AwardRead,
    AwardSlotRead,
    SessionAwardsRead,
    WinnerTeamRead,
)
from tournament_server.services import awards as rules

router = APIRouter(tags=["awards"])

DEFINITION_FIELDS = ("name", "description", *rules.RULE_FIELDS)


def _session_or_404(db: Session, session_id: int) -> TournamentSession:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_obj


def _award_or_404(db: Session, award_id: int) -> Award:
    award = db.get(Award, award_id)
    if award is None:
        raise HTTPException(status_code=404, detail="Award not found")
    return award


def _ensure_open(session_obj: TournamentSession) -> None:
    if session_obj.awards_finalized_at is not None:
        raise HTTPException(status_code=409, detail=rules.LOCKED_DETAIL)


def _plugin(request: Request, db: Session) -> LoadedPlugin | None:
    return get_optional_game_plugin(request, get_event_or_404(db))


def _changed(request: Request, db: Session, session_id: int) -> None:
    broadcast_for_session(request.app, db, session_id, "awards_changed", {"session_id": session_id})


def _team_read(db: Session, team_id: int) -> WinnerTeamRead:
    team = db.get(Team, team_id)
    return WinnerTeamRead(team_id=team.id, number=team.number, name=team.name, organization=team.organization)


def _award_read(db: Session, plugin: LoadedPlugin | None, award: Award) -> AwardRead:
    slots = []
    for division_id in rules.slot_division_ids(db, award):
        state = rules.slot_state(db, plugin, award, division_id)
        division = db.get(Division, division_id) if division_id is not None else None
        slots.append(
            AwardSlotRead(
                division_id=division_id,
                division_name=division.name if division is not None else None,
                status=state.status,
                winners=[_team_read(db, t) for t in state.team_ids],
                override_reason=state.override_reason,
                note=state.note,
                moved_team_ids=state.moved_team_ids,
            )
        )
    return AwardRead(
        id=award.id, session_id=award.session_id, position=award.position,
        **{name: getattr(award, name) for name in DEFINITION_FIELDS},
        slots=slots,
    )


def _session_read(db: Session, plugin: LoadedPlugin | None, session_obj: TournamentSession) -> SessionAwardsRead:
    return SessionAwardsRead(
        awards_finalized_at=session_obj.awards_finalized_at,
        awards=[_award_read(db, plugin, a) for a in rules.session_awards(db, session_obj.id)],
    )


def _validated(db: Session, definition: dict) -> dict:
    definition = rules.normalized(definition)
    error = rules.definition_error(definition, set(rules.event_division_ids(db)))
    if error is not None:
        raise HTTPException(status_code=422, detail=error)
    return definition


def _renumber(db: Session, session_id: int) -> None:
    for position, award in enumerate(rules.session_awards(db, session_id)):
        award.position = position


@router.get("/api/sessions/{session_id}/awards", response_model=SessionAwardsRead)
def list_awards(
    session_id: int, request: Request, db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> SessionAwardsRead:
    return _session_read(db, _plugin(request, db), _session_or_404(db, session_id))


@router.post("/api/sessions/{session_id}/awards", response_model=AwardRead, status_code=201)
def create_award(
    session_id: int,
    payload: AwardBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> AwardRead:
    session_obj = _session_or_404(db, session_id)
    _ensure_open(session_obj)
    definition = _validated(db, payload.model_dump())
    award = Award(session_id=session_id, position=len(rules.session_awards(db, session_id)), **definition)
    db.add(award)
    db.commit()
    _changed(request, db, session_id)
    return _award_read(db, _plugin(request, db), award)


@router.patch("/api/awards/{award_id}", response_model=AwardRead)
def update_award(
    award_id: int,
    payload: AwardPatch,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> AwardRead:
    award = _award_or_404(db, award_id)
    _ensure_open(_session_or_404(db, award.session_id))
    current = {name: getattr(award, name) for name in DEFINITION_FIELDS}
    definition = _validated(db, {**current, **payload.model_dump(exclude_unset=True)})
    rule_changed = any(definition[name] != current[name] for name in rules.RULE_FIELDS)
    for name, value in definition.items():
        setattr(award, name, value)
    if rule_changed:
        for winner in db.execute(select(AwardWinner).where(AwardWinner.award_id == award.id)).scalars().all():
            db.delete(winner)
    db.commit()
    _changed(request, db, award.session_id)
    return _award_read(db, _plugin(request, db), award)


@router.delete("/api/awards/{award_id}", status_code=204)
def delete_award(
    award_id: int, request: Request, db: Session = Depends(get_db), _role: str = Depends(require_admin)
) -> Response:
    award = _award_or_404(db, award_id)
    session_id = award.session_id
    _ensure_open(_session_or_404(db, session_id))
    for winner in db.execute(select(AwardWinner).where(AwardWinner.award_id == award.id)).scalars().all():
        db.delete(winner)
    db.flush()
    db.delete(award)
    db.flush()
    _renumber(db, session_id)
    db.commit()
    _changed(request, db, session_id)
    return Response(status_code=204)


@router.put("/api/sessions/{session_id}/awards/order", response_model=SessionAwardsRead)
def order_awards(
    session_id: int,
    payload: AwardOrderBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionAwardsRead:
    session_obj = _session_or_404(db, session_id)
    _ensure_open(session_obj)
    awards = {a.id: a for a in rules.session_awards(db, session_id)}
    if len(payload.award_ids) != len(awards) or set(payload.award_ids) != set(awards):
        raise HTTPException(status_code=422, detail="award_ids must list each of the session's awards once.")
    for position, award_id in enumerate(payload.award_ids):
        awards[award_id].position = position
    db.commit()
    _changed(request, db, session_id)
    return _session_read(db, _plugin(request, db), session_obj)


@router.post("/api/sessions/{session_id}/awards/copy", response_model=SessionAwardsRead)
def copy_awards(
    session_id: int,
    payload: AwardCopyBody,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionAwardsRead:
    session_obj = _session_or_404(db, session_id)
    _ensure_open(session_obj)
    if payload.from_session_id == session_id:
        raise HTTPException(status_code=422, detail="Choose a different session to copy from.")
    _session_or_404(db, payload.from_session_id)
    start = len(rules.session_awards(db, session_id))
    for offset, source in enumerate(rules.session_awards(db, payload.from_session_id)):
        db.add(
            Award(
                session_id=session_id,
                position=start + offset,
                **{name: getattr(source, name) for name in DEFINITION_FIELDS},
            )
        )
    db.commit()
    _changed(request, db, session_id)
    return _session_read(db, _plugin(request, db), session_obj)
