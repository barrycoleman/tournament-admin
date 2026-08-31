from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.field import Field
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.match import Match


def next_finals_field_id(db: Session, bracket: FinalsBracket) -> int:
    field_ids = [
        f.id
        for f in db.execute(
            select(Field).where(Field.field_set_id == bracket.field_set_id).order_by(Field.id)
        ).scalars().all()
    ]
    field_id = field_ids[bracket.next_field_index % len(field_ids)]
    bracket.next_field_index += 1
    db.add(bracket)
    return field_id


def create_score_chase_run(
    db: Session, bracket: FinalsBracket, bracket_alliance: BracketAlliance
) -> Match:
    field_id = next_finals_field_id(db, bracket)
    existing_run_count = len(
        db.execute(
            select(Match).where(Match.finals_bracket_id == bracket.id)
        ).scalars().all()
    )

    match = Match(
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        round_type="elimination",
        match_number=existing_run_count + 1,
        field_id=field_id,
        finals_bracket_id=bracket.id,
        bracket_alliance_id=bracket_alliance.id,
    )
    db.add(match)
    db.flush()

    alliance = Alliance(match_id=match.id, station="solo")
    db.add(alliance)
    db.flush()

    team_ids = [
        row.team_id
        for row in db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == bracket_alliance.id
            )
        ).scalars().all()
    ]
    for team_id in team_ids:
        db.add(AllianceTeam(alliance_id=alliance.id, team_id=team_id))

    db.commit()
    db.refresh(match)
    return match


def start_score_chase(db: Session, bracket: FinalsBracket) -> None:
    alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed.desc())
    ).scalars().all()
    if alliances:
        create_score_chase_run(db, bracket, alliances[0])
