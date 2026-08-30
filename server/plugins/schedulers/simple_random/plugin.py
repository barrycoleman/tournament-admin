from __future__ import annotations

import random
from typing import Any


def generate_schedule(
    teams: list[dict[str, Any]],
    target_matches_per_team: int,
    teams_per_alliance: int,
    fields: list[dict[str, Any]],
    field_sets: list[dict[str, Any]],
    cross_session_pairing_history: dict[Any, dict[str, int]],
    constraints: dict[str, Any],
) -> list[dict[str, Any]]:
    excluded = set(constraints.get("excluded_team_ids", []))
    team_ids = [t["team_id"] for t in teams if t["team_id"] not in excluded]

    alliance_size = teams_per_alliance
    match_size = alliance_size * 2
    if len(team_ids) < match_size:
        return []

    field_set_ids = sorted({fs["field_set_id"] for fs in field_sets})
    if not field_set_ids:
        return []

    total_matches = (len(team_ids) * target_matches_per_team) // match_size
    if total_matches < 1:
        return []

    appearances = {team_id: 0 for team_id in team_ids}
    matches: list[dict[str, Any]] = []
    time_slot = 0
    matches_made = 0

    while matches_made < total_matches:
        used_this_slot: set[int] = set()
        for field_set_id in field_set_ids:
            if matches_made >= total_matches:
                break
            available = [t for t in team_ids if t not in used_this_slot]
            if len(available) < match_size:
                break

            available.sort(key=lambda t: (appearances[t], random.random()))
            chosen = available[:match_size]
            random.shuffle(chosen)
            for team_id in chosen:
                appearances[team_id] += 1
                used_this_slot.add(team_id)

            alliances = []
            remaining = list(chosen)
            for station in ("red", "blue"):
                alliances.append(
                    {"station": station, "team_ids": remaining[:alliance_size]}
                )
                remaining = remaining[alliance_size:]

            matches.append(
                {
                    "time_slot": time_slot,
                    "field_set_id": field_set_id,
                    "alliances": alliances,
                }
            )
            matches_made += 1

        if not used_this_slot:
            break
        time_slot += 1

    return matches
