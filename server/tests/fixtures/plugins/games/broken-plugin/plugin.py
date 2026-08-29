from __future__ import annotations

from typing import Any


def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
    }


def scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "points",
            "label": "Points",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 10,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "alliance",
            "default": 0,
        },
    ]


def calculate_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("points", 0)


# validate() is intentionally missing.


def rank_teams(team_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(team_results, key=lambda r: -r["win_points"])
    return [{**r, "rank": i + 1} for i, r in enumerate(ordered)]


def skills_scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "points",
            "label": "Points",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 10,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "team",
            "default": 0,
        },
    ]


def calculate_skills_score(scoresheet: dict[str, Any]) -> int:
    return scoresheet.get("points", 0)
