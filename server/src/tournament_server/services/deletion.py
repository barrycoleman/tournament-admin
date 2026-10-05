"""Cascading deletes for rows whose foreign keys don't cascade on their own.
None of these commit; the caller decides when the whole change lands."""

from __future__ import annotations

from collections.abc import Iterable

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.bracket_matchup import BracketMatchup
from tournament_server.models.event import Event
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_result import FinalsResult
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.playing_window import SessionPlayingWindow
from tournament_server.models.ranking import Ranking
from tournament_server.models.schedule_generation import ScheduleGeneration
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession


def delete_matches(db: Session, matches: Iterable[Match]) -> None:
    """Deletes matches with their alliances, alliance teams and score records."""
    for match in matches:
        for alliance in db.execute(select(Alliance).where(Alliance.match_id == match.id)).scalars().all():
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
    db.flush()


def delete_finals_bracket(db: Session, bracket: FinalsBracket) -> None:
    """Deletes a finals bracket and everything it created."""
    delete_matches(
        db, db.execute(select(Match).where(Match.finals_bracket_id == bracket.id)).scalars().all()
    )
    for matchup in db.execute(
        select(BracketMatchup).where(BracketMatchup.bracket_id == bracket.id)
    ).scalars().all():
        db.delete(matchup)
    for result in db.execute(
        select(FinalsResult).where(FinalsResult.finals_bracket_id == bracket.id)
    ).scalars().all():
        db.delete(result)
    for alliance in db.execute(
        select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)
    ).scalars().all():
        for team_row in db.execute(
            select(BracketAllianceTeam).where(BracketAllianceTeam.bracket_alliance_id == alliance.id)
        ).scalars().all():
            db.delete(team_row)
        db.flush()
        db.delete(alliance)
    db.flush()
    db.delete(bracket)
    db.flush()


def scored_session_ids(db: Session) -> set[int]:
    """The ids of every session with at least one score record."""
    return set(
        db.execute(
            select(Match.session_id)
            .join(Alliance, Alliance.match_id == Match.id)
            .join(ScoreRecord, ScoreRecord.alliance_id == Alliance.id)
            .distinct()
        ).scalars().all()
    )


def session_has_scores(db: Session, session_id: int) -> bool:
    return (
        db.execute(
            select(ScoreRecord.id)
            .join(Alliance, ScoreRecord.alliance_id == Alliance.id)
            .join(Match, Alliance.match_id == Match.id)
            .where(Match.session_id == session_id)
            .limit(1)
        ).first()
        is not None
    )


def delete_session(db: Session, session_obj: TournamentSession) -> bool:
    """Deletes a session and everything scoped to it. Returns whether it was
    the event's active session, which is cleared if so."""
    session_id = session_obj.id
    for bracket in db.execute(
        select(FinalsBracket).where(FinalsBracket.session_id == session_id)
    ).scalars().all():
        delete_finals_bracket(db, bracket)
    delete_matches(db, db.execute(select(Match).where(Match.session_id == session_id)).scalars().all())
    for model in (ScheduleGeneration, Ranking, SessionParticipation, SessionPlayingWindow):
        for row in db.execute(select(model).where(model.session_id == session_id)).scalars().all():
            db.delete(row)
    for field_set in db.execute(
        select(FieldSet).where(FieldSet.session_id == session_id)
    ).scalars().all():
        for field in db.execute(select(Field).where(Field.field_set_id == field_set.id)).scalars().all():
            db.delete(field)
        db.flush()
        db.delete(field_set)
    db.flush()

    event = db.get(Event, session_obj.event_id)
    was_active = event is not None and event.active_session_id == session_id
    if was_active:
        event.active_session_id = None
    db.delete(session_obj)
    db.flush()
    return was_active
