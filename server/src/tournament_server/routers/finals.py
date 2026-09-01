from __future__ import annotations

import json

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_game_plugin_for_event, get_the_event
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.bracket_matchup import BracketMatchup
from tournament_server.models.division import Division
from tournament_server.models.field import Field
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.finals_result import FinalsResult
from tournament_server.models.match import Match
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.finals import (
    BracketAllianceRead,
    BracketMatchupRead,
    FinalsBracketRead,
    FinalsPickRequest,
    FinalsResultRead,
    FinalsRunRead,
    FinalsStartRequest,
)
from tournament_server.services.finals import (
    expand_wins_to_advance,
    generate_bracket,
    mark_unavailable,
    start_score_chase,
    total_rounds_for_bracket_size,
)

router = APIRouter(prefix="/api/finals", tags=["finals"])


def _to_bracket_alliance_read(alliance: BracketAlliance, db: Session) -> BracketAllianceRead:
    team_ids = [
        row.team_id
        for row in db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == alliance.id
            )
        ).scalars().all()
    ]
    return BracketAllianceRead(
        id=alliance.id, seed=alliance.seed, team_ids=team_ids, unavailable=alliance.unavailable
    )


def _to_finals_bracket_read(
    bracket: FinalsBracket, db: Session, game_plugin
) -> FinalsBracketRead:
    alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed)
    ).scalars().all()

    matches = db.execute(
        select(Match).where(Match.finals_bracket_id == bracket.id).order_by(Match.id)
    ).scalars().all()
    runs = []
    for match in matches:
        match_alliance = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().first()
        score = None
        if match_alliance is not None:
            score_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == match_alliance.id)
            ).scalars().first()
            if score_record is not None:
                score = (
                    0
                    if (score_record.no_show or score_record.dq)
                    else game_plugin.module.calculate_score(json.loads(score_record.data_json))
                )
        runs.append(
            FinalsRunRead(
                match_id=match.id,
                bracket_alliance_id=match.bracket_alliance_id,
                status=match.status,
                score=score,
            )
        )

    results = db.execute(
        select(FinalsResult)
        .where(FinalsResult.finals_bracket_id == bracket.id)
        .order_by(FinalsResult.rank)
    ).scalars().all()

    matchups = db.execute(
        select(BracketMatchup)
        .where(BracketMatchup.bracket_id == bracket.id)
        .order_by(BracketMatchup.round_number, BracketMatchup.position)
    ).scalars().all()

    return FinalsBracketRead(
        id=bracket.id,
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        field_set_id=bracket.field_set_id,
        format=bracket.format,
        bracket_size=bracket.bracket_size,
        wins_to_advance=json.loads(bracket.wins_to_advance),
        status=bracket.status,
        alliances=[_to_bracket_alliance_read(a, db) for a in alliances],
        runs=runs,
        results=[
            FinalsResultRead.model_validate(r, from_attributes=True) for r in results
        ],
        matchups=[
            BracketMatchupRead.model_validate(m, from_attributes=True) for m in matchups
        ],
    )


@router.post("/start", response_model=FinalsBracketRead, status_code=201)
def start_finals(
    payload: FinalsStartRequest, request: Request, db: Session = Depends(get_db)
) -> FinalsBracketRead:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if db.get(TournamentSession, payload.session_id) is None:
        raise HTTPException(status_code=404, detail="Session not found")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    existing_bracket_query = select(FinalsBracket).where(
        FinalsBracket.session_id == payload.session_id,
        FinalsBracket.status != "complete",
    )
    if payload.division_id is None:
        existing_bracket_query = existing_bracket_query.where(
            FinalsBracket.division_id.is_(None)
        )
    else:
        existing_bracket_query = existing_bracket_query.where(
            FinalsBracket.division_id == payload.division_id
        )
    if db.execute(existing_bracket_query).scalars().first() is not None:
        raise HTTPException(
            status_code=409,
            detail="A finals bracket is already in progress for this session/division",
        )

    game_plugin = get_game_plugin_for_event(request, db)
    match_format = game_plugin.module.match_format()
    finals_format = match_format["finals_format"]
    alliance_selection = match_format["alliance_selection"]

    if payload.bracket_size < 2:
        raise HTTPException(status_code=422, detail="bracket_size must be at least 2")

    total_rounds = total_rounds_for_bracket_size(payload.bracket_size)
    if finals_format == "single_elimination":
        if payload.wins_to_advance is None:
            raise HTTPException(
                status_code=422,
                detail="wins_to_advance is required for single_elimination",
            )
        try:
            wins_to_advance_list = expand_wins_to_advance(
                payload.wins_to_advance, total_rounds
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc))
    else:
        wins_to_advance_list = [1] * total_rounds

    field_set_id = payload.field_set_id
    if field_set_id is None:
        existing_sets = db.execute(
            select(FieldSet).where(FieldSet.session_id == payload.session_id)
        ).scalars().all()
        if len(existing_sets) == 0:
            raise HTTPException(
                status_code=422, detail="Session has no FieldSets configured"
            )
        if len(existing_sets) > 1:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Multiple FieldSets exist for this session; field_set_id "
                    "must be specified"
                ),
            )
        field_set_id = existing_sets[0].id
    else:
        field_set = db.get(FieldSet, field_set_id)
        if field_set is None or field_set.session_id != payload.session_id:
            raise HTTPException(status_code=404, detail="FieldSet not found")

    field_ids_for_set = db.execute(
        select(Field.id).where(Field.field_set_id == field_set_id)
    ).scalars().all()
    if not field_ids_for_set:
        raise HTTPException(
            status_code=422, detail="This FieldSet has no fields configured"
        )

    if alliance_selection == "captain_pick":
        participation_query = select(SessionParticipation).where(
            SessionParticipation.session_id == payload.session_id,
            SessionParticipation.checked_in.is_(True),
        )
        checked_in_team_ids = [
            row.team_id for row in db.execute(participation_query).scalars().all()
        ]
        eligible_team_query = select(Team).where(Team.id.in_(checked_in_team_ids))
        if payload.division_id is None:
            eligible_team_query = eligible_team_query.where(Team.division_id.is_(None))
        else:
            eligible_team_query = eligible_team_query.where(
                Team.division_id == payload.division_id
            )
        eligible_team_count = len(db.execute(eligible_team_query).scalars().all())
        needed_total_teams = payload.bracket_size * 2
        if eligible_team_count < needed_total_teams:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"Only {eligible_team_count} teams checked into this "
                    f"session, need {needed_total_teams} for a captain_pick "
                    f"bracket of size {payload.bracket_size}"
                ),
            )

    ranking_query = select(Ranking).where(Ranking.session_id == payload.session_id)
    if payload.division_id is None:
        ranking_query = ranking_query.where(Ranking.division_id.is_(None))
    else:
        ranking_query = ranking_query.where(Ranking.division_id == payload.division_id)
    ranking_query = ranking_query.order_by(Ranking.rank)
    ranked = db.execute(ranking_query).scalars().all()

    needed = payload.bracket_size * 2 if alliance_selection == "seed_pairing" else payload.bracket_size
    if len(ranked) < needed:
        raise HTTPException(
            status_code=422,
            detail=f"Only {len(ranked)} ranked teams available, need {needed}",
        )
    top_teams = ranked[:needed]

    bracket = FinalsBracket(
        session_id=payload.session_id,
        division_id=payload.division_id,
        field_set_id=field_set_id,
        format=finals_format,
        bracket_size=payload.bracket_size,
        wins_to_advance=json.dumps(wins_to_advance_list),
        status="selecting_alliances",
    )
    db.add(bracket)
    db.flush()

    if alliance_selection == "seed_pairing":
        for i in range(0, len(top_teams), 2):
            alliance = BracketAlliance(bracket_id=bracket.id, seed=(i // 2) + 1)
            db.add(alliance)
            db.flush()
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=top_teams[i].team_id
                )
            )
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=top_teams[i + 1].team_id
                )
            )
        bracket.status = "in_progress"
        db.commit()
        if bracket.format == "score_chase":
            start_score_chase(db, bracket)
        elif bracket.format == "single_elimination":
            generate_bracket(db, bracket)
    else:
        for i, ranking in enumerate(top_teams):
            alliance = BracketAlliance(bracket_id=bracket.id, seed=i + 1)
            db.add(alliance)
            db.flush()
            db.add(
                BracketAllianceTeam(
                    bracket_alliance_id=alliance.id, team_id=ranking.team_id
                )
            )

    db.commit()
    db.refresh(bracket)
    return _to_finals_bracket_read(bracket, db, game_plugin)


@router.get("/{bracket_id}", response_model=FinalsBracketRead)
def get_finals(
    bracket_id: int, request: Request, db: Session = Depends(get_db)
) -> FinalsBracketRead:
    bracket = db.get(FinalsBracket, bracket_id)
    if bracket is None:
        raise HTTPException(status_code=404, detail="Finals bracket not found")
    game_plugin = get_game_plugin_for_event(request, db)
    return _to_finals_bracket_read(bracket, db, game_plugin)


@router.post("/{bracket_id}/pick", response_model=FinalsBracketRead)
def pick_partner(
    bracket_id: int, payload: FinalsPickRequest, request: Request, db: Session = Depends(get_db)
) -> FinalsBracketRead:
    bracket = db.get(FinalsBracket, bracket_id)
    if bracket is None:
        raise HTTPException(status_code=404, detail="Finals bracket not found")
    if bracket.status != "selecting_alliances":
        raise HTTPException(
            status_code=409, detail="This bracket is not currently selecting alliances"
        )
    field_ids_for_set = db.execute(
        select(Field.id).where(Field.field_set_id == bracket.field_set_id)
    ).scalars().all()
    if not field_ids_for_set:
        raise HTTPException(
            status_code=422, detail="This bracket's FieldSet has no fields configured"
        )

    alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket_id)
        .order_by(BracketAlliance.seed)
    ).scalars().all()

    team_counts: dict[int, int] = {}
    claimed_team_ids: set[int] = set()
    for alliance in alliances:
        rows = db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == alliance.id
            )
        ).scalars().all()
        team_counts[alliance.id] = len(rows)
        for row in rows:
            claimed_team_ids.add(row.team_id)

    pending = [a for a in alliances if team_counts[a.id] < 2]
    if not pending:
        raise HTTPException(
            status_code=409, detail="Every alliance in this bracket already has a partner"
        )
    next_captain = pending[0]
    if payload.captain_bracket_alliance_id != next_captain.id:
        raise HTTPException(
            status_code=422,
            detail=(
                f"It is not this alliance's turn to pick; alliance "
                f"{next_captain.id} (seed {next_captain.seed}) picks next"
            ),
        )

    if payload.partner_team_id in claimed_team_ids:
        raise HTTPException(
            status_code=409, detail="This team is already on a bracket alliance"
        )
    if db.get(Team, payload.partner_team_id) is None:
        raise HTTPException(status_code=404, detail="Team not found")

    db.add(
        BracketAllianceTeam(
            bracket_alliance_id=next_captain.id, team_id=payload.partner_team_id
        )
    )
    db.commit()

    remaining_pending = [
        a
        for a in alliances
        if a.id != next_captain.id
        and team_counts[a.id] < 2
    ]
    if not remaining_pending:
        bracket.status = "in_progress"
        db.commit()
        if bracket.format == "score_chase":
            start_score_chase(db, bracket)
        elif bracket.format == "single_elimination":
            generate_bracket(db, bracket)

    db.refresh(bracket)
    game_plugin = get_game_plugin_for_event(request, db)
    return _to_finals_bracket_read(bracket, db, game_plugin)


@router.post(
    "/{bracket_id}/alliances/{alliance_id}/unavailable", response_model=FinalsBracketRead
)
def mark_alliance_unavailable(
    bracket_id: int, alliance_id: int, request: Request, db: Session = Depends(get_db)
) -> FinalsBracketRead:
    bracket = db.get(FinalsBracket, bracket_id)
    if bracket is None:
        raise HTTPException(status_code=404, detail="Finals bracket not found")
    if bracket.format != "single_elimination":
        raise HTTPException(
            status_code=422,
            detail="Marking an alliance unavailable only applies to single_elimination brackets",
        )
    if bracket.status != "in_progress":
        raise HTTPException(
            status_code=409, detail="This bracket is not currently in progress"
        )
    alliance = db.get(BracketAlliance, alliance_id)
    if alliance is None or alliance.bracket_id != bracket_id:
        raise HTTPException(status_code=404, detail="Alliance not found on this bracket")

    mark_unavailable(db, bracket, alliance)

    db.refresh(bracket)
    game_plugin = get_game_plugin_for_event(request, db)
    return _to_finals_bracket_read(bracket, db, game_plugin)


@router.delete("/{bracket_id}", status_code=204)
def delete_finals(bracket_id: int, db: Session = Depends(get_db)) -> Response:
    bracket = db.get(FinalsBracket, bracket_id)
    if bracket is None:
        raise HTTPException(status_code=404, detail="Finals bracket not found")
    if bracket.status == "complete":
        raise HTTPException(
            status_code=409, detail="Cannot delete a completed finals bracket"
        )

    matches = db.execute(
        select(Match).where(Match.finals_bracket_id == bracket.id)
    ).scalars().all()
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
    db.flush()

    for matchup in db.execute(
        select(BracketMatchup).where(BracketMatchup.bracket_id == bracket.id)
    ).scalars().all():
        db.delete(matchup)

    for result in db.execute(
        select(FinalsResult).where(FinalsResult.finals_bracket_id == bracket.id)
    ).scalars().all():
        db.delete(result)

    bracket_alliances = db.execute(
        select(BracketAlliance).where(BracketAlliance.bracket_id == bracket.id)
    ).scalars().all()
    for alliance in bracket_alliances:
        for team_row in db.execute(
            select(BracketAllianceTeam).where(
                BracketAllianceTeam.bracket_alliance_id == alliance.id
            )
        ).scalars().all():
            db.delete(team_row)
        db.flush()
        db.delete(alliance)

    db.delete(bracket)
    db.commit()
    return Response(status_code=204)
