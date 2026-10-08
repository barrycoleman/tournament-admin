"""A minimal cooperative game that ships with the server.

Two teams play each qualification match together and both receive the
same score, which the referee enters as a single number. Teams rank by
average score; finals pair the ranked teams 1+2, 3+4, ... and each pair
plays one run alone, lowest seed first, highest score winning.

It exists so a fresh install can schedule and score an event without
writing a plugin first, and as a small working example of the game plugin
contract (see server/CLAUDE.md's "Plugin system" section).
"""

from __future__ import annotations

from typing import Any

MAX_SCORE = 999


def match_format() -> dict[str, Any]:
    return {
        # Each team is its own alliance; the core server mirrors a score
        # submitted for one alliance onto the other (cooperative_score), so
        # a no-show or disqualification can still zero just one team.
        "alliance_count": 2,
        "teams_per_alliance": 1,
        "autonomous_seconds": 0,
        "driver_seconds": 60,
        # Finals runs are created with round_type "elimination".
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "cooperative_score",
        "alliance_selection": "seed_pairing",
        "finals_format": "score_chase",
        # A starting point for the Schedule tab: a 60-second match plus
        # time to reset the field and queue the next teams.
        "default_cycle_time_seconds": 300,
    }


def _score_field(scope: str) -> dict[str, Any]:
    return {
        "name": "score",
        "label": "Score",
        "data_type": "integer",
        "widget": "counter",
        "min": 0,
        # Only a typo guard; the game itself has no upper limit.
        "max": MAX_SCORE,
        "step": 1,
        "options": None,
        "icon": None,
        "scope": scope,
        "default": 0,
    }


def scoresheet_schema() -> list[dict[str, Any]]:
    return [_score_field("alliance")]


def calculate_score(scoresheet: dict[str, Any]) -> int:
    return int(scoresheet.get("score", 0))


def validate(scoresheet: dict[str, Any]) -> list[str]:
    score = scoresheet.get("score", 0)
    if score < 0:
        return ["score cannot be negative"]
    if score > MAX_SCORE:
        return [f"score cannot exceed {MAX_SCORE}"]
    return []


def rank_teams(team_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    # Highest average first; ties fall to each team's random tiebreaker seed.
    ordered = sorted(
        team_results,
        key=lambda result: (-result["average_score"], -result["tiebreaker_seed"]),
    )
    return [{**result, "rank": index + 1} for index, result in enumerate(ordered)]


# Skills challenges: one team alone on the field. Autonomous is listed first,
# so its best breaks Overall ties before Driver's (see the skills spec, 2.3).


def skills_types() -> list[dict[str, str]]:
    return [
        {"key": "autonomous", "label": "Autonomous"},
        {"key": "driver", "label": "Driver"},
    ]


def skills_scoresheet_schema(skills_type: str) -> list[dict[str, Any]]:
    # Both types are a single number entered by the referee.
    return [_score_field("team")]


def calculate_skills_score(skills_type: str, scoresheet: dict[str, Any]) -> int:
    return int(scoresheet.get("score", 0))
