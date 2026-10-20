"""Teamwork draft scores (live scoring spec §5.1)."""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit, realtime
from tournament_server.auth import require_scorer_or_referee
from tournament_server.deps import get_db, get_game_plugin_for_event
from tournament_server.device_auth import require_paired_scoring_device
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.schemas.draft import AllianceDraftRead, DraftPatch, MatchDraftRead, SubmitRequest
from tournament_server.services import drafts, live_scores
from tournament_server.services.score_submission import ScoreRefused, after_scores_written

router = APIRouter(prefix="/api/matches", tags=["drafts"])

# item_meta's device name for an admin, who scores without a paired device.
ADMIN_DEVICE_NAME = "Admin"


def _match_or_404(db: Session, match_id: int) -> Match:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    return match


def _alliance_or_404(db: Session, match: Match, alliance_id: int) -> Alliance:
    alliance = db.get(Alliance, alliance_id)
    if alliance is None or alliance.match_id != match.id:
        raise HTTPException(status_code=404, detail="Alliance not found on this match")
    return alliance


@router.get("/{match_id}/draft", response_model=MatchDraftRead)
def read_draft(
    match_id: int,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
) -> MatchDraftRead:
    match = _match_or_404(db, match_id)
    plugin = get_game_plugin_for_event(request, db)
    return drafts.read_match_draft(db, plugin, match)


@router.patch("/{match_id}/alliances/{alliance_id}/draft", response_model=AllianceDraftRead)
def patch_draft(
    match_id: int,
    alliance_id: int,
    payload: DraftPatch,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_scorer_or_referee),
    device_name: str | None = Depends(require_paired_scoring_device),
) -> AllianceDraftRead:
    match = _match_or_404(db, match_id)
    alliance = _alliance_or_404(db, match, alliance_id)
    plugin = get_game_plugin_for_event(request, db)
    try:
        # Read the answer under the same lock as the write, so it is this
        # patch's version and not a later concurrent patch's.
        with drafts.DRAFT_WRITE_LOCK:
            draft = drafts.apply_patch(db, plugin, match, alliance, payload, device_name or ADMIN_DEVICE_NAME)
            result = drafts.alliance_draft(db, plugin, match, alliance.id)
    except ScoreRefused as refused:
        raise HTTPException(status_code=refused.status_code, detail=refused.detail) from refused
    drafts.broadcast_draft_changed(
        request.app, db, plugin, match, drafts.alliances_showing(db, plugin, match, draft.alliance_id)
    )
    live_scores.on_draft_changed(request.app, db, match)
    return result


@router.post("/{match_id}/submit", response_model=MatchDraftRead)
def submit_drafts(
    match_id: int,
    payload: SubmitRequest,
    request: Request,
    db: Session = Depends(get_db),
    role: str = Depends(require_scorer_or_referee),
    device_name: str | None = Depends(require_paired_scoring_device),
) -> MatchDraftRead:
    """Makes the match's drafts its official scores (live scoring spec §5.1)."""
    plugin = get_game_plugin_for_event(request, db)
    submitted_by = device_name if device_name is not None else audit.current_actor.get()
    with drafts.DRAFT_WRITE_LOCK:
        match = (
            db.execute(
                select(Match)
                .where(Match.id == match_id)
                .with_for_update()
                .execution_options(populate_existing=True)
            )
            .scalars()
            .first()
        )
        if match is None:
            raise HTTPException(status_code=404, detail="Match not found")
        try:
            alliance_ids = drafts.submit_match(
                db, plugin, match, force=payload.force, submitted_by=submitted_by, is_admin=role == "admin"
            )
        except ScoreRefused as refused:
            db.rollback()
            raise HTTPException(status_code=refused.status_code, detail=refused.detail) from refused
    after_scores_written(request.app, db, plugin, match, alliance_ids)
    db.refresh(match)
    realtime.broadcast_active_session(request.app, "match_submitted", {"match_id": match.id})
    live_scores.on_match_phase_changed(request.app, db, match)
    return drafts.read_match_draft(db, plugin, match)
