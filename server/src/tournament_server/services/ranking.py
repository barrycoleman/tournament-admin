from __future__ import annotations

import json

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.alliance import Alliance, AllianceTeam
from tournament_server.models.match import Match
from tournament_server.models.ranking import Ranking
from tournament_server.models.score_record import ScoreRecord
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedGamePlugin


def recompute_rankings(
    db: Session, plugin: LoadedGamePlugin, session_id: int, division_id: int | None
) -> None:
    query = select(Match).where(
        Match.session_id == session_id, Match.status == "completed"
    )
    if division_id is None:
        query = query.where(Match.division_id.is_(None))
    else:
        query = query.where(Match.division_id == division_id)
    matches = db.execute(query).scalars().all()

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
