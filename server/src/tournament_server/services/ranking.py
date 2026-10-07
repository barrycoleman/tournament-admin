from __future__ import annotations

import json
from collections import defaultdict
from typing import TYPE_CHECKING, Any

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.session import TournamentSession
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.realtime import broadcast_active_session, broadcast_for_session
from tournament_server.services.ranking_rules import (
    MatchRecord,
    RankingRules,
    season_score,
    session_drops,
    session_score,
)
from tournament_server.services.ranking_settings import load_rules

if TYPE_CHECKING:
    from fastapi import FastAPI

# A team's numbers before the plugin orders them, keyed by Ranking column:
# win_points/strength_of_schedule (head-to-head) or
# average_score/matches_played (cooperative).
TeamStats = dict[str, Any]


def _qualification_matches(
    db: Session, session_ids: list[int], division_id: int | None
) -> list[Match]:
    """Every qualification match in scope, in any status. Practice and finals never count."""
    if not session_ids:
        return []
    query = select(Match).where(
        Match.session_id.in_(session_ids),
        Match.finals_bracket_id.is_(None),
        Match.round_type != "practice",
    )
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    return list(db.execute(query.order_by(Match.id)).scalars().all())


_IN_CHUNK = 500  # stay well under SQLite's bound-parameter limit


def _chunks(ids: list[int]):
    for start in range(0, len(ids), _IN_CHUNK):
        yield ids[start : start + _IN_CHUNK]


class _ScopeData:
    """A scope's alliances, their teams and score records, loaded in three IN queries
    instead of per-match lookups."""

    def __init__(self, db: Session, matches: list[Match]) -> None:
        self.alliances: dict[int, list[Alliance]] = defaultdict(list)
        self.team_ids: dict[int, list[int]] = defaultdict(list)
        self.records: dict[int, ScoreRecord] = {}
        alliance_ids: list[int] = []
        for chunk in _chunks([match.id for match in matches]):
            for alliance in db.execute(
                select(Alliance).where(Alliance.match_id.in_(chunk)).order_by(Alliance.id)
            ).scalars():
                self.alliances[alliance.match_id].append(alliance)
                alliance_ids.append(alliance.id)
        for chunk in _chunks(alliance_ids):
            for row in db.execute(
                select(AllianceTeam)
                .where(AllianceTeam.alliance_id.in_(chunk))
                .order_by(AllianceTeam.id)
            ).scalars():
                self.team_ids[row.alliance_id].append(row.team_id)
            for record in db.execute(
                select(ScoreRecord)
                .where(ScoreRecord.alliance_id.in_(chunk))
                .order_by(ScoreRecord.id)
            ).scalars():
                self.records.setdefault(record.alliance_id, record)


def _effective_score(plugin: LoadedPlugin, record: ScoreRecord) -> int:
    if record.no_show or record.dq:
        return 0
    return plugin.module.calculate_score(json.loads(record.data_json))


def _scheduled_counts(
    data: _ScopeData, matches: list[Match]
) -> dict[tuple[int, int], int]:
    """(session_id, team_id) -> qualification matches the team is scheduled into, in any status."""
    counts: dict[tuple[int, int], int] = defaultdict(int)
    for match in matches:
        for alliance in data.alliances[match.id]:
            for team_id in data.team_ids[alliance.id]:
                counts[(match.session_id, team_id)] += 1
    return counts


def _cooperative_records(
    data: _ScopeData, plugin: LoadedPlugin, matches: list[Match]
) -> dict[int, list[MatchRecord]]:
    records: dict[int, list[MatchRecord]] = defaultdict(list)
    for match in matches:
        if match.status != "completed":
            continue
        for alliance in data.alliances[match.id]:
            score_record = data.records.get(alliance.id)
            if score_record is None:
                continue
            record = MatchRecord(
                match_id=match.id,
                session_id=match.session_id,
                score=_effective_score(plugin, score_record),
                no_show=score_record.no_show,
                dq=score_record.dq,
            )
            for team_id in data.team_ids[alliance.id]:
                records[team_id].append(record)
    return records


def _cooperative_session_stats(
    data: _ScopeData, plugin: LoadedPlugin, matches: list[Match], rules: RankingRules
) -> dict[int, TeamStats]:
    scheduled = _scheduled_counts(data, matches)
    stats: dict[int, TeamStats] = {}
    for team_id, records in _cooperative_records(data, plugin, matches).items():
        dropped = session_drops(records, scheduled[(records[0].session_id, team_id)], rules)
        stats[team_id] = {
            "average_score": session_score(records, dropped),
            "matches_played": len(records),
        }
    return stats


def _cooperative_season_stats(
    data: _ScopeData, plugin: LoadedPlugin, matches: list[Match], rules: RankingRules
) -> dict[int, TeamStats]:
    scheduled = _scheduled_counts(data, matches)
    stats: dict[int, TeamStats] = {}
    for team_id, records in _cooperative_records(data, plugin, matches).items():
        session_dropped: set[int] = set()
        if rules.season_only_session_counted:
            by_session: dict[int, list[MatchRecord]] = defaultdict(list)
            for record in records:
                by_session[record.session_id].append(record)
            for session_id, session_records in by_session.items():
                session_dropped |= session_drops(
                    session_records, scheduled[(session_id, team_id)], rules
                )
        stats[team_id] = {
            "average_score": season_score(records, session_dropped, rules),
            "matches_played": len(records),
        }
    return stats


def _head_to_head_stats(
    data: _ScopeData, plugin: LoadedPlugin, matches: list[Match]
) -> dict[int, TeamStats]:
    """Win points (2/1/0) and strength of schedule (opponents' win points) over `matches`."""
    win_points: dict[int, int] = {}
    played: list[tuple[list[int], list[int]]] = []
    for match in matches:
        if match.status != "completed":
            continue
        alliances = data.alliances[match.id]
        if len(alliances) != 2:
            continue
        sides: list[list[int]] = []
        scores: list[int] = []
        for alliance in alliances:
            record = data.records.get(alliance.id)
            if record is None:
                break
            sides.append(data.team_ids[alliance.id])
            scores.append(_effective_score(plugin, record))
        if len(scores) != 2:
            continue
        if scores[0] > scores[1]:
            points = (2, 0)
        elif scores[1] > scores[0]:
            points = (0, 2)
        else:
            points = (1, 1)
        for side, side_points in zip(sides, points):
            for team_id in side:
                win_points[team_id] = win_points.get(team_id, 0) + side_points
        played.append((sides[0], sides[1]))

    strength = {team_id: 0.0 for team_id in win_points}
    for side_a, side_b in played:
        for team_id in side_a:
            strength[team_id] += sum(win_points[t] for t in side_b)
        for team_id in side_b:
            strength[team_id] += sum(win_points[t] for t in side_a)
    return {
        team_id: {"win_points": win_points[team_id], "strength_of_schedule": strength[team_id]}
        for team_id in win_points
    }


def _stats(
    db: Session, plugin: LoadedPlugin, matches: list[Match], *, season: bool
) -> dict[int, TeamStats]:
    data = _ScopeData(db, matches)
    if plugin.module.match_format()["game_model"] == "cooperative_score":
        rules = load_rules(db)
        if season:
            return _cooperative_season_stats(data, plugin, matches, rules)
        return _cooperative_session_stats(data, plugin, matches, rules)
    return _head_to_head_stats(data, plugin, matches)


def _replace_rankings(
    db: Session,
    plugin: LoadedPlugin,
    session_id: int | None,
    division_id: int | None,
    stats: dict[int, TeamStats],
) -> None:
    """Replace the scope's rows with the plugin-ordered `stats`; a team with no
    qualifying match in scope ends up with no row."""
    session_filter = (
        Ranking.session_id.is_(None) if session_id is None else Ranking.session_id == session_id
    )
    division_filter = (
        Ranking.division_id.is_(None) if division_id is None else Ranking.division_id == division_id
    )
    db.execute(delete(Ranking).where(session_filter, division_filter))
    if stats:
        seeds = {
            team.id: team.tiebreaker_seed
            for team in db.execute(select(Team).where(Team.id.in_(list(stats)))).scalars().all()
        }
        team_results = [
            {"team_id": team_id, **values, "tiebreaker_seed": seeds[team_id]}
            for team_id, values in stats.items()
        ]
        for entry in plugin.module.rank_teams(team_results):
            db.add(
                Ranking(
                    session_id=session_id,
                    division_id=division_id,
                    team_id=entry["team_id"],
                    rank=entry["rank"],
                    **stats[entry["team_id"]],
                )
            )
    db.commit()


def recompute_rankings(
    app: "FastAPI", db: Session, plugin: LoadedPlugin, session_id: int, division_id: int | None
) -> None:
    matches = _qualification_matches(db, [session_id], division_id)
    _replace_rankings(db, plugin, session_id, division_id, _stats(db, plugin, matches, season=False))
    broadcast_for_session(
        app, db, session_id, "ranking_updated",
        {"session_id": session_id, "division_id": division_id, "event_wide": False},
    )


def recompute_event_rankings(
    app: "FastAPI", db: Session, plugin: LoadedPlugin, event_id: int, division_id: int | None
) -> None:
    """The season standings: every session's qualification matches, for both game models."""
    session_ids = [
        row.id
        for row in db.execute(
            select(TournamentSession).where(TournamentSession.event_id == event_id)
        ).scalars().all()
    ]
    matches = _qualification_matches(db, session_ids, division_id)
    _replace_rankings(db, plugin, None, division_id, _stats(db, plugin, matches, season=True))
    broadcast_active_session(
        app, "ranking_updated",
        {"session_id": None, "division_id": division_id, "event_wide": True},
    )


def recompute_all_rankings(
    app: "FastAPI", db: Session, plugin: LoadedPlugin, event_id: int
) -> None:
    """Every session's rankings, then the season's, for each division with qualification matches.

    Called after the ranking settings change.
    """
    session_ids = select(TournamentSession.id).where(TournamentSession.event_id == event_id)
    scopes = db.execute(
        select(Match.session_id, Match.division_id)
        .where(
            Match.session_id.in_(session_ids),
            Match.finals_bracket_id.is_(None),
            Match.round_type != "practice",
        )
        .distinct()
        .order_by(Match.session_id, Match.division_id)
    ).all()
    for session_id, division_id in scopes:
        recompute_rankings(app, db, plugin, session_id, division_id)
    for division_id in dict.fromkeys(division_id for _, division_id in scopes):
        recompute_event_rankings(app, db, plugin, event_id, division_id)
