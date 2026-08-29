from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_session_id
from tournament_server.models.ranking import Ranking
from tournament_server.schemas.ranking import RankingRead

router = APIRouter(prefix="/api/rankings", tags=["rankings"])


@router.get("", response_model=list[RankingRead])
def get_rankings(
    session_id: int = Depends(get_session_id),
    division_id: int | None = Query(None),
    db: Session = Depends(get_db),
) -> list[Ranking]:
    query = select(Ranking).where(Ranking.session_id == session_id).order_by(Ranking.rank)
    if division_id is None:
        query = query.where(Ranking.division_id.is_(None))
    else:
        query = query.where(Ranking.division_id == division_id)
    return list(db.execute(query).scalars().all())
