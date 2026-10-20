"""Skills challenges against the database: settings, the plugin's types and
each session's allowed attempts. The pure rules live in skills_rules.py and
the ranking in skills_ranking.py."""
from __future__ import annotations

from collections import Counter
from typing import Any, Iterable

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from tournament_server.models.participation import SessionParticipation
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsAttempt, SkillsSettings
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.services.skills_ranking import AttemptScore, SkillsRankingRow, rank_skills, session_order_key
from tournament_server.services.skills_rules import effective_allowed, skills_depth

SKILLS_OFF_DETAIL = "Skills challenges are turned off for this event."
NO_PLUGIN_DETAIL = "Choose a game plugin before setting up skills challenges."
NO_TYPES_DETAIL = "This game has no skills challenges."
ADMIN_ONLY_DETAIL = "Only an admin can change a submitted skills attempt."
NO_RUN_SECONDS_DETAIL = "This skills type has no run length."


def _usable_run_seconds(value: Any) -> int | None:
    if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
        return None
    return value


def plugin_types(plugin: LoadedPlugin | None) -> list[dict[str, Any]]:
    """The game's skills types in priority order, each with its run length
    (None when the plugin doesn't give a usable one); [] without a plugin."""
    if plugin is None:
        return []
    return [
        {"key": item["key"], "label": item["label"], "run_seconds": _usable_run_seconds(item.get("run_seconds"))}
        for item in plugin.module.skills_types()
    ]


def run_seconds(plugin: LoadedPlugin | None, skills_type: str) -> int | None:
    """One skills type's run length in seconds, or None when there is no
    plugin, no such type, or no usable length; a caller that needs it
    refuses with 409 NO_RUN_SECONDS_DETAIL rather than guessing."""
    for item in plugin_types(plugin):
        if item["key"] == skills_type:
            return item["run_seconds"]
    return None


def find_settings(db: Session, event_id: int) -> SkillsSettings | None:
    return db.execute(
        select(SkillsSettings).where(SkillsSettings.event_id == event_id)
    ).scalars().first()


def is_enabled(db: Session, event_id: int) -> bool:
    settings = find_settings(db, event_id)
    return settings is not None and settings.enabled


def event_attempts(db: Session, event_id: int) -> dict[str, int]:
    settings = find_settings(db, event_id)
    return dict(settings.attempts) if settings is not None else {}


def session_allowed(db: Session, session_obj: TournamentSession, type_keys: list[str]) -> dict[str, int]:
    return effective_allowed(type_keys, event_attempts(db, session_obj.event_id), session_obj.skills_attempts)


def attempt_refusal(
    db: Session, session_obj: TournamentSession, team: Team, skills_type: str, types: dict[str, dict]
) -> str | None:
    """Why `team` can't take another `skills_type` attempt in this session (a
    409 detail), or None. Only submitted attempts count; `types` maps each
    plugin type key to its entry."""
    checked_in = db.execute(
        select(SessionParticipation.id).where(
            SessionParticipation.session_id == session_obj.id,
            SessionParticipation.team_id == team.id,
            SessionParticipation.checked_in.is_(True),
        )
    ).first()
    if checked_in is None:
        return f"Team {team.number} is not checked in for this session."
    allowed = session_allowed(db, session_obj, list(types))[skills_type]
    used = db.execute(
        select(func.count(SkillsAttempt.id)).where(
            SkillsAttempt.session_id == session_obj.id,
            SkillsAttempt.team_id == team.id,
            SkillsAttempt.skills_type == skills_type,
        )
    ).scalar_one()
    if used >= allowed:
        return f"Team {team.number} has used all {allowed} {types[skills_type]['label']} attempts."
    return None



def attempt_numbers(attempts: Iterable[SkillsAttempt]) -> dict[int, int]:
    """attempt id -> its number: 1, 2, 3, ... per team and type, by (recorded_at, id)."""
    seen: Counter[tuple[int, str]] = Counter()
    numbers: dict[int, int] = {}
    for attempt in sorted(attempts, key=lambda a: (a.recorded_at, a.id)):
        seen[(attempt.team_id, attempt.skills_type)] += 1
        numbers[attempt.id] = seen[(attempt.team_id, attempt.skills_type)]
    return numbers


def compute_rankings(
    db: Session, type_keys: list[str], tab: str, sessions: list[TournamentSession]
) -> list[SkillsRankingRow]:
    """Skills rankings over the given sessions' attempts, as the rankings
    endpoint shows them. Awards reuse this."""
    allowed = {s.id: session_allowed(db, s, type_keys) for s in sessions}
    attempts = db.execute(
        select(SkillsAttempt).where(SkillsAttempt.session_id.in_(list(allowed)))
    ).scalars().all()
    team_numbers = {team.id: team.number for team in db.execute(select(Team)).scalars().all()}
    return rank_skills(
        [AttemptScore(a.session_id, a.team_id, a.skills_type, a.score) for a in attempts],
        type_keys,
        tab,
        skills_depth(allowed.values()),
        {s.id: session_order_key(s.session_date, s.id) for s in sessions},
        team_numbers,
    )
