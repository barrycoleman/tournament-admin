from __future__ import annotations

import random


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
