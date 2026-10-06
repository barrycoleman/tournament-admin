"""Loading an event's ranking settings as RankingRules, and validating new ones."""
from __future__ import annotations

from dataclasses import fields

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.deps import get_the_event
from tournament_server.models.ranking_settings import RankingSettings
from tournament_server.services.ranking_rules import RankingRules

SESSION_DROP_MODES = ("tiered", "none", "lowest")
RULE_FIELDS = tuple(field.name for field in fields(RankingRules))


def load_ranking_settings(db: Session, event_id: int) -> RankingSettings:
    """The event's settings row, created with the defaults (and flushed) when missing."""
    settings = db.execute(
        select(RankingSettings).where(RankingSettings.event_id == event_id)
    ).scalars().first()
    if settings is None:
        defaults = RankingRules()
        settings = RankingSettings(
            event_id=event_id, **{name: getattr(defaults, name) for name in RULE_FIELDS}
        )
        db.add(settings)
        db.flush()
    return settings


def rules_from_settings(settings: RankingSettings) -> RankingRules:
    return RankingRules(**{name: getattr(settings, name) for name in RULE_FIELDS})


def load_rules(db: Session) -> RankingRules:
    event = get_the_event(db)
    if event is None:
        return RankingRules()
    # Read-only: this runs on the score-save path, where two concurrent first
    # saves inserting a defaults row would collide on the unique event index.
    settings = db.execute(
        select(RankingSettings).where(RankingSettings.event_id == event.id)
    ).scalars().first()
    if settings is None:
        return RankingRules()
    return rules_from_settings(settings)


def settings_error(rules: RankingRules) -> str | None:
    """A readable reason the settings are invalid, or None."""
    if rules.session_drop_mode not in SESSION_DROP_MODES:
        return f"session_drop_mode must be one of: {', '.join(SESSION_DROP_MODES)}"
    if rules.session_drop_count < 1:
        return "session_drop_count must be at least 1"
    if rules.season_keep_best is not None and rules.season_keep_best < 1:
        return "season_keep_best must be at least 1 when set"
    if rules.season_minimum < 0:
        return "season_minimum must be 0 or more"
    if rules.season_keep_best is not None and rules.season_minimum > rules.season_keep_best:
        return "season_minimum cannot be more than season_keep_best"
    return None
