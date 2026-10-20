"""Skills runs and skills field-set timers (live scoring design §4.3, §4.4, §6)."""
from __future__ import annotations

import datetime as dt
import json
import math
from typing import Any, NamedTuple

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server import realtime
from tournament_server.db import utc_now
from tournament_server.models.field import Field
from tournament_server.models.field_set import SKILLS, FieldSet
from tournament_server.models.scoring_draft import SkillsRun, SkillsSetTimer
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.schemas.skills_run import (
    SkillsFieldRead,
    SkillsRunCreate,
    SkillsRunRead,
    SkillsSetRead,
    SkillsSetTimerRead,
)
from tournament_server.services import skills
from tournament_server.services.skills_rules import scoresheet_violations

SKILLS_SET_DETAIL = "This is a skills field set."


def ensure_set_timer(db: Session, field_set: FieldSet) -> SkillsSetTimer | None:
    """A skills set has exactly one timer row and a teamwork set none: this
    creates or deletes the row to match the set's purpose and returns the
    timer (None for a teamwork set). The timer's skills type stays null
    until it is chosen; readers fall back to the game's first type."""
    timer = db.execute(
        select(SkillsSetTimer).where(SkillsSetTimer.field_set_id == field_set.id)
    ).scalars().first()
    if field_set.purpose == SKILLS:
        if timer is None:
            timer = SkillsSetTimer(field_set_id=field_set.id)
            db.add(timer)
            db.flush()
        return timer
    if timer is not None:
        db.delete(timer)
        db.flush()
    return None


READY, RUNNING, ENDED = "ready", "running", "ended"
RUN_EVENT_ROLES = ("admin", "scorer", "referee", "display_device")

NOT_SKILLS_FIELD = "This is not a skills field."
NOT_SKILLS_SET = "This is not a skills field set."
FIELD_BUSY = "This field already has a run."
NO_RUN = "This field has no run."
SET_TYPE_ONLY = "A run following the set uses the set's skills type."
SCORESHEET_ERRORS = "The scoresheet has errors."


class RunRefused(Exception):
    """A refused skills-run request. `detail` is a string, or a dict that is
    the whole response body (scoresheet violations)."""

    def __init__(self, status_code: int, detail: object) -> None:
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


class TimerState(NamedTuple):
    phase: str
    deadline: dt.datetime | None
    paused: bool
    remaining: int | None


_READY_STATE = TimerState(READY, None, False, None)


def timer_state(row: SkillsSetTimer | SkillsRun | None, now: dt.datetime | None = None) -> TimerState:
    """A timer as it reads now (a set timer, or a run's own timer). Timers end
    on the server clock: a running timer past its deadline reads as ended,
    computed on read as match phases are. A missing set timer reads as ready."""
    if row is None:
        return _READY_STATE
    if row.phase == RUNNING and row.paused:
        return TimerState(RUNNING, None, True, row.remaining_seconds_at_pause)
    if row.phase == RUNNING and row.deadline is not None:
        left = (row.deadline - (now or utc_now())).total_seconds()
        if left <= 0:
            return TimerState(ENDED, None, False, None)
        return TimerState(RUNNING, row.deadline, False, math.ceil(left))
    return TimerState(row.phase, None, False, None)


def effective_timer(run: SkillsRun, set_timer: SkillsSetTimer | None) -> TimerState:
    """The timer a run is on: the set's while it follows the set, else its own."""
    return timer_state(set_timer if run.follows_set else run)


def _copy_state(row: SkillsSetTimer | SkillsRun, state: TimerState) -> None:
    row.phase = state.phase
    row.deadline = state.deadline
    row.paused = state.paused
    row.remaining_seconds_at_pause = state.remaining if state.paused else None


def require_skills_set(field_set: FieldSet) -> FieldSet:
    if field_set.purpose != SKILLS:
        raise RunRefused(409, NOT_SKILLS_SET)
    return field_set


def skills_set_for_field(db: Session, field: Field) -> FieldSet:
    field_set = db.get(FieldSet, field.field_set_id)
    if field_set is None or field_set.purpose != SKILLS:
        raise RunRefused(409, NOT_SKILLS_FIELD)
    return field_set


def find_set_timer(db: Session, field_set_id: int) -> SkillsSetTimer | None:
    return db.execute(
        select(SkillsSetTimer).where(SkillsSetTimer.field_set_id == field_set_id)
    ).scalars().first()


def run_on_field(db: Session, field_id: int) -> SkillsRun | None:
    return db.execute(select(SkillsRun).where(SkillsRun.field_id == field_id)).scalars().first()


def _run_or_404(db: Session, field_id: int) -> SkillsRun:
    run = run_on_field(db, field_id)
    if run is None:
        raise RunRefused(404, NO_RUN)
    return run


def following_runs(db: Session, field_set_id: int) -> list[SkillsRun]:
    return list(
        db.execute(
            select(SkillsRun).where(SkillsRun.field_set_id == field_set_id, SkillsRun.follows_set.is_(True))
        ).scalars().all()
    )


def set_skills_type(plugin: LoadedPlugin, set_timer: SkillsSetTimer | None) -> str | None:
    """The set's skills type: the one last chosen, else the game's first."""
    if set_timer is not None and set_timer.skills_type:
        return set_timer.skills_type
    types = skills.plugin_types(plugin)
    return types[0]["key"] if types else None


def _run_length(plugin: LoadedPlugin, skills_type: str | None) -> int | None:
    return skills.run_seconds(plugin, skills_type) if skills_type else None


def run_score(plugin: LoadedPlugin, skills_type: str, data: dict[str, Any]) -> int:
    """The score so far; 0 while the plugin can't score the sheet yet."""
    try:
        return int(plugin.module.calculate_skills_score(skills_type, data))
    except Exception:  # noqa: BLE001 - a half-filled sheet just shows 0
        return 0


def item_violations(schema: list[dict[str, Any]], changes: dict[str, Any]) -> list[dict[str, str]]:
    """Each changed item checked alone against the type's scoresheet, with the
    same messages as a submitted skills attempt."""
    by_name = {item["name"]: item for item in schema}
    violations: list[dict[str, str]] = []
    for name, value in changes.items():
        item = by_name.get(name)
        if item is None:
            violations.append({"field": name, "message": "Unknown field."})
            continue
        violations.extend(scoresheet_violations([item], {name: value}))
    return violations


def _start_next_batch(db: Session, field_set_id: int, set_timer: SkillsSetTimer, now: dt.datetime) -> None:
    """The set's timer has ended and a new run is joining it: runs still
    following the set keep their ended timer on their own, and the set timer
    is ready for the next batch."""
    ended = timer_state(set_timer, now)
    for run in following_runs(db, field_set_id):
        _copy_state(run, ended)
        run.follows_set = False
    _copy_state(set_timer, _READY_STATE)


def create_run(
    db: Session, plugin: LoadedPlugin, field: Field, payload: SkillsRunCreate, device_name: str
) -> SkillsRun:
    field_set = skills_set_for_field(db, field)
    session_obj = db.get(TournamentSession, field_set.session_id)
    types = {t["key"]: t for t in skills.plugin_types(plugin)}
    set_timer = ensure_set_timer(db, field_set)
    set_type = set_skills_type(plugin, set_timer)
    skills_type = payload.skills_type or set_type
    if skills_type not in types:
        raise RunRefused(422, f"Unknown skills type: {skills_type!r}")
    team = db.get(Team, payload.team_id)
    if team is None or team.event_id != session_obj.event_id:
        raise RunRefused(422, "Unknown team")
    refusal = skills.attempt_refusal(db, session_obj, team, skills_type, types)
    if refusal is not None:
        raise RunRefused(409, refusal)
    if run_on_field(db, field.id) is not None:
        raise RunRefused(409, FIELD_BUSY)
    follows_set = payload.follows_set
    if follows_set and skills_type != set_type:
        raise RunRefused(409, SET_TYPE_ONLY)
    now = utc_now()
    if follows_set:
        set_phase = timer_state(set_timer, now).phase
        if set_phase == ENDED:
            _start_next_batch(db, field_set.id, set_timer, now)
        elif set_phase == RUNNING:
            # A late team never joins a running set timer partway: it waits on its own.
            follows_set = False
    run = SkillsRun(
        field_id=field.id,
        field_set_id=field_set.id,
        session_id=field_set.session_id,
        team_id=team.id,
        skills_type=skills_type,
        data_json="{}",
        item_meta_json="{}",
        version=0,
        follows_set=follows_set,
        phase=READY,
        deadline=None,
        paused=False,
        remaining_seconds_at_pause=None,
        created_by_device=device_name,
        created_at=now,
    )
    db.add(run)
    try:
        db.commit()
    except IntegrityError:
        # Another request put a run on this field between the check and the insert.
        db.rollback()
        raise RunRefused(409, FIELD_BUSY)
    db.refresh(run)
    return run


def patch_run(
    db: Session, plugin: LoadedPlugin, field: Field, changes: dict[str, Any], device_name: str
) -> SkillsRun:
    """Merges changed items into the run's sheet: each accepted item overwrites
    the stored one (last write wins per item), records who changed it and
    when, and the version goes up by one. Any bad item refuses them all."""
    skills_set_for_field(db, field)
    run = _run_or_404(db, field.id)
    violations = item_violations(plugin.module.skills_scoresheet_schema(run.skills_type), changes)
    if violations:
        raise RunRefused(422, {"detail": SCORESHEET_ERRORS, "violations": violations})
    if not changes:
        return run
    data = json.loads(run.data_json)
    meta = json.loads(run.item_meta_json)
    at = utc_now().isoformat()
    for name, value in changes.items():
        data[name] = value
        meta[name] = {"device_name": device_name, "at": at}
    run.data_json = json.dumps(data)
    run.item_meta_json = json.dumps(meta)
    run.version += 1
    db.commit()
    db.refresh(run)
    return run


def discard_run(db: Session, field: Field) -> None:
    """Throws the field's run away; no attempt is used."""
    skills_set_for_field(db, field)
    db.delete(_run_or_404(db, field.id))
    db.commit()


def _run_read(db: Session, plugin: LoadedPlugin, run: SkillsRun, set_timer: SkillsSetTimer | None) -> SkillsRunRead:
    state = effective_timer(run, set_timer)
    team = db.get(Team, run.team_id)
    data = json.loads(run.data_json)
    return SkillsRunRead(
        id=run.id,
        field_id=run.field_id,
        field_set_id=run.field_set_id,
        team_id=run.team_id,
        team_number=team.number,
        team_name=team.name,
        skills_type=run.skills_type,
        data=data,
        item_meta=json.loads(run.item_meta_json),
        version=run.version,
        score=run_score(plugin, run.skills_type, data),
        follows_set=run.follows_set,
        phase=state.phase,
        deadline=state.deadline,
        paused=state.paused,
        remaining_seconds=state.remaining,
    )


def run_read(db: Session, plugin: LoadedPlugin, run: SkillsRun) -> SkillsRunRead:
    return _run_read(db, plugin, run, find_set_timer(db, run.field_set_id))


def _timer_read(plugin: LoadedPlugin, field_set_id: int, set_timer: SkillsSetTimer | None) -> SkillsSetTimerRead:
    state = timer_state(set_timer)
    skills_type = set_skills_type(plugin, set_timer)
    return SkillsSetTimerRead(
        field_set_id=field_set_id,
        skills_type=skills_type,
        phase=state.phase,
        deadline=state.deadline,
        paused=state.paused,
        remaining_seconds=state.remaining,
        run_seconds=_run_length(plugin, skills_type),
    )


def read_set(db: Session, plugin: LoadedPlugin, field_set: FieldSet) -> SkillsSetRead:
    """The set's timer and each of its fields with its run, for Skills
    Control, the scoring page and displays."""
    require_skills_set(field_set)
    set_timer = ensure_set_timer(db, field_set)
    db.commit()
    runs = {
        run.field_id: run
        for run in db.execute(select(SkillsRun).where(SkillsRun.field_set_id == field_set.id)).scalars().all()
    }
    fields = db.execute(select(Field).where(Field.field_set_id == field_set.id).order_by(Field.id)).scalars().all()
    return SkillsSetRead(
        timer=_timer_read(plugin, field_set.id, set_timer),
        fields=[
            SkillsFieldRead(
                field_id=field.id,
                name=field.name,
                run=_run_read(db, plugin, runs[field.id], set_timer) if field.id in runs else None,
            )
            for field in fields
        ],
    )


def notify(app, field_set_id: int, field_id: int | None = None) -> None:
    """Announces a run or timer change (`skills_run_changed`) and re-sends the
    set's live scores to displays."""
    from tournament_server.services import live_scores  # live_scores imports this module

    data: dict[str, int] = {"field_set_id": field_set_id}
    if field_id is not None:
        data["field_id"] = field_id
    realtime.broadcast_active_session(app, "skills_run_changed", data, roles=RUN_EVENT_ROLES)
    with app.state.session_factory() as db:
        live_scores.on_skills_changed(app, db, field_set_id)
