"""Finalizing a session's qualification: the preview, finalize and reopen.

Finalizing marks every unplayed qualification match `not_played` and stores
the admin's drops per played count on the session; services/ranking.py
reads them back. Reopening undoes both.
"""
from __future__ import annotations

from collections import Counter
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession

NOT_PLAYED = "not_played"
FINALIZED_SCHEDULE_DETAIL = "Qualification is finalized; reopen it to change the schedule."
NOT_PLAYED_SCORE_DETAIL = "This match was not played; reopen qualification to score it."
NOT_PLAYED_START_DETAIL = "This match was not played; reopen qualification to run it."
FINALS_NEED_FINALIZE_DETAIL = "Finalize this session's qualification before generating finals."
FINALS_EXIST_DETAIL = "Delete this session's finals brackets before reopening qualification"

_IDLE_PHASES = ("not_started", "ended")


def is_finalized(session_obj: TournamentSession) -> bool:
    return session_obj.qualification_finalized_at is not None


def qualification_matches(db: Session, session_id: int) -> list[Match]:
    """The session's qualification matches in every division, any status. Practice and finals excluded."""
    return list(
        db.execute(
            select(Match)
            .where(
                Match.session_id == session_id,
                Match.finals_bracket_id.is_(None),
                Match.round_type != "practice",
            )
            .order_by(Match.id)
        ).scalars().all()
    )


def _scored_match_ids(db: Session, match_ids: list[int]) -> set[int]:
    if not match_ids:
        return set()
    return set(
        db.execute(
            select(Alliance.match_id)
            .join(ScoreRecord, ScoreRecord.alliance_id == Alliance.id)
            .where(Alliance.match_id.in_(match_ids))
            .distinct()
        ).scalars().all()
    )


def played_counts(db: Session, matches: list[Match]) -> dict[int, int]:
    """team_id -> scored alliance entries in completed matches. This is the same count
    ranking's `matches_played` uses (one per alliance the team was on)."""
    completed = [m.id for m in matches if m.status == "completed"]
    if not completed:
        return {}
    rows = db.execute(
        select(AllianceTeam.team_id, Alliance.id)
        .join(Alliance, AllianceTeam.alliance_id == Alliance.id)
        .join(ScoreRecord, ScoreRecord.alliance_id == Alliance.id)
        .where(Alliance.match_id.in_(completed))
        .distinct()
    ).all()
    return dict(Counter(team_id for team_id, _ in rows))


@dataclass
class FinalizeState:
    played: dict[int, int]  # team_id -> played count
    blockers: list[dict] = field(default_factory=list)  # [{"code", "count"}]
    unplayed: list[Match] = field(default_factory=list)


def finalize_state(db: Session, session_id: int) -> FinalizeState:
    matches = qualification_matches(db, session_id)
    open_matches = [m for m in matches if m.status not in ("completed", NOT_PLAYED)]
    scored = _scored_match_ids(db, [m.id for m in open_matches])
    in_progress = [m for m in open_matches if m.phase not in _IDLE_PHASES]
    ended = [m for m in open_matches if m.phase == "ended" and m.id not in scored]
    partial = [m for m in open_matches if m.id in scored]
    blockers: list[dict] = []
    if not matches:
        blockers.append({"code": "no_matches", "count": 0})
    for code, blocked in (("in_progress", in_progress), ("ended_unscored", ended), ("partially_scored", partial)):
        if blocked:
            blockers.append({"code": code, "count": len(blocked)})
    blocked_ids = {m.id for m in (*in_progress, *ended, *partial)}
    unplayed = [m for m in open_matches if m.id not in blocked_ids]
    return FinalizeState(played_counts(db, matches), blockers, unplayed)


def preview_rows(state: FinalizeState, cooperative: bool, suggest) -> list[dict]:
    """One row per distinct played count, ascending. `suggest(played) -> int`."""
    if not cooperative:
        return []
    teams = Counter(state.played.values())
    return [
        {"played": played, "teams": teams[played], "suggested": suggest(played)}
        for played in sorted(teams)
    ]


def blocker_detail(blockers: list[dict]) -> str:
    phrases = {
        "no_matches": lambda n: "the session has no qualification matches",
        "in_progress": lambda n: f"{n} match{'es' if n != 1 else ''} in progress",
        "ended_unscored": lambda n: f"{n} match{'es' if n != 1 else ''} ended without a score",
        "partially_scored": lambda n: f"{n} match{'es' if n != 1 else ''} only partly scored",
    }
    return "Qualification can't be finalized yet: " + ", ".join(
        phrases[b["code"]](b["count"]) for b in blockers
    )


def finalize(db: Session, session_obj: TournamentSession, state: FinalizeState, drops: dict[str, int]) -> None:
    for match in state.unplayed:
        match.status = NOT_PLAYED
    session_obj.qualification_finalized_at = utc_now()
    session_obj.qualification_drops = dict(drops)
    db.commit()


def reopen(db: Session, session_obj: TournamentSession) -> None:
    for match in qualification_matches(db, session_obj.id):
        if match.status == NOT_PLAYED:
            match.status = "scheduled"
    session_obj.qualification_finalized_at = None
    session_obj.qualification_drops = None
    db.commit()
