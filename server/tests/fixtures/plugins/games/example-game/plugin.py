from __future__ import annotations

from typing import Any


def match_format() -> dict[str, Any]:
    return {
        "alliance_count": 2,
        "teams_per_alliance": 2,
        "autonomous_seconds": 15,
        "driver_seconds": 105,
        "round_types": ["practice", "qualification", "elimination"],
        "game_model": "head_to_head",
    }


def scoresheet_schema() -> list[dict[str, Any]]:
    return [
        {
            "name": "high_balls",
            "label": "High Balls",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 20,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "alliance",
            "default": 0,
        },
        {
            "name": "low_balls",
            "label": "Low Balls",
            "data_type": "integer",
            "widget": "counter",
            "min": 0,
            "max": 20,
            "step": 1,
            "options": None,
            "icon": None,
            "scope": "alliance",
            "default": 0,
        },
        {
            "name": "parked",
            "label": "Robot Parked",
            "data_type": "boolean",
            "widget": "toggle",
            "min": None,
            "max": None,
            "step": None,
            "options": None,
            "icon": None,
            "scope": "team",
            "default": False,
        },
        {
            "name": "auto_winner",
            "label": "Autonomous Winner",
            "data_type": "enum",
            "widget": "radio",
            "min": None,
            "max": None,
            "step": None,
            "options": ["red", "blue", "tie"],
            "icon": None,
            "scope": "alliance",
            "default": "tie",
        },
    ]


def calculate_score(scoresheet: dict[str, Any]) -> int:
    score = scoresheet.get("high_balls", 0) * 3 + scoresheet.get("low_balls", 0) * 1
    if scoresheet.get("auto_winner") != "tie":
        score += 10
    return score


def validate(scoresheet: dict[str, Any]) -> list[str]:
    violations = []
    if scoresheet.get("high_balls", 0) > 20:
        violations.append("high_balls cannot exceed 20")
    if scoresheet.get("low_balls", 0) > 20:
        violations.append("low_balls cannot exceed 20")
    return violations


def rank_teams(team_results: list[dict[str, Any]]) -> list[dict[str, Any]]:
    ordered = sorted(
        team_results,
        key=lambda r: (
            -r["win_points"],
            -r["strength_of_schedule"],
            -r["tiebreaker_seed"],
        ),
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
