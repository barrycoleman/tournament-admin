from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_game_plugin_for_event, get_the_event
from tournament_server.models.alliance import Alliance
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.schemas.score_record import ScoreRecordRead, ScoreSubmit
from tournament_server.services.finals import advance_score_chase
from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings

router = APIRouter(prefix="/api/matches", tags=["scores"])


def _to_score_record_read(record: ScoreRecord, computed_score: int) -> ScoreRecordRead:
    return ScoreRecordRead(
        id=record.id,
        alliance_id=record.alliance_id,
        plugin_name=record.plugin_name,
        plugin_version=record.plugin_version,
        data=json.loads(record.data_json),
        no_show=record.no_show,
        dq=record.dq,
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
) -> ScoreRecordRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    alliance = db.get(Alliance, alliance_id)
    if alliance is None or alliance.match_id != match_id:
        raise HTTPException(status_code=404, detail="Alliance not found on this match")

    plugin = get_game_plugin_for_event(request, db)

    try:
        violations = plugin.module.validate(payload.data)
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Plugin could not validate this scoresheet: {exc}",
        )
    if violations and not payload.force:
        raise HTTPException(status_code=422, detail={"violations": violations})

    try:
        computed_score = (
            0
            if (payload.no_show or payload.dq)
            else plugin.module.calculate_score(payload.data)
        )
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Plugin could not score this scoresheet: {exc}",
        )

    now = utc_now()
    existing = db.execute(
        select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)
    ).scalars().first()

    if existing is None:
        record = ScoreRecord(
            alliance_id=alliance_id,
            plugin_name=plugin.name,
            plugin_version=plugin.version,
            data_json=json.dumps(payload.data),
            no_show=payload.no_show,
            dq=payload.dq,
            sitting=payload.sitting,
            submitted_by_device=audit.current_actor.get(),
            submitted_at=now,
            saved_at=now,
        )
        db.add(record)
    else:
        existing.data_json = json.dumps(payload.data)
        existing.no_show = payload.no_show
        existing.dq = payload.dq
        existing.sitting = payload.sitting
        existing.submitted_by_device = audit.current_actor.get()
        existing.submitted_at = now
        existing.saved_at = now
        record = existing

    db.commit()
    db.refresh(record)

    game_model = plugin.module.match_format()["game_model"]
    all_alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match_id)
    ).scalars().all()

    if game_model == "cooperative_score" and not (payload.no_show or payload.dq):
        for other_alliance in all_alliances:
            if other_alliance.id == alliance_id:
                continue
            other_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == other_alliance.id)
            ).scalars().first()
            if other_record is None:
                other_record = ScoreRecord(
                    alliance_id=other_alliance.id,
                    plugin_name=plugin.name,
                    plugin_version=plugin.version,
                    data_json=record.data_json,
                    no_show=False,
                    dq=False,
                    sitting=False,
                    submitted_by_device=audit.current_actor.get(),
                    submitted_at=now,
                    saved_at=now,
                )
                db.add(other_record)
            else:
                other_record.data_json = record.data_json
                other_record.plugin_name = plugin.name
                other_record.plugin_version = plugin.version
        db.commit()
    scored_alliance_ids = {
        row.alliance_id
        for row in db.execute(
            select(ScoreRecord).where(
                ScoreRecord.alliance_id.in_([a.id for a in all_alliances])
            )
        ).scalars().all()
    }
    if len(scored_alliance_ids) == len(all_alliances):
        match.status = "completed"
        db.commit()

    if match.finals_bracket_id is not None:
        bracket = db.get(FinalsBracket, match.finals_bracket_id)
        if bracket is not None and bracket.format == "score_chase" and match.status == "completed":
            advance_score_chase(db, bracket, plugin)
        return _to_score_record_read(record, computed_score)

    recompute_rankings(db, plugin, match.session_id, match.division_id)
    event = get_the_event(db)
    if event is not None:
        recompute_event_rankings(db, plugin, event.id, match.division_id)

    return _to_score_record_read(record, computed_score)
