from __future__ import annotations

from typing import Any


def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 1,
        "autonomous_seconds": 15,
        "driver_seconds": 90,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "cooperative_score",
    }


def scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "objects_scored",
            "label": "Objects Scored",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 40,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "alliance",
            "default": 0,
        },
    ]


def calculate_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("objects_scored", 0) * 2


def validate(scoresheet: dict[str, Any]) -> list[str]:
    violations = []
    if scoresheet.get("objects_scored", 0) > 40:
        violations.append("objects_scored cannot exceed 40")
    return violations


def rank_teams(team_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(
        team_results,
        key=lambda r: (-r["average_score"], -r["tiebreaker_seed"]),
    )
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]


def skills_scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "objects_scored",
            "label": "Objects Scored",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 30,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "team",
            "default": 0,
        },
    ]


def calculate_skills_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("objects_scored", 0) * 2
