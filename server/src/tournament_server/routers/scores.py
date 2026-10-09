from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server import audit
from tournament_server.auth import require_scorer_or_referee
from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_game_plugin_for_event, get_the_event
from tournament_server.device_auth import require_admitted_device
from tournament_server.models.alliance import Alliance
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.score_record_team import ScoreRecordTeam
from tournament_server.realtime import broadcast_for_session, broadcast_new_finals_matches
from tournament_server.schemas.score_record import ScoreRecordRead, ScoreSubmit, TeamFlags
from tournament_server.services import qualification, team_flags
from tournament_server.services.finals import advance_score_chase, advance_single_elimination
from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings

router = APIRouter(prefix="/api/matches", tags=["scores"])

SCORE_ALREADY_SUBMITTED_DETAIL = "This score has already been submitted; ask an admin to correct it."


def _validated_flags(entries: list[TeamFlags], alliance_team_ids: list[int]) -> list[TeamFlags]:
    """The flagged entries, ordered by team; 422 for a team not on the
    alliance or listed twice."""
    seen: set[int] = set()
    for entry in entries:
        if entry.team_id not in alliance_team_ids:
            raise HTTPException(status_code=422, detail=f"Team {entry.team_id} is not on this alliance.")
        if entry.team_id in seen:
            raise HTTPException(status_code=422, detail=f"Team {entry.team_id} is listed more than once.")
        seen.add(entry.team_id)
    return sorted((entry for entry in entries if entry.no_show or entry.dq), key=lambda entry: entry.team_id)


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


def _overwrites_a_submitted_partner(
    db: Session, match_id: int, alliance_id: int, data: dict
) -> bool:
    """True when another alliance on the match has a submitted (not mirrored)
    record whose data differs from `data`. A partner whose teams are all
    flagged is skipped: its data never counts toward a score."""
    partner_records = db.execute(
        select(ScoreRecord)
        .join(Alliance, Alliance.id == ScoreRecord.alliance_id)
        .where(Alliance.match_id == match_id, Alliance.id != alliance_id)
    ).scalars().all()
    return any(
        not record.mirrored
        and not team_flags.alliance_out(
            record.teams, team_flags.alliance_team_ids(db, record.alliance_id), finals=False
        )
        and json.loads(record.data_json) != data
        for record in partner_records
    )


@router.post("/{match_id}/alliances/{alliance_id}/score", response_model=ScoreRecordRead)
def submit_score(
    match_id: int,
    alliance_id: int,
    payload: ScoreSubmit,
    request: Request,
    db: Session = Depends(get_db),
    role: str = Depends(require_scorer_or_referee),
    device_friendly_name: str | None = Depends(require_admitted_device),
) -> ScoreRecordRead:
    match = db.get(Match, match_id)
    if match is None:
        raise HTTPException(status_code=404, detail="Match not found")
    alliance = db.get(Alliance, alliance_id)
    if alliance is None or alliance.match_id != match_id:
        raise HTTPException(status_code=404, detail="Alliance not found on this match")
    if match.status == qualification.NOT_PLAYED:
        raise HTTPException(status_code=409, detail=qualification.NOT_PLAYED_SCORE_DETAIL)
    existing = db.execute(
        select(ScoreRecord).where(ScoreRecord.alliance_id == alliance_id)
    ).scalars().first()
    # Once submitted, only an admin may correct it (skills spec 3.6). A copy
    # the cooperative mirror wrote was never submitted for this alliance, so
    # a scorer may still submit it once. Drafts, which scorers may overwrite,
    # belong to the later live-scoring spec.
    if existing is not None and not existing.mirrored and role != "admin":
        raise HTTPException(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)

    alliance_team_ids = team_flags.alliance_team_ids(db, alliance_id)
    flags = _validated_flags(payload.teams, alliance_team_ids)
    finals = match.finals_bracket_id is not None

    submitted_by = (
        device_friendly_name if device_friendly_name is not None else audit.current_actor.get()
    )

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
            if team_flags.alliance_out(flags, alliance_team_ids, finals=finals)
            else plugin.module.calculate_score(payload.data)
        )
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Plugin could not score this scoresheet: {exc}",
        )

    game_model = plugin.module.match_format()["game_model"]
    mirrors = game_model == "cooperative_score" and not team_flags.alliance_out(
        flags, alliance_team_ids, finals=False
    )
    if mirrors and role != "admin" and _overwrites_a_submitted_partner(db, match_id, alliance_id, payload.data):
        # Mirroring would change the partner's submitted score, which only an
        # admin may do; refuse before writing anything.
        raise HTTPException(status_code=409, detail=SCORE_ALREADY_SUBMITTED_DETAIL)

    now = utc_now()

    if existing is None:
        record = ScoreRecord(
            alliance_id=alliance_id,
            plugin_name=plugin.name,
            plugin_version=plugin.version,
            data_json=json.dumps(payload.data),
            sitting=payload.sitting,
            mirrored=False,
            submitted_by_device=submitted_by,
            submitted_at=now,
            saved_at=now,
        )
        record.teams = [ScoreRecordTeam(team_id=f.team_id, no_show=f.no_show, dq=f.dq) for f in flags]
        db.add(record)
    else:
        existing.data_json = json.dumps(payload.data)
        # Clear and flush before adding, so re-flagging the same team never
        # meets its old row in the unique constraint.
        existing.teams.clear()
        db.flush()
        existing.teams.extend(
            ScoreRecordTeam(team_id=f.team_id, no_show=f.no_show, dq=f.dq) for f in flags
        )
        existing.sitting = payload.sitting
        existing.mirrored = False
        existing.submitted_by_device = submitted_by
        existing.submitted_at = now
        existing.saved_at = now
        record = existing

    db.commit()
    db.refresh(record)

    broadcast_for_session(
        request.app, db, match.session_id, "score_saved",
        {"match_id": match_id, "alliance_id": alliance_id},
    )

    all_alliances = db.execute(
        select(Alliance).where(Alliance.match_id == match_id)
    ).scalars().all()

    if mirrors:
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
                    sitting=False,
                    mirrored=True,
                    submitted_by_device=submitted_by,
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
        if bracket is not None and match.status == "completed":
            existing_ids = {
                m.id for m in db.execute(
                    select(Match).where(Match.finals_bracket_id == bracket.id)
                ).scalars().all()
            }
            if bracket.format == "score_chase":
                advance_score_chase(db, bracket, plugin)
            elif bracket.format == "single_elimination":
                advance_single_elimination(db, bracket, plugin, match)
            broadcast_new_finals_matches(request.app, db, bracket.id, existing_ids)
        return _to_score_record_read(record, computed_score)

    recompute_rankings(request.app, db, plugin, match.session_id, match.division_id)
    event = get_the_event(db)
    if event is not None:
        recompute_event_rankings(request.app, db, plugin, event.id, match.division_id)

    return _to_score_record_read(record, computed_score)
