from __future__ import annotations

ROUND_TYPE_LABEL_PREFIX = {"practice": "P", "qualification": "Q"}


def match_label(
    round_type: str,
    match_number: int,
    *,
    finals_bracket_id: int | None,
    bracket_matchup_id: int | None,
    bracket_alliance_id: int | None,
    matchup_number: int | None = None,
) -> str:
    """Computes a match's human-legible label.

    Non-finals matches (finals_bracket_id is None) use round_type's own
    prefix: P1..P24 for practice, Q1..Q132 for qualification, or an
    unknown round type's own first letter uppercased as a fallback.

    Finals matches branch on which finals concept the match belongs to:
    - bracket_matchup_id set: a single_elimination series game, labeled
      "F{matchup_number}-{match_number}" (match_number restarts at 1 per
      matchup -- see services/finals.py's _create_matchup_game).
    - bracket_alliance_id set (no bracket_matchup_id): a score_chase run,
      labeled "F{match_number}" with no per-game suffix -- match_number
      there is already a bracket-wide, worst-seed-first sequential
      counter, so no matchup_number is needed.
    """
    if finals_bracket_id is None:
        prefix = ROUND_TYPE_LABEL_PREFIX.get(round_type, round_type[:1].upper())
        return f"{prefix}{match_number}"
    if bracket_matchup_id is not None:
        if matchup_number is None:
            raise ValueError(
                "matchup_number is required to label a single_elimination "
                "series game"
            )
        return f"F{matchup_number}-{match_number}"
    return f"F{match_number}"
