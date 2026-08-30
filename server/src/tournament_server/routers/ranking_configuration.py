from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_db, get_the_event
from tournament_server.models.division import Division
from tournament_server.models.ranking_configuration import RankingConfiguration
from tournament_server.schemas.ranking_configuration import (
    RankingConfigurationRead,
    RankingConfigurationSet,
)

router = APIRouter(prefix="/api/ranking-configuration", tags=["ranking-configuration"])

VALID_MODES = {"exclude", "include"}


@router.post("", response_model=RankingConfigurationRead, status_code=201)
def set_ranking_configuration(
    payload: RankingConfigurationSet, db: Session = Depends(get_db)
) -> RankingConfiguration:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if payload.mode not in VALID_MODES:
        raise HTTPException(
            status_code=422, detail=f"mode must be one of {sorted(VALID_MODES)}"
        )
    if payload.count < 1:
        raise HTTPException(status_code=422, detail="count must be at least 1")
    if payload.division_id is not None and db.get(Division, payload.division_id) is None:
        raise HTTPException(status_code=404, detail="Division not found")

    division_filter = (
        RankingConfiguration.division_id.is_(None)
        if payload.division_id is None
        else RankingConfiguration.division_id == payload.division_id
    )
    existing = db.execute(
        select(RankingConfiguration).where(
            RankingConfiguration.event_id == event.id, division_filter
        )
    ).scalars().first()

    if existing is None:
        config = RankingConfiguration(
            event_id=event.id,
            division_id=payload.division_id,
            mode=payload.mode,
            count=payload.count,
            allow_drop_no_show=payload.allow_drop_no_show,
            allow_drop_dq=payload.allow_drop_dq,
        )
        db.add(config)
    else:
        existing.mode = payload.mode
        existing.count = payload.count
        existing.allow_drop_no_show = payload.allow_drop_no_show
        existing.allow_drop_dq = payload.allow_drop_dq
        config = existing

    db.commit()
    db.refresh(config)
    return config


@router.get("", response_model=RankingConfigurationRead)
def get_ranking_configuration(
    division_id: int | None = Query(None), db: Session = Depends(get_db)
) -> RankingConfiguration:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    division_filter = (
        RankingConfiguration.division_id.is_(None)
        if division_id is None
        else RankingConfiguration.division_id == division_id
    )
    config = db.execute(
        select(RankingConfiguration).where(
            RankingConfiguration.event_id == event.id, division_filter
        )
    ).scalars().first()
    if config is None:
        raise HTTPException(
            status_code=404, detail="No ranking configuration set for this division"
        )
    return config
