from __future__ import annotations

import datetime as dt

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin
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
from tournament_server.realtime import broadcast_for_session
from tournament_server.schemas.schedule import (
    PhaseResult,
    ResolvedTimeBlockRead,
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
    SchedulePhase,
)
from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings
from tournament_server.services.team_assignment import get_sole_division_id
from tournament_server.services.schedule_timing import (
    assign_scheduled_times,
    deserialize_time_blocks,
    implicit_default_time_block,
    resolve_block_cycle_times,
    serialize_time_blocks,
    validate_blocks_ordered_and_non_overlapping,
)
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


def _check_no_overlap_with_prior_generations(
    db: Session, session_id: int, division_id: int | None, new_blocks: list[dict]
) -> None:
    """Raises ValueError if any of new_blocks overlaps any block stored by
    an earlier, still-live ScheduleGeneration for the same
    (session_id, division_id) -- checked across every round_type, not just
    the one being generated now, since two round_types sharing the same
    physical fields must never double-book a time window."""
    query = select(ScheduleGeneration).where(ScheduleGeneration.session_id == session_id)
    if division_id is None:
        query = query.where(ScheduleGeneration.division_id.is_(None))
    else:
        query = query.where(ScheduleGeneration.division_id == division_id)
    for prior in db.execute(query).scalars().all():
        if prior.time_blocks_json is None:
            continue
        prior_blocks = deserialize_time_blocks(prior.time_blocks_json)
        for new_block in new_blocks:
            for prior_block in prior_blocks:
                if new_block["date"] != prior_block["date"]:
                    continue
                new_start, new_end = new_block["start_time"], new_block.get("end_time")
                prior_start, prior_end = prior_block["start_time"], prior_block.get("end_time")
                new_ends_before_prior = new_end is not None and new_end <= prior_start
                prior_ends_before_new = prior_end is not None and prior_end <= new_start
                if not (new_ends_before_prior or prior_ends_before_new):
                    raise ValueError(
                        "time_blocks overlap with an existing schedule: "
                        f"schedule_generation_id {prior.id}'s block starting at "
                        f"{prior_block['date']} {prior_start!r}"
                    )


def _fold_generated_into_pairing_history(
    pairing_history: dict[frozenset[int], dict[str, int]], generated: list[dict]
) -> None:
    """Mutates pairing_history in place to include the partner/opponent
    pairings from a phase's just-generated (not yet persisted) matches, in
    the same {frozenset({team_a, team_b}): {"partner_count", "opponent_count"}}
    shape build_pairing_history produces -- so a later phase in the same
    combined /api/schedule request sees the earlier phase's own results
    before its own scheduler-plugin call runs. This must stay purely
    in-memory (no DB read/write) since it also needs to hold for dry_run,
    which never persists anything for build_pairing_history to see on a
    subsequent call."""

    def bump(a: int, b: int, key: str) -> None:
        pair = frozenset((a, b))
        entry = pairing_history.setdefault(pair, {"partner_count": 0, "opponent_count": 0})
        entry[key] += 1

    for entry in generated:
        alliances = entry["alliances"]
        if len(alliances) != 2:
            # Matches build_pairing_history's own skip for anything other
            # than exactly two alliances (never expected once
            # _validate_generated_schedule has already run, but kept as
            # the same defensive no-op rather than assuming it can't happen).
            continue
        teams_by_alliance = [alliance["team_ids"] for alliance in alliances]
        for team_ids in teams_by_alliance:
            for i in range(len(team_ids)):
                for j in range(i + 1, len(team_ids)):
                    bump(team_ids[i], team_ids[j], "partner_count")
        for a in teams_by_alliance[0]:
            for b in teams_by_alliance[1]:
                bump(a, b, "opponent_count")


@router.post("", response_model=ScheduleGenerateResponse, status_code=201)
def generate_schedule(
    payload: ScheduleGenerateRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
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

    phases: list[SchedulePhase] = (
        payload.phases
        if payload.phases is not None
        else [
            SchedulePhase(
                round_type=payload.round_type,
                target_matches_per_team=payload.target_matches_per_team,
            )
        ]
    )

    # A request's own phases list must not repeat a round_type against
    # itself -- each round_type is meant to own exactly one
    # ScheduleGeneration+Match batch per (session, division), and the
    # DB-conflict check below can't catch this since none of these
    # round_types exist in the database yet within this request.
    phase_round_types = [phase.round_type for phase in phases]
    if len(set(phase_round_types)) != len(phase_round_types):
        raise HTTPException(
            status_code=422,
            detail="phases must not repeat the same round_type more than once",
        )

    # All-or-nothing: every phase's (session, division, round_type) must be
    # conflict-free before anything is generated for any phase.
    for phase in phases:
        existing_query = select(Match).where(
            Match.session_id == payload.session_id, Match.round_type == phase.round_type
        )
        if payload.division_id is None:
            existing_query = existing_query.where(Match.division_id.is_(None))
        else:
            existing_query = existing_query.where(Match.division_id == payload.division_id)
        if db.execute(existing_query).scalars().first() is not None:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Matches already exist for round_type {phase.round_type!r} in "
                    "this session/division; clear them with DELETE /api/schedule "
                    "before regenerating"
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
        sole_division_id = get_sole_division_id(db, event.id)
        if sole_division_id is not None:
            team_query = team_query.where(Team.division_id == sole_division_id)
        else:
            team_query = team_query.where(Team.division_id.is_(None))
    else:
        team_query = team_query.where(Team.division_id == payload.division_id)
    teams = db.execute(team_query).scalars().all()

    field_set_query = select(FieldSet).where(FieldSet.session_id == payload.session_id)
    if payload.division_id is None:
        field_set_query = field_set_query.where(FieldSet.division_id.is_(None))
    else:
        field_set_query = field_set_query.where(
            FieldSet.division_id == payload.division_id
        )
    field_sets = db.execute(field_set_query).scalars().all()
    if not field_sets:
        if payload.division_id is None:
            raise HTTPException(
                status_code=422,
                detail="Session has no unassigned FieldSets configured",
            )
        raise HTTPException(
            status_code=422,
            detail=f"No FieldSets are assigned to division_id {payload.division_id}",
        )
    fields = db.execute(
        select(Field).where(Field.field_set_id.in_([fs.id for fs in field_sets]))
    ).scalars().all()
    if not fields:
        raise HTTPException(status_code=422, detail="Session has no Fields configured")

    match_format = game_plugin.module.match_format()
    for phase in phases:
        if phase.round_type not in match_format["round_types"]:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{phase.round_type!r} is not a valid round_type for this "
                    "event's game plugin"
                ),
            )
    teams_per_alliance = match_format["teams_per_alliance"]
    alliance_count = match_format["alliance_count"]

    pairing_history = build_pairing_history(db, event.id)

    match_duration_seconds = (
        match_format["autonomous_seconds"] + match_format["driver_seconds"]
    )

    phase_generated: list[tuple[SchedulePhase, list]] = []
    for phase in phases:
        try:
            generated = scheduler_plugin.module.generate_schedule(
                teams=[{"team_id": t.id, "organization": t.organization} for t in teams],
                target_matches_per_team=phase.target_matches_per_team,
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
                detail=(
                    "Scheduler plugin could not generate a schedule for "
                    f"round_type {phase.round_type!r}: {exc}"
                ),
            )
        _validate_generated_schedule(generated, {fs.id for fs in field_sets}, alliance_count)
        _fold_generated_into_pairing_history(pairing_history, generated)
        phase_generated.append((phase, generated))

    total_time_slots_needed = sum(
        len({entry["time_slot"] for entry in generated}) for _, generated in phase_generated
    )

    session_obj = db.get(TournamentSession, payload.session_id)
    if payload.time_blocks is not None:
        if session_obj.timezone is None:
            raise HTTPException(
                status_code=422,
                detail="Session must have timezone set to use time_blocks",
            )
        time_blocks_input = [b.model_dump() for b in payload.time_blocks]
        timezone_name = session_obj.timezone
    else:
        implicit_start = utc_now() + dt.timedelta(minutes=5)
        time_blocks_input = [implicit_default_time_block(
            match_duration_seconds, payload.warn_below_multiplier
        )]
        time_blocks_input[0]["start_time"] = implicit_start.strftime("%H:%M")
        time_blocks_input[0]["date"] = implicit_start.date()
        timezone_name = "UTC"

    try:
        if payload.time_blocks is not None:
            validate_blocks_ordered_and_non_overlapping(time_blocks_input)
            _check_no_overlap_with_prior_generations(
                db, payload.session_id, payload.division_id, time_blocks_input
            )
        resolved_blocks = resolve_block_cycle_times(
            time_blocks_input, total_time_slots_needed
        )
        global_assignments = assign_scheduled_times(
            resolved_blocks, list(range(total_time_slots_needed)), timezone_name
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    warn_threshold_seconds = match_duration_seconds * payload.warn_below_multiplier
    tight_blocks = [
        b for b in resolved_blocks if b.cycle_time_seconds < warn_threshold_seconds
    ]
    cycle_time_warning = None
    if tight_blocks:
        block_names = ", ".join(f"{b.date} {b.start_time}" for b in tight_blocks)
        cycle_time_warning = (
            f"Cycle time is below {payload.warn_below_multiplier}x match "
            f"duration ({match_duration_seconds}s) in block(s) starting at "
            f"{block_names}"
        )

    resolved_time_blocks_read = [
        ResolvedTimeBlockRead(
            start_time=b.start_time, end_time=b.end_time, cycle_time_seconds=b.cycle_time_seconds
        )
        for b in resolved_blocks
    ]

    if payload.dry_run:
        phase_results_dry = (
            [
                PhaseResult(
                    round_type=phase.round_type,
                    schedule_generation_id=None,
                    match_count=len(generated),
                )
                for phase, generated in phase_generated
            ]
            if payload.phases is not None
            else None
        )
        return ScheduleGenerateResponse(
            schedule_generation_id=None,
            match_count=sum(len(generated) for _, generated in phase_generated),
            resolved_time_blocks=resolved_time_blocks_read,
            cycle_time_warning=cycle_time_warning,
            phase_results=phase_results_dry,
        )

    stored_time_blocks_json = serialize_time_blocks(time_blocks_input)
    phase_results: list[PhaseResult] = []
    created_matches = []
    global_offset = 0
    for phase, generated in phase_generated:
        sorted_local_slots = sorted({entry["time_slot"] for entry in generated})
        global_index_by_local_slot = {
            local_slot: global_offset + rank
            for rank, local_slot in enumerate(sorted_local_slots)
        }
        global_offset += len(sorted_local_slots)

        generation = ScheduleGeneration(
            session_id=payload.session_id,
            division_id=payload.division_id,
            round_type=phase.round_type,
            scheduler_plugin_name=scheduler_plugin.name,
            scheduler_plugin_version=scheduler_plugin.version,
            target_matches_per_team=phase.target_matches_per_team,
            generated_at=utc_now(),
            time_blocks_json=stored_time_blocks_json,
        )
        db.add(generation)
        db.flush()

        fields_by_set: dict[int, list[int]] = {}
        for f in fields:
            fields_by_set.setdefault(f.field_set_id, []).append(f.id)
        for field_ids in fields_by_set.values():
            field_ids.sort()
        next_field_index: dict[int, int] = {fs_id: 0 for fs_id in fields_by_set}

        phase_matches = []
        for match_number, entry in enumerate(generated, start=1):
            field_set_id = entry["field_set_id"]
            field_ids_for_set = fields_by_set[field_set_id]
            field_id = field_ids_for_set[
                next_field_index[field_set_id] % len(field_ids_for_set)
            ]
            next_field_index[field_set_id] += 1

            global_index = global_index_by_local_slot[entry["time_slot"]]
            match = Match(
                session_id=payload.session_id,
                division_id=payload.division_id,
                round_type=phase.round_type,
                match_number=match_number,
                field_id=field_id,
                time_slot=entry["time_slot"],
                schedule_generation_id=generation.id,
                scheduled_time=global_assignments[global_index],
            )
            db.add(match)
            db.flush()
            for alliance_entry in entry["alliances"]:
                alliance = Alliance(match_id=match.id, station=alliance_entry["station"])
                db.add(alliance)
                db.flush()
                for team_id in alliance_entry["team_ids"]:
                    db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))
            phase_matches.append(match)

        created_matches.extend(phase_matches)
        phase_results.append(
            PhaseResult(
                round_type=phase.round_type,
                schedule_generation_id=generation.id,
                match_count=len(phase_matches),
            )
        )

    db.commit()

    for created_match in created_matches:
        broadcast_for_session(
            request.app, db, created_match.session_id, "new_match_created",
            {
                "match_id": created_match.id,
                "session_id": created_match.session_id,
                "division_id": created_match.division_id,
                "field_id": created_match.field_id,
            },
        )

    return ScheduleGenerateResponse(
        schedule_generation_id=phase_results[0].schedule_generation_id,
        match_count=sum(pr.match_count for pr in phase_results),
        resolved_time_blocks=resolved_time_blocks_read,
        cycle_time_warning=cycle_time_warning,
        phase_results=phase_results if payload.phases is not None else None,
    )


@router.delete("")
def clear_schedule(
    request: Request,
    session_id: int = Query(...),
    division_id: int | None = Query(None),
    round_type: str = Query(...),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
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
        Match.session_id == session_id,
        Match.round_type == round_type,
        Match.finals_bracket_id.is_(None),
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

    generation_query = select(ScheduleGeneration).where(
        ScheduleGeneration.session_id == session_id,
        ScheduleGeneration.round_type == round_type,
    )
    if division_id is None:
        generation_query = generation_query.where(ScheduleGeneration.division_id.is_(None))
    else:
        generation_query = generation_query.where(ScheduleGeneration.division_id == division_id)
    for generation in db.execute(generation_query).scalars().all():
        db.delete(generation)

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
            recompute_rankings(request.app, db, game_plugin, session_id, division_id)

            # Delete stale event-wide rankings before recomputing them, for
            # the same reason the session-scoped rankings above are deleted
            # first: a team whose event-wide completed-match count just
            # dropped to zero would otherwise be left with a stale row,
            # since recompute_event_rankings only touches rows for teams
            # still present in its freshly-computed results.
            event_ranking_query = select(Ranking).where(Ranking.session_id.is_(None))
            if division_id is None:
                event_ranking_query = event_ranking_query.where(
                    Ranking.division_id.is_(None)
                )
            else:
                event_ranking_query = event_ranking_query.where(
                    Ranking.division_id == division_id
                )
            for ranking in db.execute(event_ranking_query).scalars().all():
                db.delete(ranking)
            db.commit()

            recompute_event_rankings(request.app, db, game_plugin, event.id, division_id)

    return {"matches_deleted": len(matches)}
