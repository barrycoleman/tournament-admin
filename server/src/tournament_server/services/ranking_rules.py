"""Pure ranking rules: which of a team's cooperative matches are dropped and counted.

No database access and no plugin calls, so every rule is unit-tested directly.
services/ranking.py gathers the records, calls these, and writes the rows.
"""
from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class MatchRecord:
    """One team's result in one completed qualification match."""

    match_id: int
    session_id: int
    score: int  # already 0 for a no-show or DQ
    no_show: bool = False
    dq: bool = False


@dataclass(frozen=True)
class RankingRules:
    """An event's ranking settings; the defaults give a plain average with tiered session drops."""

    session_drop_mode: str = "tiered"  # tiered | none | lowest
    session_drop_count: int = 1
    session_drop_no_show: bool = False
    session_drop_dq: bool = False
    season_keep_best: int | None = None
    season_only_session_counted: bool = False
    season_minimum: int = 0
    season_drop_no_show: bool = False
    season_drop_dq: bool = False


def suggest_exclusion_count(scheduled: int) -> int:
    """The tier table, applied to a team's scheduled qualification matches."""
    if scheduled >= 16:
        return 4
    if scheduled >= 12:
        return 3
    if scheduled >= 8:
        return 2
    if scheduled >= 4:
        return 1
    return 0


def _droppable(record: MatchRecord, allow_no_show: bool, allow_dq: bool) -> bool:
    if record.no_show and not allow_no_show:
        return False
    if record.dq and not allow_dq:
        return False
    return True


def session_drop_allowance(scheduled: int, rules: RankingRules) -> int:
    if rules.session_drop_mode == "none":
        return 0
    if rules.session_drop_mode == "lowest":
        return rules.session_drop_count
    return suggest_exclusion_count(scheduled)


def session_drops(records: list[MatchRecord], scheduled: int, rules: RankingRules) -> set[int]:
    """Match ids dropped from one team's ranking in one session.

    Drops are earned only as the last `allowance` scheduled matches are
    scored, and a team's last record is never dropped.
    """
    allowance = session_drop_allowance(scheduled, rules)
    earned = min(allowance, max(0, len(records) - (scheduled - allowance)))
    earned = min(earned, max(0, len(records) - 1))
    dropped: set[int] = set()
    for record in sorted(records, key=lambda r: (r.score, r.match_id)):
        if len(dropped) >= earned:
            break
        if _droppable(record, rules.session_drop_no_show, rules.session_drop_dq):
            dropped.add(record.match_id)
    return dropped


def session_score(records: list[MatchRecord], dropped: set[int]) -> float:
    kept = [r.score for r in records if r.match_id not in dropped]
    return sum(kept) / len(kept) if kept else 0.0


def season_score(
    records: list[MatchRecord], session_dropped: set[int], rules: RankingRules
) -> float:
    """One team's season score across every session.

    `session_dropped` holds the match ids its sessions dropped; they leave the
    pool only when `season_only_session_counted` is on, and never when the
    season protects that zero. Forced zeroes fill the N slots first; the
    divisor is never below `season_minimum`.
    """

    def season_droppable(record: MatchRecord) -> bool:
        return _droppable(record, rules.season_drop_no_show, rules.season_drop_dq)

    pool = [
        r
        for r in records
        if not (
            rules.season_only_session_counted
            and r.match_id in session_dropped
            and season_droppable(r)
        )
    ]
    if rules.season_keep_best is None:
        kept = pool
    else:
        forced = sorted((r for r in pool if not season_droppable(r)), key=lambda r: r.match_id)
        others = sorted((r for r in pool if season_droppable(r)), key=lambda r: (-r.score, r.match_id))
        kept = forced[: rules.season_keep_best]
        kept = kept + others[: rules.season_keep_best - len(kept)]
    divisor = max(len(kept), rules.season_minimum)
    return sum(r.score for r in kept) / divisor if divisor else 0.0
