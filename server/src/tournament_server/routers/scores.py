from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit
from tournament_server.auth import require_any_role, require_scorer_or_referee
from tournament_server.deps import (
    get_db,
    get_game_plugin_for_event,
    get_optional_game_plugin,
    get_session_id,
    get_the_event,
)
from tournament_server.device_auth import require_paired_scoring_device
from tournament_server.models.alliance import Alliance
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.schemas.score_record import AllianceScoreRead, ScoreRecordRead, ScoreSubmit, TeamFlags
from tournament_server.services import drafts, live_scores, team_flags
from tournament_server.services.score_submission import (
    SCORE_ALREADY_SUBMITTED_DETAIL,  # noqa: F401  (re-exported for callers of this module)
    ScoreRefused,
    after_scores_written,
    write_alliance_score,
)

router = APIRouter(prefix="/api/matches", tags=["scores"])

# Saved scores by session, for the display screens (display groups design).
list_router = APIRouter(prefix="/api/scores", tags=["scores"])

@list_router.get("", response_model=list[AllianceScoreRead])
def list_scores(
    request: Request,
    session_id: int = Depends(get_session_id),
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> list[AllianceScoreRead]:
    event = get_the_event(db)
    plugin = get_optional_game_plugin(request, event) if event is not None else None
    if plugin is None:
        return []
    rows = db.execute(
        select(ScoreRecord, Alliance, Match)
        .join(Alliance, ScoreRecord.alliance_id == Alliance.id)
        .join(Match, Alliance.match_id == Match.id)
        .where(Match.session_id == session_id)
        .order_by(Match.id, Alliance.id)
    ).all()
    result = []
    for record, alliance, match in rows:
        team_ids = team_flags.alliance_team_ids(db, alliance.id)
        result.append(
            AllianceScoreRead(
                match_id=match.id,
                alliance_id=alliance.id,
                score=team_flags.effective_score(plugin, record, team_ids, finals=match.finals_bracket_id is not None),
                data=json.loads(record.data_json),
                teams=[TeamFlags(team_id=t.team_id, no_show=t.no_show, dq=t.dq) for t in record.teams],
                saved_at=record.saved_at,
            )
        )
    return result


def _to_score_record_read(record: ScoreRecord, computed_score: int) -> ScoreRecordRead:
    return ScoreRecordRead(
        id=record.id,
        alliance_id=record.alliance_id,
        plugin_name=record.plugin_name,
        plugin_version=record.plugin_version,
        data=json.loads(record.data_json),
        teams=[TeamFlags(team_id=flag.team_id, no_show=flag.no_show, dq=flag.dq) for flag in record.teams],
        sitting=record.sitting,
        submitted_by_device=record.submitted_by_device,
        submitted_at=record.submitted_at,
        saved_at=record.saved_at,
        computed_score=computed_score,
    )


@router.post("/{match_id}/alliances/{alliance_id}/score", response_model=ScoreRecordRead)
def submit_score(
    match_id: int,
    alliance_id: int,
    payload: ScoreSubmit,
    request: Request,
    db: Session = Depends(get_db),
    role: str = Depends(require_scorer_or_referee),
    device_friendly_name: str | None = Depends(require_paired_scoring_device),
) -> ScoreRecordRead:
    """The direct score write, and the admin's correction path once a match
    is submitted (services/score_submission holds every rule)."""
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    alliance = db.get(Alliance, alliance_id)
    if alliance is None or alliance.match_id != match_id:
        raise HTTPException(status_code=404, detail="Alliance not found on this match")
    plugin = get_game_plugin_for_event(request, db)
    submitted_by = (
        device_friendly_name if device_friendly_name is not None else audit.current_actor.get()
    )
    try:
        # Serialised with draft patches, so a patch sees this score or none.
        with drafts.DRAFT_WRITE_LOCK:
            record, computed_score, _mirrored = write_alliance_score(
                db,
                plugin,
                match,
                alliance,
                data=payload.data,
                teams=payload.teams,
                sitting=payload.sitting,
                force=payload.force,
                submitted_by=submitted_by,
                is_admin=role == "admin",
            )
    except ScoreRefused as refused:
        raise HTTPException(status_code=refused.status_code, detail=refused.detail) from refused
    after_scores_written(request.app, db, plugin, match, [alliance_id])
    db.refresh(match)
    if match.status == "completed":
        # No stale draft or live total may outlive an official score.
        with drafts.DRAFT_WRITE_LOCK:
            drafts.delete_match_drafts(db, [match.id])
            db.commit()
        live_scores.on_match_phase_changed(request.app, db, match)
    return _to_score_record_read(record, computed_score)
