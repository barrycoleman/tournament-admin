from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.ranking import Ranking
from tournament_server.models.schedule_generation import ScheduleGeneration
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.schedule import (
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
)
from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings
from tournament_server.services.scheduling import build_pairing_history

router = APIRouter(prefix="/api/schedule", tags=["schedule"])


def _validate_generated_schedule(
    generated: list, valid_field_set_ids: set[int], alliance_count: int
) -> None:
    if not isinstance(generated, list) or not generated:
        raise HTTPException(
            status_code=422, detail="Scheduler plugin returned no matches"
        )

    teams_by_slot: dict[int, set[int]] = {}
    for entry in generated:
        if not isinstance(entry, dict):
            raise HTTPException(
                status_code=422, detail="Scheduler plugin returned a malformed match"
            )
        missing = {"time_slot", "field_set_id", "alliances"} - entry.keys()
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"Scheduler plugin returned a match missing keys: {sorted(missing)}",
            )
        if entry["field_set_id"] not in valid_field_set_ids:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Scheduler plugin returned an unknown field_set_id "
                    f"{entry['field_set_id']!r}"
                ),
            )
        alliances = entry["alliances"]
        if not isinstance(alliances, list) or len(alliances) != alliance_count:
            raise HTTPException(
                status_code=422,
                detail=f"Each match must have exactly {alliance_count} alliances",
            )
        stations = set()
        slot_teams = teams_by_slot.setdefault(entry["time_slot"], set())
        for alliance in alliances:
            if "station" not in alliance or "team_ids" not in alliance:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned an alliance missing 'station' or 'team_ids'",
                )
            station = alliance["station"]
            if not isinstance(station, str) or not station:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned a non-string or empty station name",
                )
            if not alliance["team_ids"]:
                raise HTTPException(
                    status_code=422,
                    detail="Scheduler plugin returned an alliance with no teams",
                )
            stations.add(station)
            for team_id in alliance["team_ids"]:
                if team_id in slot_teams:
                    raise HTTPException(
                        status_code=422,
                        detail=(
                            f"Scheduler plugin double-booked team {team_id} in "
                            f"time_slot {entry['time_slot']}"
                        ),
                    )
                slot_teams.add(team_id)
        if len(stations) != len(alliances):
            raise HTTPException(
                status_code=422,
                detail="Alliance stations must be distinct within a match",
            )


@router.post("", response_model=ScheduleGenerateResponse, status_code=201)
def generate_schedule(
    payload: ScheduleGenerateRequest, request: Request, db: Session = Depends(get_db)
) -> ScheduleGenerateResponse:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if event.game_plugin_name is None:
        raise HTTPException(
            status_code=422, detail="No game plugin has been selected for this event"
        )
    game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
    if game_plugin is None:
        raise HTTPException(
            status_code=500,
            detail=(
                f"Event's selected game plugin {event.game_plugin_name!r} is not "
                "currently loaded"
            ),
        )

    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    scheduler_plugin = request.app.state.scheduler_plugins.get(
        payload.scheduler_plugin_name
    )
    if scheduler_plugin is None:
        raise HTTPException(
            status_code=404,
            detail=f"Scheduler plugin {payload.scheduler_plugin_name!r} is not installed",
        )

    existing_query = select(Match).where(
        Match.session_id == payload.session_id, Match.round_type == payload.round_type
    )
    if payload.division_id is None:
        existing_query = existing_query.where(Match.division_id.is_(None))
    else:
        existing_query = existing_query.where(Match.division_id == payload.division_id)
    if db.execute(existing_query).scalars().first() is not None:
        raise HTTPException(
            status_code=409,
            detail=(
                "Matches already exist for this session/division/round_type; "
                "clear them with DELETE /api/schedule before regenerating"
            ),
        )

    participation_query = select(SessionParticipation).where(
        SessionParticipation.session_id == payload.session_id,
        SessionParticipation.checked_in.is_(True),
    )
    team_ids_in_session = [
        row.team_id for row in db.execute(participation_query).scalars().all()
    ]
    team_query = select(Team).where(Team.id.in_(team_ids_in_session))
    if payload.division_id is None:
        team_query = team_query.where(Team.division_id.is_(None))
    else:
        team_query = team_query.where(Team.division_id == payload.division_id)
    teams = db.execute(team_query).scalars().all()

    field_sets = db.execute(
        select(FieldSet).where(FieldSet.session_id == payload.session_id)
    ).scalars().all()
    if not field_sets:
        raise HTTPException(status_code=422, detail="Session has no FieldSets configured")
    fields = db.execute(
        select(Field).where(Field.field_set_id.in_([fs.id for fs in field_sets]))
    ).scalars().all()
    if not fields:
        raise HTTPException(status_code=422, detail="Session has no Fields configured")

    match_format = game_plugin.module.match_format()
    if payload.round_type not in match_format["round_types"]:
        raise HTTPException(
            status_code=422,
            detail=(
                f"{payload.round_type!r} is not a valid round_type for this "
                "event's game plugin"
            ),
        )
    teams_per_alliance = match_format["teams_per_alliance"]
    alliance_count = match_format["alliance_count"]

    pairing_history = build_pairing_history(db, event.id)

    try:
        generated = scheduler_plugin.module.generate_schedule(
            teams=[{"team_id": t.id, "organization": t.organization} for t in teams],
            target_matches_per_team=payload.target_matches_per_team,
            teams_per_alliance=teams_per_alliance,
            alliance_count=alliance_count,
            fields=[{"field_id": f.id, "field_set_id": f.field_set_id} for f in fields],
            field_sets=[{"field_set_id": fs.id, "name": fs.name} for fs in field_sets],
            cross_session_pairing_history=pairing_history,
            constraints={"excluded_team_ids": payload.excluded_team_ids},
        )
    except Exception as exc:
        raise HTTPException(
            status_code=422,
            detail=f"Scheduler plugin could not generate a schedule: {exc}",
        )

    _validate_generated_schedule(generated, {fs.id for fs in field_sets}, alliance_count)

    generation = ScheduleGeneration(
        session_id=payload.session_id,
        division_id=payload.division_id,
        round_type=payload.round_type,
        scheduler_plugin_name=scheduler_plugin.name,
        scheduler_plugin_version=scheduler_plugin.version,
        target_matches_per_team=payload.target_matches_per_team,
        generated_at=utc_now(),
    )
    db.add(generation)
    db.flush()

    fields_by_set: dict[int, list[int]] = {}
    for f in fields:
        fields_by_set.setdefault(f.field_set_id, []).append(f.id)
    for field_ids in fields_by_set.values():
        field_ids.sort()
    next_field_index: dict[int, int] = {fs_id: 0 for fs_id in fields_by_set}

    created_matches = []
    for match_number, entry in enumerate(generated, start=1):
        field_set_id = entry["field_set_id"]
        field_ids_for_set = fields_by_set[field_set_id]
        field_id = field_ids_for_set[next_field_index[field_set_id] % len(field_ids_for_set)]
        next_field_index[field_set_id] += 1

        match = Match(
            session_id=payload.session_id,
            division_id=payload.division_id,
            round_type=payload.round_type,
            match_number=match_number,
            field_id=field_id,
            time_slot=entry["time_slot"],
            schedule_generation_id=generation.id,
        )
        db.add(match)
        db.flush()
        for alliance_entry in entry["alliances"]:
            alliance = Alliance(match_id=match.id, station=alliance_entry["station"])
            db.add(alliance)
            db.flush()
            for team_id in alliance_entry["team_ids"]:
                db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))
        created_matches.append(match)

    db.commit()

    return ScheduleGenerateResponse(
        schedule_generation_id=generation.id, match_count=len(created_matches)
    )


@router.delete("")
def clear_schedule(
    request: Request,
    session_id: int = Query(...),
    division_id: int | None = Query(None),
    round_type: str = Query(...),
    db: Session = Depends(get_db),
) -> dict[str, int]:
    if db.get(TournamentSession, session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")

    # Delete stale rankings first. This is correct even when matches from
    # other, untouched round_types remain: the recompute step below rebuilds
    # them from whatever completed matches survive, or leaves them empty if
    # nothing does.
    ranking_query = select(Ranking).where(Ranking.session_id == session_id)
    if division_id is None:
        ranking_query = ranking_query.where(Ranking.division_id.is_(None))
    else:
        ranking_query = ranking_query.where(Ranking.division_id == division_id)
    for ranking in db.execute(ranking_query).scalars().all():
        db.delete(ranking)
    db.flush()

    # Then delete matches and their cascading objects
    match_query = select(Match).where(
        Match.session_id == session_id, Match.round_type == round_type
    )
    if division_id is None:
        match_query = match_query.where(Match.division_id.is_(None))
    else:
        match_query = match_query.where(Match.division_id == division_id)
    matches = db.execute(match_query).scalars().all()

    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        for alliance in alliances:
            for record in db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
            ).scalars().all():
                db.delete(record)
            for alliance_team in db.execute(
                select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
            ).scalars().all():
                db.delete(alliance_team)
            db.flush()
            db.delete(alliance)
        db.delete(match)

    db.commit()

    # Best-effort: rebuild rankings from whatever completed matches remain
    # for this (session_id, division_id) — e.g. other round_types that this
    # call never touched. If the event or its game plugin isn't available,
    # skip silently rather than turning a successful deletion into a 500;
    # the rankings for this division were already cleared above.
    event = get_the_event(db)
    if event is not None and event.game_plugin_name is not None:
        game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
        if game_plugin is not None:
            recompute_rankings(db, game_plugin, session_id, division_id)
            recompute_event_rankings(db, game_plugin, event.id, division_id)

    return {"matches_deleted": len(matches)}
