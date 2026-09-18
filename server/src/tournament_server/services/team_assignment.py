from __future__ import annotations

import random

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.division import Division
from tournament_server.models.team import Team


def balanced_assign(
    team_ids: list[int],
    division_ids: list[int],
    current_counts: dict[int, int],
) -> dict[int, int]:
    """Assigns each id in `team_ids` to one of `division_ids`, keeping
    resulting division sizes as even as possible (differing by at most
    1) regardless of how unevenly `current_counts` started.

    Shuffles both the team order (so *which* team lands where is random)
    and the division order (so ties -- multiple divisions equally
    under-populated at some point in the walk -- are broken randomly
    rather than always favoring the first-listed division). Each team is
    then assigned, in shuffled order, to whichever division currently
    has the fewest teams, with a running count updated after each
    assignment so later picks in the same call see earlier ones.
    """
    shuffled_teams = list(team_ids)
    random.shuffle(shuffled_teams)
    shuffled_divisions = list(division_ids)
    random.shuffle(shuffled_divisions)

    counts = {division_id: current_counts.get(division_id, 0) for division_id in division_ids}

    assignments: dict[int, int] = {}
    for team_id in shuffled_teams:
        target = min(shuffled_divisions, key=lambda division_id: counts[division_id])
        assignments[team_id] = target
        counts[target] += 1
    return assignments


def assign_sole_division(db: Session, event_id: int) -> int:
    """No-op unless `event_id` has exactly one division, in which case
    every currently-unassigned team in that event is assigned to it.

    Exists so a team never sits divisionless -- and that division's team
    count never reads misleadingly low -- purely because nothing
    explicitly picked a division for it, in the common case where there
    is only one division to begin with and the choice is not actually a
    choice. Does not commit; the caller's own transaction does. Deliberately
    scoped to *implicit* divisionless-ness only: it must never run as part
    of `PATCH /api/teams/{id}` handling an explicit `division_id: null`,
    which is a real admin action to unassign a team and must stick.
    """
    division_ids = list(
        db.execute(select(Division.id).where(Division.event_id == event_id)).scalars().all()
    )
    if len(division_ids) != 1:
        return 0
    sole_division_id = division_ids[0]

    unassigned_teams = list(
        db.execute(
            select(Team).where(Team.event_id == event_id, Team.division_id.is_(None))
        ).scalars().all()
    )
    for team in unassigned_teams:
        team.division_id = sole_division_id
    db.flush()
    return len(unassigned_teams)
