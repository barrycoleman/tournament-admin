from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_game_plugin_for_event, get_the_event
from tournament_server.models.bracket_alliance import BracketAlliance, BracketAllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.field_set import FieldSet
from tournament_server.models.finals_bracket import FinalsBracket
from tournament_server.models.ranking import Ranking
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.schemas.finals import (
    BracketAllianceRead,
    FinalsBracketRead,
    FinalsPickRequest,
    FinalsResultRead,
    FinalsRunRead,
    FinalsStartRequest,
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
    return BracketAllianceRead(id=alliance.id, seed=alliance.seed, team_ids=team_ids)


def _to_finals_bracket_read(
    bracket: FinalsBracket, db: Session, game_plugin
) -> FinalsBracketRead:
    alliances = db.execute(
        select(BracketAlliance)
        .where(BracketAlliance.bracket_id == bracket.id)
        .order_by(BracketAlliance.seed)
    ).scalars().all()

    # Match.finals_bracket_id / Match.bracket_alliance_id don't exist as columns
    # until Task 4 adds them, so no Match can be linked to a bracket yet — this
    # task never creates one. `runs` is always empty here; Task 4 replaces this
    # with a real query + score lookup once both columns and run-creation exist.
    runs: list[FinalsRunRead] = []

    return FinalsBracketRead(
        id=bracket.id,
        session_id=bracket.session_id,
        division_id=bracket.division_id,
        field_set_id=bracket.field_set_id,
        format=bracket.format,
        bracket_size=bracket.bracket_size,
        wins_to_advance=bracket.wins_to_advance,
        status=bracket.status,
        alliances=[_to_bracket_alliance_read(a, db) for a in alliances],
        runs=runs,
        results=[],
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

    game_plugin = get_game_plugin_for_event(request, db)
    match_format = game_plugin.module.match_format()
    finals_format = match_format["finals_format"]
    alliance_selection = match_format["alliance_selection"]

    if finals_format == "single_elimination":
        raise HTTPException(
            status_code=422,
            detail=(
                "single_elimination finals are not implemented yet — "
                "only score_chase is supported"
            ),
        )

    if payload.bracket_size < 2:
        raise HTTPException(status_code=422, detail="bracket_size must be at least 2")
    if payload.bracket_size % 2 != 0:
        raise HTTPException(
            status_code=422,
            detail="bracket_size must be even (a finals pair is always 2 teams)",
        )

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
        wins_to_advance=1,
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
