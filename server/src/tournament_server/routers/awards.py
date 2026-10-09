"""Awards: definitions, winners, finalize, team history and the CSV export."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role, require_role
from tournament_server.deps import get_db, get_event_or_404, get_optional_game_plugin
from tournament_server.models.award import Award, AwardWinner
from tournament_server.models.division import Division
from tournament_server.models.participation import SessionParticipation
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
    TeamAwardEntryRead,
    TeamAwardHistoryRead,
    WinnerBody,
    WinnerTeamRead,
)
from tournament_server.services import awards as rules
from tournament_server.services.skills_ranking import session_order_key

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


REASON_MAX = 500
require_admin_or_judge = require_role("judge")


def _slot_or_404(db: Session, award: Award, slot: str) -> int | None:
    slots = rules.slot_division_ids(db, award)
    if slot == "event":
        division_id = None
    else:
        try:
            division_id = int(slot)
        except ValueError:
            raise HTTPException(status_code=404, detail="Slot not found")
    if division_id not in slots:
        raise HTTPException(status_code=404, detail="Slot not found")
    return division_id


def _winner_error(db: Session, session_id: int, division_id: int | None, team_id: int) -> str | None:
    team = db.get(Team, team_id)
    if team is None:
        return f"Team {team_id} not found."
    if division_id is not None and team.division_id != division_id:
        return f"Team {team.number} is not in this division."
    entered = db.execute(
        select(SessionParticipation.id).where(
            SessionParticipation.session_id == session_id, SessionParticipation.team_id == team_id
        )
    ).first()
    if entered is None:
        return f"Team {team.number} is not entered in this session."
    return None


def _guarded_slot(db: Session, award_id: int, slot: str, role: str) -> tuple[Award, int | None]:
    """404 award, 404 slot, 403 a non-admin on a performance award, 409 finalized."""
    award = _award_or_404(db, award_id)
    division_id = _slot_or_404(db, award, slot)
    if award.kind == rules.PERFORMANCE and role != "admin":
        raise HTTPException(status_code=403, detail="Only an admin can override a performance award.")
    _ensure_open(_session_or_404(db, award.session_id))
    return award, division_id


@router.put("/api/awards/{award_id}/slots/{slot}", response_model=AwardRead)
def set_slot(
    award_id: int,
    slot: str,
    payload: WinnerBody,
    request: Request,
    db: Session = Depends(get_db),
    role: str = Depends(require_admin_or_judge),
) -> AwardRead:
    award, division_id = _guarded_slot(db, award_id, slot, role)
    if award.kind == rules.JUDGED:
        if payload.team_id is None or payload.team_ids is not None or payload.reason is not None:
            raise HTTPException(status_code=422, detail="A judged award takes exactly one team_id.")
        team_ids, origin, reason = [payload.team_id], rules.ORIGIN_JUDGED, None
    else:
        reason = (payload.reason or "").strip()
        if payload.team_id is not None or not payload.team_ids:
            raise HTTPException(status_code=422, detail="An override takes a non-empty team_ids list.")
        if len(set(payload.team_ids)) != len(payload.team_ids):
            raise HTTPException(status_code=422, detail="A team is listed twice.")
        if not reason or len(reason) > REASON_MAX:
            raise HTTPException(status_code=422, detail=f"An override needs a reason of 1 to {REASON_MAX} characters.")
        team_ids, origin = payload.team_ids, rules.ORIGIN_OVERRIDE
    for team_id in team_ids:
        error = _winner_error(db, award.session_id, division_id, team_id)
        if error is not None:
            raise HTTPException(status_code=422, detail=error)
    for row in rules.stored_winners(db, award.id, division_id):
        db.delete(row)
    db.flush()
    for team_id in team_ids:
        db.add(
            AwardWinner(
                award_id=award.id, division_id=division_id, team_id=team_id,
                origin=origin, override_reason=reason, recorded_by=role,
            )
        )
    db.commit()
    _changed(request, db, award.session_id)
    return _award_read(db, _plugin(request, db), award)


@router.delete("/api/awards/{award_id}/slots/{slot}", response_model=AwardRead)
def clear_slot(
    award_id: int,
    slot: str,
    request: Request,
    db: Session = Depends(get_db),
    role: str = Depends(require_admin_or_judge),
) -> AwardRead:
    award, division_id = _guarded_slot(db, award_id, slot, role)
    for row in rules.stored_winners(db, award.id, division_id):
        db.delete(row)
    db.commit()
    _changed(request, db, award.session_id)
    return _award_read(db, _plugin(request, db), award)


@router.get("/api/sessions/{session_id}/awards/team-history", response_model=list[TeamAwardHistoryRead])
def team_history(
    session_id: int, request: Request, db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[TeamAwardHistoryRead]:
    """Each team's awards in this session (stored and live) and in earlier
    sessions of the season (stored only)."""
    current = _session_or_404(db, session_id)
    current_key = session_order_key(current.session_date, current.id)
    sessions = [
        s for s in db.execute(
            select(TournamentSession).where(TournamentSession.event_id == current.event_id)
        ).scalars().all()
        if session_order_key(s.session_date, s.id) <= current_key
    ]
    sessions.sort(key=lambda s: session_order_key(s.session_date, s.id))
    plugin = _plugin(request, db)
    by_team: dict[int, list[TeamAwardEntryRead]] = {}
    for session_obj in sessions:
        for award in rules.session_awards(db, session_obj.id):
            for division_id in rules.slot_division_ids(db, award):
                if session_obj.id == session_id:
                    team_ids = rules.slot_state(db, plugin, award, division_id).team_ids
                else:
                    team_ids = [row.team_id for row in rules.stored_winners(db, award.id, division_id)]
                for team_id in team_ids:
                    by_team.setdefault(team_id, []).append(
                        TeamAwardEntryRead(
                            award_id=award.id, award_name=award.name, kind=award.kind,
                            session_id=session_obj.id, session_label=session_obj.label,
                        )
                    )
    return [TeamAwardHistoryRead(team_id=team_id, awards=by_team[team_id]) for team_id in sorted(by_team)]
