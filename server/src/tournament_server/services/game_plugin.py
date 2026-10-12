"""Changing an event's game plugin: the in-use lock, the settings reset a change
causes, and the dry-run preview of that reset."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.award import Award
from tournament_server.models.event import Event
from tournament_server.models.match import Match
from tournament_server.models.ranking_settings import RankingSettings
from tournament_server.models.session import TournamentSession
from tournament_server.models.skills import SkillsAttempt
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.schemas.event import AwardNeedingAttention, GamePluginChangePreview, WouldReset
from tournament_server.services import skills as skills_service
from tournament_server.services.awards import PERFORMANCE, availability_error
from tournament_server.services.ranking_rules import RankingRules
from tournament_server.services.ranking_settings import RULE_FIELDS, rules_from_settings

LOCKED_DETAIL = (
    "The game plugin can't be changed after matches are scheduled or skills attempts are recorded."
)


def is_in_use(db: Session) -> bool:
    """A match (scores and finals need one) or a skills attempt exists."""
    return (
        db.execute(select(Match.id).limit(1)).first() is not None
        or db.execute(select(SkillsAttempt.id).limit(1)).first() is not None
    )


def is_locked(db: Session, event: Event) -> bool:
    return event.game_plugin_name is not None and is_in_use(db)


def _ranking_row(db: Session, event_id: int) -> RankingSettings | None:
    return db.execute(
        select(RankingSettings).where(RankingSettings.event_id == event_id)
    ).scalars().first()


def _sessions(db: Session, event_id: int) -> list[TournamentSession]:
    return list(
        db.execute(
            select(TournamentSession).where(TournamentSession.event_id == event_id).order_by(TournamentSession.id)
        ).scalars().all()
    )


def _attention_reason(award: Award, target: LoadedPlugin | None, type_keys: list[str]) -> str | None:
    if award.kind != PERFORMANCE:
        return None
    if target is None:
        return "unavailable"
    if award.source == "skills_type" and award.skills_type not in type_keys:
        return "unknown_skills_type"
    definition = {"kind": award.kind, "scope": award.scope, "source": award.source}
    # The reset turns skills challenges off, so the target state has them off.
    if availability_error(definition, True, False) is not None:
        return "unavailable"
    return None


def preview(db: Session, event: Event, target: LoadedPlugin | None) -> GamePluginChangePreview:
    """What changing to `target` (None clears) would reset; writes nothing."""
    ranking = _ranking_row(db, event.id)
    type_keys = [t["key"] for t in skills_service.plugin_types(target)]
    sessions = _sessions(db, event.id)
    labels = {s.id: s.label for s in sessions}
    attention = []
    for award in db.execute(select(Award).order_by(Award.session_id, Award.position)).scalars().all():
        reason = _attention_reason(award, target, type_keys)
        if reason is not None:
            attention.append(AwardNeedingAttention(
                award_id=award.id, session_id=award.session_id, session_label=labels.get(award.session_id, ""),
                name=award.name, reason=reason,
            ))
    return GamePluginChangePreview(
        would_reset=WouldReset(
            skills_enabled=skills_service.is_enabled(db, event.id),
            session_attempt_overrides=sum(1 for s in sessions if s.skills_attempts is not None),
            ranking_settings=ranking is not None and rules_from_settings(ranking) != RankingRules(),
        ),
        awards_needing_attention=attention,
    )


def empty_preview() -> GamePluginChangePreview:
    return GamePluginChangePreview(
        would_reset=WouldReset(skills_enabled=False, session_attempt_overrides=0, ranking_settings=False),
        awards_needing_attention=[],
    )


def reset_settings(db: Session, event: Event) -> None:
    """Puts every plugin-specific setting back to its default. The caller commits."""
    skills = skills_service.find_settings(db, event.id)
    if skills is not None:
        skills.enabled = False
        skills.attempts = {}
    for session_obj in _sessions(db, event.id):
        session_obj.skills_attempts = None
    ranking = _ranking_row(db, event.id)
    if ranking is not None:
        defaults = RankingRules()
        for name in RULE_FIELDS:
            setattr(ranking, name, getattr(defaults, name))
