from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin
from tournament_server.deps import get_db, get_game_plugin_for_event, get_the_event
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.session import TournamentSession
from tournament_server.realtime import broadcast_for_session
from tournament_server.routers.sessions import _to_read
from tournament_server.schemas.qualification import FinalizeRequest, QualificationPreviewRead
from tournament_server.schemas.session import SessionRead
from tournament_server.services import qualification
from tournament_server.services.deletion import session_has_scores
from tournament_server.services.ranking import recompute_all_rankings
from tournament_server.services.ranking_rules import suggest_finalize_drops
from tournament_server.services.ranking_settings import load_rules

router = APIRouter(prefix="/api/sessions/{session_id}/qualification", tags=["qualification"])


def _session_or_404(db: Session, session_id: int) -> TournamentSession:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session_obj


def _is_cooperative(plugin) -> bool:
    return plugin.module.match_format()["game_model"] == "cooperative_score"


def _after_change(request: Request, db: Session, session_obj: TournamentSession, plugin) -> SessionRead:
    event = get_the_event(db)
    recompute_all_rankings(request.app, db, plugin, event.id)
    db.commit()
    finalized = qualification.is_finalized(session_obj)
    broadcast_for_session(
        request.app, db, session_obj.id, "qualification_status_changed",
        {"session_id": session_obj.id, "finalized": finalized},
    )
    db.refresh(session_obj)
    return _to_read(session_obj, session_has_scores(db, session_obj.id))


@router.get("/finalize-preview", response_model=QualificationPreviewRead)
def finalize_preview(
    session_id: int, request: Request, db: Session = Depends(get_db), _role: str = Depends(require_admin)
) -> QualificationPreviewRead:
    session_obj = _session_or_404(db, session_id)
    plugin = get_game_plugin_for_event(request, db)
    rules = load_rules(db)
    state = qualification.finalize_state(db, session_id)
    finalized = qualification.is_finalized(session_obj)
    return QualificationPreviewRead(
        finalized=finalized,
        game_model=plugin.module.match_format()["game_model"],
        rows=qualification.preview_rows(
            state, _is_cooperative(plugin), lambda played: suggest_finalize_drops(played, rules)
        ),
        unplayed_matches=0 if finalized else len(state.unplayed),
        blockers=[] if finalized else state.blockers,
    )


@router.post("/finalize", response_model=SessionRead)
def finalize(
    session_id: int,
    payload: FinalizeRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> SessionRead:
    session_obj = _session_or_404(db, session_id)
    plugin = get_game_plugin_for_event(request, db)
    if qualification.is_finalized(session_obj):
        raise HTTPException(status_code=409, detail="Qualification is already finalized for this session")
    state = qualification.finalize_state(db, session_id)
    if state.blockers:
        raise HTTPException(status_code=409, detail=qualification.blocker_detail(state.blockers))
    expected = {str(p) for p in state.played.values()} if _is_cooperative(plugin) else set()
    if set(payload.drops) != expected:
        raise HTTPException(
            status_code=422,
            detail=f"Drops must be given for exactly these played counts: {sorted(expected, key=int)}",
        )
    for played, drops in payload.drops.items():
        if not 0 <= drops <= int(played) - 1:
            raise HTTPException(
                status_code=422,
                detail=f"Teams that played {played} can drop between 0 and {int(played) - 1} matches",
            )
    qualification.finalize(db, session_obj, state, payload.drops)
    return _after_change(request, db, session_obj, plugin)


@router.post("/reopen", response_model=SessionRead)
def reopen(
    session_id: int, request: Request, db: Session = Depends(get_db), _role: str = Depends(require_admin)
) -> SessionRead:
    session_obj = _session_or_404(db, session_id)
    plugin = get_game_plugin_for_event(request, db)
    if not qualification.is_finalized(session_obj):
        raise HTTPException(status_code=409, detail="Qualification is not finalized for this session")
    has_finals = db.execute(
        select(FinalsBracket.id).where(FinalsBracket.session_id == session_id)
    ).first()
    if has_finals is not None:
        raise HTTPException(status_code=409, detail=qualification.FINALS_EXIST_DETAIL)
    qualification.reopen(db, session_obj)
    return _after_change(request, db, session_obj, plugin)
