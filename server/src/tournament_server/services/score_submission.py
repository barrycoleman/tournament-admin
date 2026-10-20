"""The official score write: validate, compute, store (mirroring a
cooperative score), and everything that follows a saved score. Shared by
POST /api/matches/{id}/alliances/{id}/score and the live-scoring Submit."""
from __future__ import annotations

import json
from typing import TYPE_CHECKING

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.deps import get_the_event
from tournament_server.models.alliance import Alliance
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.score_record_team import ScoreRecordTeam
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_for_session, broadcast_new_finals_matches
from tournament_server.schemas.score_record import TeamFlags
from tournament_server.services import displays, qualification, team_flags
from tournament_server.services.finals import advance_score_chase, advance_single_elimination
from tournament_server.services.ranking import recompute_event_rankings, recompute_rankings

if TYPE_CHECKING:
    from fastapi import FastAPI

SCORE_ALREADY_SUBMITTED_DETAIL = "This score has already been submitted; ask an admin to correct it."


class ScoreRefused(Exception):
    """A score the server won't write; the route turns it into an HTTP error."""

    def __init__(self, status_code: int, detail: object) -> None:
        super().__init__(str(detail))
        self.status_code = status_code
        self.detail = detail


def validated_flags(entries: list[TeamFlags], alliance_team_ids: list[int]) -> list[TeamFlags]:
    """The flagged entries, ordered by team; 422 for a team not on the
    alliance or listed twice."""
    seen: set[int] = set()
    for entry in entries:
        if entry.team_id not in alliance_team_ids:
            raise ScoreRefused(422, f"Team {entry.team_id} is not on this alliance.")
        if entry.team_id in seen:
            raise ScoreRefused(422, f"Team {entry.team_id} is listed more than once.")
        seen.add(entry.team_id)
    return sorted((entry for entry in entries if entry.no_show or entry.dq), key=lambda entry: entry.team_id)


def _overwrites_a_submitted_partner(db: Session, match_id: int, alliance_id: int, data: dict) -> bool:
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


def write_alliance_score(
    db: Session,
    plugin: LoadedPlugin,
    match: Match,
    alliance: Alliance,
    *,
    data: dict,
    teams: list[TeamFlags],
    sitting: bool,
    force: bool,
    submitted_by: str | None,
    is_admin: bool,
) -> tuple[ScoreRecord, int, bool]:
    """Validates and stores one alliance's official score, mirroring the
    data onto the partner alliances of a cooperative match, in one commit.
    Returns (record, computed score, whether it mirrored). Raises
    ScoreRefused with the same status and detail the score route has
    always answered."""
    if match.status == qualification.NOT_PLAYED:
        raise ScoreRefused(409, qualification.NOT_PLAYED_SCORE_DETAIL)
    existing = db.execute(
        select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
    ).scalars().first()
    # Once submitted, only an admin may correct it (skills spec 3.6). A copy
    # the cooperative mirror wrote was never submitted for this alliance, so
    # a scorer may still submit it once.
    if existing is not None and not existing.mirrored and not is_admin:
        raise ScoreRefused(409, SCORE_ALREADY_SUBMITTED_DETAIL)

    alliance_team_ids = team_flags.alliance_team_ids(db, alliance.id)
    flags = validated_flags(teams, alliance_team_ids)
    finals = match.finals_bracket_id is not None

    try:
        violations = plugin.module.validate(data)
    except Exception as exc:
        raise ScoreRefused(422, f"Plugin could not validate this scoresheet: {exc}") from exc
    if violations and not force:
        raise ScoreRefused(422, {"violations": violations})

    try:
        computed_score = (
            0
            if team_flags.alliance_out(flags, alliance_team_ids, finals=finals)
            else plugin.module.calculate_score(data)
        )
    except Exception as exc:
        raise ScoreRefused(422, f"Plugin could not score this scoresheet: {exc}") from exc

    game_model = plugin.module.match_format()["game_model"]
    mirrors = game_model == "cooperative_score" and not team_flags.alliance_out(
        flags, alliance_team_ids, finals=False
    )
    if mirrors and not is_admin and _overwrites_a_submitted_partner(db, match.id, alliance.id, data):
        # Mirroring would change the partner's submitted score, which only an
        # admin may do; refuse before writing anything.
        raise ScoreRefused(409, SCORE_ALREADY_SUBMITTED_DETAIL)

    now = utc_now()
    if existing is None:
        record = ScoreRecord(
            alliance_id=alliance.id,
            plugin_name=plugin.name,
            plugin_version=plugin.version,
            data_json=json.dumps(data),
            sitting=sitting,
            mirrored=False,
            submitted_by_device=submitted_by,
            submitted_at=now,
            saved_at=now,
        )
        record.teams = [ScoreRecordTeam(team_id=f.team_id, no_show=f.no_show, dq=f.dq) for f in flags]
        db.add(record)
    else:
        existing.data_json = json.dumps(data)
        # Clear and flush before adding, so re-flagging the same team never
        # meets its old row in the unique constraint.
        existing.teams.clear()
        db.flush()
        existing.teams.extend(
            ScoreRecordTeam(team_id=f.team_id, no_show=f.no_show, dq=f.dq) for f in flags
        )
        existing.sitting = sitting
        existing.mirrored = False
        existing.submitted_by_device = submitted_by
        existing.submitted_at = now
        existing.saved_at = now
        record = existing
    db.flush()

    if mirrors:
        for other_alliance in db.execute(
            select(Alliance).where(Alliance.match_id == match.id, Alliance.id != alliance.id)
        ).scalars().all():
            other_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == other_alliance.id)
            ).scalars().first()
            if other_record is None:
                db.add(
                    ScoreRecord(
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
                )
            else:
                other_record.data_json = record.data_json
                other_record.plugin_name = plugin.name
                other_record.plugin_version = plugin.version

    db.commit()
    db.refresh(record)
    return record, computed_score, mirrors


def after_scores_written(
    app: "FastAPI", db: Session, plugin: LoadedPlugin, match: Match, alliance_ids: list[int]
) -> None:
    """Everything that follows saved scores: score_saved per listed alliance,
    completing the match (and clearing a queued override), then finals
    advancing or the session and season rankings."""
    for alliance_id in alliance_ids:
        broadcast_for_session(
            app, db, match.session_id, "score_saved", {"match_id": match.id, "alliance_id": alliance_id}
        )

    all_alliance_ids = db.execute(select(Alliance.id).where(Alliance.match_id == match.id)).scalars().all()
    scored_alliance_ids = set(
        db.execute(
            select(ScoreRecord.alliance_id).where(ScoreRecord.alliance_id.in_(all_alliance_ids))
        ).scalars().all()
    )
    if len(scored_alliance_ids) == len(all_alliance_ids):
        match.status = "completed"
        cleared = displays.clear_queued_matches(db, [match.id])
        db.commit()
        for field_set_id in cleared:
            displays.notify_field_set_changed(app, field_set_id)

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
            broadcast_new_finals_matches(app, db, bracket.id, existing_ids)
        return

    recompute_rankings(app, db, plugin, match.session_id, match.division_id)
    event = get_the_event(db)
    if event is not None:
        recompute_event_rankings(app, db, plugin, event.id, match.division_id)
