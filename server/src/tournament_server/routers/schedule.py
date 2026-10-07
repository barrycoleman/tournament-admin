from __future__ import annotations

import datetime as dt
import math
from dataclasses import dataclass
from zoneinfo import ZoneInfo

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
from tournament_server.models.schedule_generation import ScheduleGeneration
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.realtime import broadcast_for_session
from tournament_server.schemas.schedule import (
    RoundResult,
    ScheduleGenerateRequest,
    ScheduleGenerateResponse,
    ScheduleOverflow,
    ScheduleRoundsRead,
    ScheduledRoundRead,
)
from tournament_server.services import qualification
from tournament_server.services.deletion import delete_matches
from tournament_server.services.playing_windows import load_windows
from tournament_server.services.schedule_timing import (
    PlayingWindow,
    block_utc_bounds,
    ceil_minute,
    deserialize_time_blocks,
    occupied_by_window,
    overflow_suggestions,
    place_plan,
    serialize_time_blocks,
    to_utc_windows,
)
from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings
from tournament_server.services.team_assignment import get_sole_division_id
from tournament_server.services.scheduling import build_pairing_history

router = APIRouter(prefix="/api/schedule", tags=["schedule"])


def _validate_generated_schedule(
    generated: list, valid_field_set_ids: set[int], alliance_count: int, round_type: str
) -> None:
    """`round_type` is included in every raised HTTPException's detail so
    a multi-round request's error names which round actually
    failed -- mirroring the round_type context the round loop's own
    scheduler-plugin-exception handler already adds around its call into
    this function."""

    def _fail(status_code: int, message: str) -> None:
        raise HTTPException(
            status_code=status_code, detail=f"round_type {round_type!r}: {message}"
        )

    if not isinstance(generated, list) or not generated:
        _fail(422, "Scheduler plugin returned no matches")

    teams_by_slot: dict[int, set[int]] = {}
    for entry in generated:
        if not isinstance(entry, dict):
            _fail(422, "Scheduler plugin returned a malformed match")
        missing = {"time_slot", "field_set_id", "alliances"} - entry.keys()
        if missing:
            _fail(422, f"Scheduler plugin returned a match missing keys: {sorted(missing)}")
        if entry["field_set_id"] not in valid_field_set_ids:
            _fail(
                422,
                f"Scheduler plugin returned an unknown field_set_id "
                f"{entry['field_set_id']!r}",
            )
        alliances = entry["alliances"]
        if not isinstance(alliances, list) or len(alliances) != alliance_count:
            _fail(422, f"Each match must have exactly {alliance_count} alliances")
        stations = set()
        slot_teams = teams_by_slot.setdefault(entry["time_slot"], set())
        for alliance in alliances:
            if "station" not in alliance or "team_ids" not in alliance:
                _fail(
                    422,
                    "Scheduler plugin returned an alliance missing 'station' or 'team_ids'",
                )
            station = alliance["station"]
            if not isinstance(station, str) or not station:
                _fail(422, "Scheduler plugin returned a non-string or empty station name")
            if not alliance["team_ids"]:
                _fail(422, "Scheduler plugin returned an alliance with no teams")
            stations.add(station)
            for team_id in alliance["team_ids"]:
                if team_id in slot_teams:
                    _fail(
                        422,
                        f"Scheduler plugin double-booked team {team_id} in "
                        f"time_slot {entry['time_slot']}",
                    )
                slot_teams.add(team_id)
        if len(stations) != len(alliances):
            _fail(422, "Alliance stations must be distinct within a match")


def _local_clock(instant: dt.datetime, timezone_name: str, on_date: dt.date) -> str:
    """`instant` as wall-clock time in `timezone_name`: HH:MM, with :SS only
    when it isn't on the minute, and its date in front when that differs
    from `on_date` (a window that runs past midnight)."""
    local = instant.astimezone(ZoneInfo(timezone_name))
    clock = local.strftime("%H:%M:%S" if local.second else "%H:%M")
    return clock if local.date() == on_date else f"{local.date().isoformat()} {clock}"


def _check_no_overlap_with_prior_generations(
    db: Session,
    session_id: int,
    division_id: int | None,
    skip_round_types: set[str],
    new_windows: list[tuple[str, PlayingWindow, dt.datetime, dt.datetime]],
    new_timezone_name: str,
) -> None:
    """A safety net: raises ValueError if any new round's matches overlap the
    matches of another live generation in this (session, division). Rounds
    being rebuilt (skip_round_types) are about to be deleted, so they don't
    count. Under normal use this can't fire, because a plan starts after the
    division's kept matches; it guards against rows saved before occupied
    windows existed, which fall back to their requested window (open-ended
    meaning indefinitely). Both sides are compared as real UTC instants."""
    query = select(ScheduleGeneration).where(ScheduleGeneration.session_id == session_id)
    if division_id is None:
        query = query.where(ScheduleGeneration.division_id.is_(None))
    else:
        query = query.where(ScheduleGeneration.division_id == division_id)

    for prior in db.execute(query).scalars().all():
        if prior.round_type in skip_round_types or prior.time_blocks_json is None:
            continue
        for prior_block in deserialize_time_blocks(prior.time_blocks_json):
            prior_timezone = prior_block["timezone"]
            prior_start, prior_end = block_utc_bounds(prior_block, prior_timezone)
            if "occupied" in prior_block:
                if prior_block["occupied"] is None:
                    continue
                prior_start, prior_end = prior_block["occupied"]
            for round_type, window, new_start, new_end in new_windows:
                if new_end <= prior_start or (prior_end is not None and prior_end <= new_start):
                    continue
                prior_from = _local_clock(prior_start, prior_timezone, prior_block["date"])
                prior_range = (
                    f"from {prior_from} to "
                    f"{_local_clock(prior_end, prior_timezone, prior_block['date'])}"
                    if prior_end is not None
                    else f"from {prior_from} with no end time"
                )
                raise ValueError(
                    f"The new {_round_label(round_type)} matches on {window.date.isoformat()} "
                    f"would run from {_local_clock(new_start, new_timezone_name, window.date)} to "
                    f"{_local_clock(new_end, new_timezone_name, window.date)}, overlapping the "
                    f"{prior.round_type} round's matches on {prior_block['date'].isoformat()}, "
                    f"which run {prior_range} ({prior_timezone}). Clear that round or change "
                    "the playing times."
                )


def _fold_generated_into_pairing_history(
    pairing_history: dict[frozenset[int], dict[str, int]], generated: list[dict]
) -> None:
    """Mutates pairing_history in place to include the partner/opponent
    pairings from a round's just-generated (not yet persisted) matches, in
    the same {frozenset({team_a, team_b}): {"partner_count", "opponent_count"}}
    shape build_pairing_history produces -- so a later round in the same
    /api/schedule request sees the earlier round's own results
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


def _round_label(round_type: str) -> str:
    return round_type.replace("_", " ").capitalize()


@dataclass
class _DivisionRound:
    round_type: str
    matches: list[Match]
    first_start: dt.datetime | None
    scored_match_ids: set[int]


def _division_rounds(db: Session, session_id: int, division_id: int | None) -> list[_DivisionRound]:
    """The scope's schedule-generated rounds (finals games excluded) in
    chronological order of their first match."""
    query = select(Match).where(Match.session_id == session_id, Match.finals_bracket_id.is_(None))
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    matches = db.execute(query).scalars().all()
    match_ids = [match.id for match in matches]
    scored = (
        set(
            db.execute(
                select(Alliance.match_id)
                .join(ScoreRecord, ScoreRecord.alliance_id == Alliance.id)
                .where(Alliance.match_id.in_(match_ids))
            ).scalars().all()
        )
        if match_ids
        else set()
    )
    by_type: dict[str, list[Match]] = {}
    for match in matches:
        by_type.setdefault(match.round_type, []).append(match)
    rounds = []
    for round_type, round_matches in by_type.items():
        times = [m.scheduled_time for m in round_matches if m.scheduled_time is not None]
        rounds.append(
            _DivisionRound(
                round_type=round_type,
                matches=round_matches,
                first_start=min(times) if times else None,
                scored_match_ids={m.id for m in round_matches if m.id in scored},
            )
        )
    latest = dt.datetime.max.replace(tzinfo=dt.UTC)
    rounds.sort(key=lambda r: (r.first_start or latest, r.round_type))
    return rounds


def _rounds_to_replace(existing: list[_DivisionRound], listed: list[str]) -> list[_DivisionRound]:
    """The existing rounds a request rebuilds: from the earliest listed one
    to the end. Every round after it must be listed too (a rebuild moves
    them), and none of them may have scores."""
    first = next((i for i, r in enumerate(existing) if r.round_type in listed), None)
    if first is None:
        return []
    tail = existing[first:]
    for later in tail:
        if later.round_type not in listed:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Rebuilding {_round_label(tail[0].round_type)} also moves the rounds "
                    f"after it; include {_round_label(later.round_type)} too"
                ),
            )
    for round_ in tail:
        if round_.scored_match_ids:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{_round_label(round_.round_type)} has scored matches, so it can't be "
                    "rebuilt. Clear it first."
                ),
            )
    return tail


def _delete_round(db: Session, session_id: int, division_id: int | None, round_type: str) -> int:
    """Deletes one round's schedule-generated matches (with their alliances
    and score records) and its ScheduleGeneration rows. Doesn't commit."""
    match_query = select(Match).where(
        Match.session_id == session_id,
        Match.round_type == round_type,
        Match.finals_bracket_id.is_(None),
    )
    generation_query = select(ScheduleGeneration).where(
        ScheduleGeneration.session_id == session_id,
        ScheduleGeneration.round_type == round_type,
    )
    if division_id is None:
        match_query = match_query.where(Match.division_id.is_(None))
        generation_query = generation_query.where(ScheduleGeneration.division_id.is_(None))
    else:
        match_query = match_query.where(Match.division_id == division_id)
        generation_query = generation_query.where(ScheduleGeneration.division_id == division_id)
    matches = db.execute(match_query).scalars().all()
    delete_matches(db, matches)
    for generation in db.execute(generation_query).scalars().all():
        db.delete(generation)
    db.flush()
    return len(matches)


@router.post("", response_model=ScheduleGenerateResponse, status_code=201)
def generate_schedule(
    payload: ScheduleGenerateRequest,
    request: Request,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> ScheduleGenerateResponse:
    """Plans (dry_run) or builds a division's rounds, flowing their matches
    through the session's playing windows. A listed round that already
    exists is rebuilt, together with every round after it, in one
    transaction."""
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

    session_obj = db.get(TournamentSession, payload.session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if qualification.is_finalized(session_obj) and any(r.round_type != "practice" for r in payload.rounds):
        raise HTTPException(status_code=409, detail=qualification.FINALIZED_SCHEDULE_DETAIL)
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    scheduler_plugin = request.app.state.scheduler_plugins.get(payload.scheduler_plugin_name)
    if scheduler_plugin is None:
        raise HTTPException(
            status_code=404,
            detail=f"Scheduler plugin {payload.scheduler_plugin_name!r} is not installed",
        )

    match_format = game_plugin.module.match_format()
    match_seconds = match_format["autonomous_seconds"] + match_format["driver_seconds"]
    listed = [r.round_type for r in payload.rounds]
    if len(set(listed)) != len(listed):
        raise HTTPException(status_code=422, detail="rounds must not repeat a round_type")
    for round_in in payload.rounds:
        if round_in.round_type == "elimination":
            raise HTTPException(
                status_code=422,
                detail="Elimination matches are created by the finals bracket, not the schedule",
            )
        if round_in.round_type not in match_format["round_types"]:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{round_in.round_type!r} is not a valid round_type for this "
                    "event's game plugin"
                ),
            )
        if round_in.cycle_time_seconds < match_seconds:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{_round_label(round_in.round_type)}'s cycle time must be at least "
                    f"the match length ({match_seconds}s)"
                ),
            )

    if session_obj.timezone is None:
        raise HTTPException(
            status_code=422, detail="Set the session's timezone before scheduling"
        )
    timezone_name = session_obj.timezone
    window_rows = load_windows(db, payload.session_id)
    if not window_rows:
        raise HTTPException(
            status_code=422,
            detail="This session has no playing times; add them before scheduling",
        )
    windows = to_utc_windows(window_rows, timezone_name)

    existing = _division_rounds(db, payload.session_id, payload.division_id)
    replaced = _rounds_to_replace(existing, listed)
    kept_starts = [
        match.scheduled_time
        for round_ in existing
        if round_.round_type not in listed
        for match in round_.matches
        if match.scheduled_time is not None
    ]
    earliest = (
        ceil_minute(max(kept_starts) + dt.timedelta(seconds=match_seconds))
        if kept_starts
        else windows[0].start
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
        field_set_query = field_set_query.where(FieldSet.division_id == payload.division_id)
    field_sets = db.execute(field_set_query).scalars().all()
    if not field_sets:
        if payload.division_id is None:
            raise HTTPException(
                status_code=422, detail="Session has no unassigned FieldSets configured"
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

    teams_per_alliance = match_format["teams_per_alliance"]
    alliance_count = match_format["alliance_count"]
    pairing_history = build_pairing_history(
        db, event.id, exclude_match_ids={m.id for r in replaced for m in r.matches}
    )

    generated_rounds: list[list[dict]] = []
    for round_in in payload.rounds:
        try:
            generated = scheduler_plugin.module.generate_schedule(
                teams=[{"team_id": t.id, "organization": t.organization} for t in teams],
                target_matches_per_team=round_in.target_matches_per_team,
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
                    f"round_type {round_in.round_type!r}: {exc}"
                ),
            )
        _validate_generated_schedule(
            generated, {fs.id for fs in field_sets}, alliance_count, round_in.round_type
        )
        _fold_generated_into_pairing_history(pairing_history, generated)
        generated_rounds.append(generated)

    # Each round's time slots in order; matches sharing a slot run together.
    slot_ranks = [
        {slot: rank for rank, slot in enumerate(sorted({e["time_slot"] for e in generated}))}
        for generated in generated_rounds
    ]
    plan = [
        (len(ranks), round_in.cycle_time_seconds)
        for ranks, round_in in zip(slot_ranks, payload.rounds)
    ]
    placement = place_plan(windows, earliest, plan, match_seconds)
    match_length = dt.timedelta(seconds=match_seconds)

    round_results = []
    unplaced_matches = 0
    for round_in, generated, ranks, starts in zip(
        payload.rounds, generated_rounds, slot_ranks, placement.round_starts
    ):
        unplaced_matches += sum(1 for e in generated if ranks[e["time_slot"]] >= len(starts))
        round_results.append(
            RoundResult(
                round_type=round_in.round_type,
                schedule_generation_id=None,
                match_count=len(generated),
                slot_count=len(ranks),
                first_start=starts[0] if starts else None,
                last_end=starts[-1] + match_length if len(starts) == len(ranks) else None,
            )
        )

    if not placement.fits:
        suggestions = overflow_suggestions(windows, earliest, plan, match_seconds, timezone_name)
        overflow = ScheduleOverflow(
            unplaced_slot_count=placement.unplaced_slot_count,
            unplaced_match_count=unplaced_matches,
            over_by_seconds=suggestions.over_by_seconds,
            suggested_cycle_time_seconds=suggestions.suggested_cycle_time_seconds,
            suggested_last_window_end=suggestions.suggested_last_window_end,
        )
        if not payload.dry_run:
            first_short = next(r for r in round_results if r.last_end is None)
            raise HTTPException(
                status_code=422,
                detail=(
                    f"{unplaced_matches} matches don't fit in the session's playing times, "
                    f"starting with {_round_label(first_short.round_type)} (over by "
                    f"{math.ceil(suggestions.over_by_seconds / 60)} min). Shorten the cycle "
                    "time or add playing time."
                ),
            )
        return ScheduleGenerateResponse(fits=False, rounds=round_results, overflow=overflow)

    occupied_per_round = [
        occupied_by_window(windows, starts, match_seconds) for starts in placement.round_starts
    ]
    try:
        _check_no_overlap_with_prior_generations(
            db,
            payload.session_id,
            payload.division_id,
            set(listed),
            [
                (round_in.round_type, window, start, end)
                for round_in, occupied in zip(payload.rounds, occupied_per_round)
                for window, start, end in occupied
            ],
            timezone_name,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    if payload.dry_run:
        return ScheduleGenerateResponse(fits=True, rounds=round_results, overflow=None)

    # Everything below runs in one transaction: a failure before commit
    # leaves the previous schedule exactly as it was.
    for round_ in replaced:
        _delete_round(db, payload.session_id, payload.division_id, round_.round_type)

    fields_by_set: dict[int, list[int]] = {}
    for f in fields:
        fields_by_set.setdefault(f.field_set_id, []).append(f.id)
    for field_ids in fields_by_set.values():
        field_ids.sort()

    created_matches = []
    for index, (round_in, generated, ranks, starts, occupied) in enumerate(
        zip(payload.rounds, generated_rounds, slot_ranks, placement.round_starts, occupied_per_round)
    ):
        generation = ScheduleGeneration(
            session_id=payload.session_id,
            division_id=payload.division_id,
            round_type=round_in.round_type,
            scheduler_plugin_name=scheduler_plugin.name,
            scheduler_plugin_version=scheduler_plugin.version,
            target_matches_per_team=round_in.target_matches_per_team,
            cycle_time_seconds=round_in.cycle_time_seconds,
            generated_at=utc_now(),
            time_blocks_json=serialize_time_blocks(
                [
                    {
                        "date": window.date,
                        "start_time": window.start_time,
                        "end_time": window.end_time,
                        "cycle_time": round_in.cycle_time_seconds,
                    }
                    for window, _, _ in occupied
                ],
                timezone_name,
                [(start, end) for _, start, end in occupied],
            ),
        )
        db.add(generation)
        db.flush()

        next_field_index: dict[int, int] = {fs_id: 0 for fs_id in fields_by_set}
        for match_number, entry in enumerate(generated, start=1):
            field_ids_for_set = fields_by_set[entry["field_set_id"]]
            field_id = field_ids_for_set[
                next_field_index[entry["field_set_id"]] % len(field_ids_for_set)
            ]
            next_field_index[entry["field_set_id"]] += 1
            match = Match(
                session_id=payload.session_id,
                division_id=payload.division_id,
                round_type=round_in.round_type,
                match_number=match_number,
                field_id=field_id,
                time_slot=entry["time_slot"],
                schedule_generation_id=generation.id,
                scheduled_time=starts[ranks[entry["time_slot"]]],
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
        round_results[index].schedule_generation_id = generation.id

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

    return ScheduleGenerateResponse(fits=True, rounds=round_results, overflow=None)


@router.get("/rounds", response_model=ScheduleRoundsRead)
def read_schedule_rounds(
    request: Request,
    session_id: int = Query(...),
    division_id: int | None = Query(None),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> ScheduleRoundsRead:
    """The scope's rounds in chronological order, with what the Schedule
    tab needs to show and edit them. A round is locked when it, or any
    round after it, has a scored match: rebuilding it would move scored
    matches."""
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")

    match_seconds = 0
    event = get_the_event(db)
    if event is not None and event.game_plugin_name is not None:
        game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
        if game_plugin is not None:
            match_format = game_plugin.module.match_format()
            match_seconds = match_format["autonomous_seconds"] + match_format["driver_seconds"]
    match_length = dt.timedelta(seconds=match_seconds)

    windows = (
        to_utc_windows(load_windows(db, session_id), session_obj.timezone)
        if session_obj.timezone is not None
        else []
    )

    def inside_windows(start: dt.datetime) -> bool:
        return any(w.start <= start and start + match_length <= w.end for w in windows)

    generation_query = select(ScheduleGeneration).where(ScheduleGeneration.session_id == session_id)
    if division_id is None:
        generation_query = generation_query.where(ScheduleGeneration.division_id.is_(None))
    else:
        generation_query = generation_query.where(ScheduleGeneration.division_id == division_id)
    latest_generation: dict[str, ScheduleGeneration] = {}
    for generation in db.execute(
        generation_query.order_by(ScheduleGeneration.generated_at, ScheduleGeneration.id)
    ).scalars().all():
        latest_generation[generation.round_type] = generation

    rounds = []
    for round_ in _division_rounds(db, session_id, division_id):
        generation = latest_generation.get(round_.round_type)
        times = [m.scheduled_time for m in round_.matches if m.scheduled_time is not None]
        rounds.append(
            ScheduledRoundRead(
                round_type=round_.round_type,
                target_matches_per_team=generation.target_matches_per_team if generation else None,
                cycle_time_seconds=generation.cycle_time_seconds if generation else None,
                match_count=len(round_.matches),
                scored_count=len(round_.scored_match_ids),
                first_start=min(times) if times else None,
                last_end=max(times) + match_length if times else None,
                locked=False,
                outside_playing_windows=bool(windows) and any(not inside_windows(t) for t in times),
            )
        )
    locked = False
    for round_read in reversed(rounds):
        locked = locked or round_read.scored_count > 0
        round_read.locked = locked

    last_cycle = db.execute(
        select(ScheduleGeneration.cycle_time_seconds)
        .where(
            ScheduleGeneration.session_id == session_id,
            ScheduleGeneration.cycle_time_seconds.is_not(None),
        )
        .order_by(ScheduleGeneration.generated_at.desc(), ScheduleGeneration.id.desc())
        .limit(1)
    ).scalar_one_or_none()
    return ScheduleRoundsRead(rounds=rounds, session_last_cycle_time_seconds=last_cycle)


@router.delete("")
def clear_schedule(
    request: Request,
    session_id: int = Query(...),
    division_id: int | None = Query(None),
    round_type: str = Query(...),
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> dict[str, int]:
    session_obj = db.get(TournamentSession, session_id)
    if session_obj is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if qualification.is_finalized(session_obj) and round_type != "practice":
        raise HTTPException(status_code=409, detail=qualification.FINALIZED_SCHEDULE_DETAIL)

    matches_deleted = _delete_round(db, session_id, division_id, round_type)

    db.commit()

    # Best-effort: rebuild rankings from whatever qualifying matches remain
    # for this (session_id, division_id) and for the season. Each recompute
    # replaces its scope's rows, so a team left with no match loses its row.
    # If the event or its game plugin isn't available, skip silently rather
    # than turning a successful deletion into a 500.
    event = get_the_event(db)
    if event is not None and event.game_plugin_name is not None:
        game_plugin = request.app.state.game_plugins.get(event.game_plugin_name)
        if game_plugin is not None:
            recompute_rankings(request.app, db, game_plugin, session_id, division_id)
            recompute_event_rankings(request.app, db, game_plugin, event.id, division_id)

    return {"matches_deleted": matches_deleted}
