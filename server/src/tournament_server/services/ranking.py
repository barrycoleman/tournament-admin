from __future__ import annotations

import json
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_the_event
from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.ranking_configuration import RankingConfiguration
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin


def suggest_exclusion_count(total_matches: int) -> int:
    if total_matches >= 16:
        return 4
    if total_matches >= 12:
        return 3
    if total_matches >= 8:
        return 2
    if total_matches >= 4:
        return 1
    return 0


def _compute_average_score(
    match_records: list[dict[str, Any]], config: Any
) -> tuple[float, int]:
    matches_played = len(match_records)
    if matches_played == 0:
        return 0.0, 0

    scores = [r["score"] for r in match_records]

    if config is None:
        return sum(scores) / matches_played, matches_played

    return _apply_ranking_configuration(match_records, scores, config), matches_played


def _apply_ranking_configuration(
    match_records: list[dict[str, Any]], scores: list[int], config: Any
) -> float:
    def droppable(record: dict[str, Any]) -> bool:
        if not record["no_show"] and not record["dq"]:
            return True
        if record["no_show"] and config.allow_drop_no_show:
            return True
        if record["dq"] and config.allow_drop_dq:
            return True
        return False

    if config.mode == "exclude":
        indices_by_score_asc = sorted(range(len(scores)), key=lambda i: scores[i])
        dropped: set[int] = set()
        for i in indices_by_score_asc:
            if len(dropped) >= config.count:
                break
            if droppable(match_records[i]):
                dropped.add(i)
        remaining = [scores[i] for i in range(len(scores)) if i not in dropped]
        if not remaining:
            return 0.0
        return sum(remaining) / len(remaining)

    # include mode: keep the top `count`, zero-pad the shortfall.
    kept = sorted(scores, reverse=True)[: config.count]
    total = sum(kept)
    return total / config.count


def _compute_cooperative_score_team_results(
    db: Session, plugin: LoadedPlugin, matches: list[Match], config: Any
) -> list[dict[str, Any]]:
    team_match_records: dict[int, list[dict[str, Any]]] = {}

    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        for alliance in alliances:
            score_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
            ).scalars().first()
            if score_record is None:
                continue
            effective_score = (
                0
                if (score_record.no_show or score_record.dq)
                else plugin.module.calculate_score(json.loads(score_record.data_json))
            )
            team_ids = [
                row.team_id
                for row in db.execute(
                    select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
                ).scalars().all()
            ]
            for team_id in team_ids:
                team_match_records.setdefault(team_id, []).append(
                    {
                        "score": effective_score,
                        "no_show": score_record.no_show,
                        "dq": score_record.dq,
                    }
                )

    if not team_match_records:
        return []

    team_ids = list(team_match_records.keys())
    teams = {
        team.id: team
        for team in db.execute(select(Team).where(Team.id.in_(team_ids))).scalars().all()
    }

    team_results = []
    for team_id, records in team_match_records.items():
        average_score, matches_played = _compute_average_score(records, config)
        team_results.append(
            {
                "team_id": team_id,
                "average_score": average_score,
                "matches_played": matches_played,
                "tiebreaker_seed": teams[team_id].tiebreaker_seed,
            }
        )
    return team_results


def recompute_rankings(
    db: Session, plugin: LoadedPlugin, session_id: int, division_id: int | None
) -> None:
    game_model = plugin.module.match_format()["game_model"]

    query = select(Match).where(
        Match.session_id == session_id, Match.status == "completed"
    )
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    matches = db.execute(query).scalars().all()

    if game_model == "cooperative_score":
        event = get_the_event(db)
        config = None
        if event is not None:
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
        team_results = _compute_cooperative_score_team_results(db, plugin, matches, config)
        if not team_results:
            return
        ranked = plugin.module.rank_teams(team_results)
        for entry in ranked:
            division_filter = (
                Ranking.division_id.is_(None)
                if division_id is None
                else Ranking.division_id == division_id
            )
            existing = db.execute(
                select(Ranking).where(
                    Ranking.session_id == session_id,
                    division_filter,
                    Ranking.team_id == entry["team_id"],
                )
            ).scalars().first()
            if existing is None:
                db.add(
                    Ranking(
                        session_id=session_id,
                        division_id=division_id,
                        team_id=entry["team_id"],
                        average_score=entry["average_score"],
                        matches_played=entry["matches_played"],
                        rank=entry["rank"],
                    )
                )
            else:
                existing.average_score = entry["average_score"]
                existing.matches_played = entry["matches_played"]
                existing.rank = entry["rank"]
        db.commit()
        return

    win_points: dict[int, int] = {}
    match_alliance_teams: dict[int, dict[int, list[int]]] = {}

    for match in matches:
        alliances = db.execute(
            select(Alliance).where(Alliance.match_id == match.id)
        ).scalars().all()
        if len(alliances) != 2:
            continue

        alliance_teams: dict[int, list[int]] = {}
        alliance_scores: dict[int, int] = {}
        incomplete = False
        for alliance in alliances:
            team_ids = [
                row.team_id
                for row in db.execute(
                    select(AllianceTeam).where(AllianceTeam.alliance_id == alliance.id)
                )
                .scalars()
                .all()
            ]
            alliance_teams[alliance.id] = team_ids

            score_record = db.execute(
                select(ScoreRecord).where(ScoreRecord.alliance_id == alliance.id)
            ).scalars().first()
            if score_record is None:
                incomplete = True
                break
            if score_record.no_show or score_record.dq:
                alliance_scores[alliance.id] = 0
            else:
                alliance_scores[alliance.id] = plugin.module.calculate_score(
                    json.loads(score_record.data_json)
                )
        if incomplete:
            continue

        alliance_ids = list(alliance_teams.keys())
        score_a = alliance_scores[alliance_ids[0]]
        score_b = alliance_scores[alliance_ids[1]]
        if score_a > score_b:
            points = {alliance_ids[0]: 2, alliance_ids[1]: 0}
        elif score_b > score_a:
            points = {alliance_ids[0]: 0, alliance_ids[1]: 2}
        else:
            points = {alliance_ids[0]: 1, alliance_ids[1]: 1}

        for alliance_id, team_ids in alliance_teams.items():
            for team_id in team_ids:
                win_points[team_id] = win_points.get(team_id, 0) + points[alliance_id]

        match_alliance_teams[match.id] = alliance_teams

    if not win_points:
        return

    strength_of_schedule: dict[int, float] = {team_id: 0.0 for team_id in win_points}
    for alliance_teams in match_alliance_teams.values():
        alliance_ids = list(alliance_teams.keys())
        teams_a = alliance_teams[alliance_ids[0]]
        teams_b = alliance_teams[alliance_ids[1]]
        opponent_points_for_a = sum(win_points.get(t, 0) for t in teams_b)
        opponent_points_for_b = sum(win_points.get(t, 0) for t in teams_a)
        for team_id in teams_a:
            strength_of_schedule[team_id] += opponent_points_for_a
        for team_id in teams_b:
            strength_of_schedule[team_id] += opponent_points_for_b

    team_ids = list(win_points.keys())
    teams = {
        team.id: team
        for team in db.execute(select(Team).where(Team.id.in_(team_ids))).scalars().all()
    }

    team_results = [
        {
            "team_id": team_id,
            "win_points": win_points[team_id],
            "strength_of_schedule": strength_of_schedule[team_id],
            "tiebreaker_seed": teams[team_id].tiebreaker_seed,
        }
        for team_id in team_ids
    ]

    ranked = plugin.module.rank_teams(team_results)

    for entry in ranked:
        division_filter = (
            Ranking.division_id.is_(None)
            if division_id is None
            else Ranking.division_id == division_id
        )
        existing = db.execute(
            select(Ranking).where(
                Ranking.session_id == session_id,
                division_filter,
                Ranking.team_id == entry["team_id"],
            )
        ).scalars().first()
        if existing is None:
            db.add(
                Ranking(
                    session_id=session_id,
                    division_id=division_id,
                    team_id=entry["team_id"],
                    win_points=entry["win_points"],
                    strength_of_schedule=entry["strength_of_schedule"],
                    rank=entry["rank"],
                )
            )
        else:
            existing.win_points = entry["win_points"]
            existing.strength_of_schedule = entry["strength_of_schedule"]
            existing.rank = entry["rank"]

    db.commit()
