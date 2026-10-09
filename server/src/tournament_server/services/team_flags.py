"""Per-team DQ and no-show rules.

In practice and qualification a flag removes only that team; the alliance
scores 0 only when every team on it is flagged. In finals one DQ zeroes the
whole alliance, and a no-show team is carried along unless every team on
the alliance is a no-show.
"""
from __future__ import annotations

import json
from typing import TYPE_CHECKING, Iterable, Protocol, Sequence

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import AllianceTeam

if TYPE_CHECKING:
    from tournament_server.models.score_record import ScoreRecord
    from tournament_server.plugin_registry.loader import LoadedPlugin


class TeamFlag(Protocol):
    team_id: int
    no_show: bool
    dq: bool


def flagged_team_ids(flags: Iterable[TeamFlag]) -> set[int]:
    return {flag.team_id for flag in flags if flag.no_show or flag.dq}


def alliance_out(flags: Iterable[TeamFlag], team_ids: Sequence[int], *, finals: bool) -> bool:
    """True when the alliance's score counts as 0."""
    if not team_ids:
        return False
    by_team = {flag.team_id: flag for flag in flags}
    on_alliance = [by_team[team_id] for team_id in team_ids if team_id in by_team]
    if finals:
        if any(flag.dq for flag in on_alliance):
            return True
        return len(on_alliance) == len(team_ids) and all(flag.no_show for flag in on_alliance)
    return len(on_alliance) == len(team_ids) and all(
        flag.no_show or flag.dq for flag in on_alliance
    )


def effective_score(
    plugin: "LoadedPlugin", record: "ScoreRecord", team_ids: Sequence[int], *, finals: bool
) -> int:
    if alliance_out(record.teams, team_ids, finals=finals):
        return 0
    return plugin.module.calculate_score(json.loads(record.data_json))


def alliance_team_ids(db: Session, alliance_id: int) -> list[int]:
    return list(
        db.execute(
            select(AllianceTeam.team_id)
            .where(AllianceTeam.alliance_id == alliance_id)
            .order_by(AllianceTeam.id)
        ).scalars()
    )
