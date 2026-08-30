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
    organization_by_team = {t["team_id"]: t.get("organization") for t in teams}

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

    partner_counts: dict[frozenset[int], int] = {}
    opponent_counts: dict[frozenset[int], int] = {}
    for pair, counts in cross_session_pairing_history.items():
        partner_counts[pair] = counts.get("partner_count", 0)
        opponent_counts[pair] = counts.get("opponent_count", 0)

    def pair_key(a: int, b: int) -> frozenset[int]:
        return frozenset((a, b))

    def group_cost(group: list[int]) -> float:
        cost = 0.0
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]
                key = pair_key(a, b)
                same_alliance = (i // alliance_size) == (j // alliance_size)
                if same_alliance:
                    cost += partner_counts.get(key, 0) * 2
                    org_a = organization_by_team.get(a)
                    org_b = organization_by_team.get(b)
                    if org_a is not None and org_a == org_b:
                        cost += 5
                else:
                    cost += opponent_counts.get(key, 0)
        return cost

    def record_group(group: list[int]) -> None:
        for i in range(len(group)):
            for j in range(i + 1, len(group)):
                a, b = group[i], group[j]
                key = pair_key(a, b)
                same_alliance = (i // alliance_size) == (j // alliance_size)
                if same_alliance:
                    partner_counts[key] = partner_counts.get(key, 0) + 1
                else:
                    opponent_counts[key] = opponent_counts.get(key, 0) + 1

    appearances = {team_id: 0 for team_id in team_ids}
    matches: list[dict[str, Any]] = []
    time_slot = 0
    matches_made = 0
    attempts_per_match = 20

    while matches_made < total_matches:
        used_this_slot: set[int] = set()
        for field_set_id in field_set_ids:
            if matches_made >= total_matches:
                break
            available = [t for t in team_ids if t not in used_this_slot]
            if len(available) < match_size:
                break

            available.sort(key=lambda t: appearances[t])
            pool = available[: min(len(available), match_size * 3)]
            if len(pool) < match_size:
                pool = available

            best_group: list[int] | None = None
            best_cost: float | None = None
            for _ in range(attempts_per_match):
                candidate = random.sample(pool, match_size)
                cost = group_cost(candidate)
                if best_cost is None or cost < best_cost:
                    best_cost = cost
                    best_group = candidate

            chosen = best_group
            record_group(chosen)
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
