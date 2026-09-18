from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin, require_any_role
from tournament_server.deps import get_db, get_the_event
from tournament_server.models.alliance import AllianceTeam
from tournament_server.models.bracket_alliance import BracketAllianceTeam
from tournament_server.models.division import Division
from tournament_server.models.participation import SessionParticipation
from tournament_server.models.ranking import Ranking
from tournament_server.models.team import Team
from tournament_server.schemas.team import (
    TeamBulkRequest,
    TeamBulkResponse,
    TeamBulkRow,
    TeamBulkRowResult,
    TeamCreate,
    TeamRead,
    TeamUpdate,
)
from tournament_server.services.team_assignment import assign_sole_division, balanced_assign

router = APIRouter(prefix="/api/teams", tags=["teams"])


@router.post("", response_model=TeamRead, status_code=201)
def create_team(
    payload: TeamCreate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Team:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")
    if payload.division_id is not None:
        if db.get(Division, payload.division_id) is None:
            raise HTTPException(status_code=404, detail="Division not found")
    team = Team(event_id=event.id, **payload.model_dump())
    db.add(team)
    try:
        db.flush()
        assign_sole_division(db, event.id)
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Team number already in use")
    db.refresh(team)
    return team


@router.get("", response_model=list[TeamRead])
def list_teams(
    db: Session = Depends(get_db), _role: str = Depends(require_any_role)
) -> list[Team]:
    return list(db.execute(select(Team)).scalars().all())


@router.get("/{team_id}", response_model=TeamRead)
def get_team(
    team_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_any_role),
) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    return team


@router.patch("/{team_id}", response_model=TeamRead)
def update_team(
    team_id: int,
    payload: TeamUpdate,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Team:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")
    updates = payload.model_dump(exclude_unset=True)
    for required_field in ("number", "name"):
        if required_field in updates and updates[required_field] is None:
            raise HTTPException(
                status_code=422, detail=f"{required_field} cannot be null"
            )
    if "division_id" in updates and updates["division_id"] is not None:
        if db.get(Division, updates["division_id"]) is None:
            raise HTTPException(status_code=404, detail="Division not found")
    for key, value in updates.items():
        setattr(team, key, value)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Team number already in use")
    db.refresh(team)
    return team


@router.delete("/{team_id}", status_code=204)
def delete_team(
    team_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> Response:
    team = db.get(Team, team_id)
    if team is None:
        raise HTTPException(status_code=404, detail="Team not found")

    blockers = []
    if db.execute(
        select(SessionParticipation).where(SessionParticipation.team_id == team_id)
    ).first():
        blockers.append("session participation")
    if db.execute(select(Ranking).where(Ranking.team_id == team_id)).first():
        blockers.append("rankings")
    if db.execute(
        select(AllianceTeam).where(AllianceTeam.team_id == team_id)
    ).first():
        blockers.append("alliance assignments")
    if db.execute(
        select(BracketAllianceTeam).where(BracketAllianceTeam.team_id == team_id)
    ).first():
        blockers.append("bracket alliance assignments")
    if blockers:
        raise HTTPException(
            status_code=409,
            detail=f"Cannot delete team: has existing {', '.join(blockers)}",
        )

    db.delete(team)
    db.commit()
    return Response(status_code=204)


@router.post("/bulk", response_model=TeamBulkResponse)
def bulk_upsert_teams(
    payload: TeamBulkRequest,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> TeamBulkResponse:
    event = get_the_event(db)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not initialized")

    divisions = list(
        db.execute(select(Division).where(Division.event_id == event.id)).scalars().all()
    )
    division_by_lower_name = {division.name.lower(): division for division in divisions}
    division_ids = [division.id for division in divisions]

    running_counts = dict(
        db.execute(
            select(Team.division_id, func.count(Team.id))
            .where(Team.event_id == event.id, Team.division_id.is_not(None))
            .group_by(Team.division_id)
        ).all()
    )
    for division_id in division_ids:
        running_counts.setdefault(division_id, 0)

    results: list[TeamBulkRowResult] = []
    created_or_updated: list[tuple[int, Team]] = []
    for index, row in enumerate(payload.rows):
        if not (row.number or "").strip() or not (row.name or "").strip():
            results.append(
                TeamBulkRowResult(
                    row_index=index, status="error", error="number and name are required"
                )
            )
            continue

        # Match and store the trimmed values: a pasted or CSV-sourced
        # "1234A " would otherwise miss the existing "1234A" and try to
        # create a second team with a visually identical number.
        number = row.number.strip()
        name = row.name.strip()

        division_id: int | None = None
        if row.assign_random_division:
            if not division_ids:
                results.append(
                    TeamBulkRowResult(
                        row_index=index,
                        status="error",
                        error="No divisions exist to randomly assign into",
                    )
                )
                continue
            division_id = balanced_assign([index], division_ids, running_counts)[index]
            running_counts[division_id] += 1
        elif row.division:
            matched = division_by_lower_name.get(row.division.strip().lower())
            if matched is None:
                results.append(
                    TeamBulkRowResult(
                        row_index=index,
                        status="error",
                        error=f"Unknown division: {row.division!r}",
                    )
                )
                continue
            division_id = matched.id

        fields = {
            "name": name,
            "robot_name": row.robot_name,
            "organization": row.organization,
            "city": row.city,
            "state": row.state,
            "country": row.country,
            "division_id": division_id,
        }

        existing = db.execute(
            select(Team).where(Team.event_id == event.id, Team.number == number)
        ).scalars().first()

        if existing is not None:
            for key, value in fields.items():
                setattr(existing, key, value)
            db.flush()
            results.append(
                TeamBulkRowResult(
                    row_index=index, status="updated", team=TeamRead.model_validate(existing)
                )
            )
            created_or_updated.append((len(results) - 1, existing))
        else:
            team = Team(event_id=event.id, number=number, **fields)
            db.add(team)
            db.flush()
            results.append(
                TeamBulkRowResult(
                    row_index=index, status="created", team=TeamRead.model_validate(team)
                )
            )
            created_or_updated.append((len(results) - 1, team))

    assign_sole_division(db, event.id)
    for result_index, orm_team in created_or_updated:
        results[result_index].team = TeamRead.model_validate(orm_team)

    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise HTTPException(status_code=409, detail="Team number already in use")
    return TeamBulkResponse(results=results)
