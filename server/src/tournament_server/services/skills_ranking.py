"""Skills rankings, computed on every read (skills spec 2.3).

Pure: callers pass attempt scores, the plugin's ordered type keys, the tie-break
depth, each session's order and each team's number. One session's attempts give
session rankings; every session's attempts give season rankings, where each team
is represented by its single best session (never a mix of sessions).

A key is a tuple of positions. A present value is (1, value) and a missing one
is (0,), so a missing entry ranks below any score, 0 included, and a shorter
per-type list is a prefix that compares lower.
"""
from __future__ import annotations

import datetime as dt
import re
from collections import defaultdict
from dataclasses import dataclass
from typing import Iterable, Mapping, Sequence

OVERALL = "overall"
_MISSING: tuple = (0,)


def _present(value: int) -> tuple:
    return (1, value)


@dataclass(frozen=True)
class AttemptScore:
    session_id: int
    team_id: int
    skills_type: str
    score: int


@dataclass
class SkillsRankingRow:
    rank: int
    team_id: int
    score: int
    attempts: list[int]
    session_id: int


def session_order_key(session_date: dt.date | None, session_id: int) -> tuple:
    """Earlier sessions sort first: by date (undated ones last), then id."""
    return (session_date is None, session_date or dt.date.min, session_id)


def team_number_sort_key(number: str) -> tuple:
    """Natural order: "9" < "9A" < "10" < "A1"."""
    return tuple(
        (0, int(chunk), "") if chunk[0] in "0123456789" else (1, 0, chunk.lower())
        for chunk in re.findall(r"[0-9]+|[^0-9]+", number)
    )


def _type_lists(attempts: Iterable[AttemptScore]) -> dict[str, list[int]]:
    lists: dict[str, list[int]] = defaultdict(list)
    for attempt in attempts:
        lists[attempt.skills_type].append(attempt.score)
    return {key: sorted(scores, reverse=True) for key, scores in lists.items()}


def _tab_entry(
    lists: dict[str, list[int]], type_keys: Sequence[str], tab: str, depth: int
) -> tuple[tuple, int, list[int]] | None:
    """(key, displayed score, attempts best-first) for one team in one session, or None if unlisted."""
    if tab != OVERALL:
        scores = lists.get(tab)
        if not scores:
            return None
        return tuple(_present(score) for score in scores), scores[0], list(scores)
    if not any(lists.get(key) for key in type_keys):
        return None
    bests = [lists[key][0] if lists.get(key) else None for key in type_keys]
    score = sum(best for best in bests if best is not None)
    key = [_present(score)]
    key += [_MISSING if best is None else _present(best) for best in bests]
    for index in range(1, depth):
        at_depth = [lists[k][index] for k in type_keys if len(lists.get(k, ())) > index]
        key.append(_present(sum(at_depth)) if at_depth else _MISSING)
    flat = [value for k in type_keys for value in lists.get(k, [])]
    return tuple(key), score, flat


def rank_skills(
    attempts: Iterable[AttemptScore],
    type_keys: Sequence[str],
    tab: str,
    depth: int,
    session_order: Mapping[int, tuple],
    team_numbers: Mapping[int, str],
) -> list[SkillsRankingRow]:
    by_team_session: dict[tuple[int, int], list[AttemptScore]] = defaultdict(list)
    for attempt in attempts:
        by_team_session[(attempt.team_id, attempt.session_id)].append(attempt)

    best: dict[int, tuple[tuple, int, int, list[int]]] = {}
    for (team_id, session_id), group in by_team_session.items():
        entry = _tab_entry(_type_lists(group), type_keys, tab, depth)
        if entry is None:
            continue
        key, score, flat = entry
        current = best.get(team_id)
        if (
            current is None
            or key > current[0]
            or (key == current[0] and session_order[session_id] < session_order[current[1]])
        ):
            best[team_id] = (key, session_id, score, flat)

    ordered = sorted(best.items(), key=lambda item: team_number_sort_key(team_numbers.get(item[0], "")))
    ordered.sort(key=lambda item: item[1][0], reverse=True)  # stable: ties keep team-number order

    rows: list[SkillsRankingRow] = []
    previous: tuple | None = None
    rank = 0
    for index, (team_id, (key, session_id, score, flat)) in enumerate(ordered, start=1):
        if key != previous:
            rank, previous = index, key
        rows.append(SkillsRankingRow(rank, team_id, score, flat, session_id))
    return rows
