from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.field import Field
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_result import FinalsResult
from tournament_server.models.match import Match
from tournament_server.models.score_record import ScoreRecord


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


def recompute_finals_results(db: Session, bracket: FinalsBracket, game_plugin) -> None:
    matches = db.execute(
        select(Match).where(
            Match.finals_bracket_id == bracket.id, Match.status == "completed"
        )
    ).scalars().all()

    scores: dict[int, int] = {}
    for match in matches:
        alliance = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().first()
        if alliance is None:
            continue
        score_record = db.execute(
            select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
        ).scalars().first()
        if score_record is None:
            continue
        effective_score = (
            0
            if (score_record.no_show or score_record.dq)
            else game_plugin.module.calculate_score(json.loads(score_record.data_json))
        )
        scores[match.bracket_alliance_id] = effective_score

    if not scores:
        return

    seeds = {
        a.id: a.seed
        for a in db.execute(
            select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)
        ).scalars().all()
    }

    ordered = sorted(
        scores.items(), key=lambda item: (-item[1], seeds[item[0]])
    )

    for rank, (bracket_alliance_id, score) in enumerate(ordered, start=1):
        existing = db.execute(
            select(FinalsResult).where(
                FinalsResult.finals_bracket_id == bracket.id,
                FinalsResult.bracket_alliance_id == bracket_alliance_id,
            )
        ).scalars().first()
        if existing is None:
            db.add(
                FinalsResult(
                    finals_bracket_id=bracket.id,
                    bracket_alliance_id=bracket_alliance_id,
                    score=score,
                    rank=rank,
                )
            )
        else:
            existing.score = score
            existing.rank = rank

    db.commit()


def advance_score_chase(db: Session, bracket: FinalsBracket, game_plugin) -> None:
    recompute_finals_results(db, bracket, game_plugin)

    all_alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed.desc())
    ).scalars().all()
    ran_alliance_ids = {
        m.bracket_alliance_id
        for m in db.execute(
            select(Match).where(Match.finals_bracket_id == bracket.id)
        ).scalars().all()
    }

    remaining = [a for a in all_alliances if a.id not in ran_alliance_ids]
    if remaining:
        create_score_chase_run(db, bracket, remaining[0])
    else:
        bracket.status = "complete"
        db.add(bracket)
        db.commit()
