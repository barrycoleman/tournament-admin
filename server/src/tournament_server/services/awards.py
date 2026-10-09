"""Award rules against the database: definition validation, a slot's
divisions, and a slot's status and winners. Sources live in award_sources.py."""
from __future__ import annotations

from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.award import Award, AwardWinner
from tournament_server.models.division import Division
from tournament_server.models.team import Team
from tournament_server.plugin_registry.loader import LoadedPlugin
from tournament_server.services.award_sources import SOURCES, resolve

JUDGED = "judged"
PERFORMANCE = "performance"
EVENT = "event"
DIVISION = "division"
ORIGIN_JUDGED = "judged"
ORIGIN_OVERRIDE = "override"
ORIGIN_FINALIZED = "finalized"
BASES = ("session", "season")
# Sources whose results never cross divisions.
DIVISION_ONLY_SOURCES = ("teamwork_ranking", "finals")
RULE_FIELDS = ("kind", "scope", "division_ids", "source", "skills_type", "basis", "placement")
LOCKED_DETAIL = "Unfinalize awards to make changes."
NAME_MAX = 200
DESCRIPTION_MAX = 2000


def definition_error(d: dict, event_division_ids: set[int]) -> str | None:
    """Why a (normalized) definition is invalid, or None."""
    if not d["name"]:
        return "An award needs a name."
    if len(d["name"]) > NAME_MAX:
        return f"An award name can be at most {NAME_MAX} characters."
    if d["description"] is not None and len(d["description"]) > DESCRIPTION_MAX:
        return f"A description can be at most {DESCRIPTION_MAX} characters."
    if d["kind"] not in (JUDGED, PERFORMANCE):
        return "kind must be 'judged' or 'performance'."
    if d["scope"] not in (EVENT, DIVISION):
        return "scope must be 'event' or 'division'."
    if d["scope"] == EVENT and d["division_ids"]:
        return "An event-wide award has no divisions."
    unknown = [i for i in d["division_ids"] if i not in event_division_ids]
    if unknown:
        return f"Unknown division ids: {unknown}."
    if len(set(d["division_ids"])) != len(d["division_ids"]):
        return "A division is listed twice."
    if d["kind"] == JUDGED:
        if any(d[k] is not None for k in ("source", "skills_type", "basis", "placement")):
            return "A judged award has no source, skills type, basis or placement."
        return None
    if d["source"] not in SOURCES:
        return f"source must be one of {sorted(SOURCES)}."
    if d["basis"] not in BASES:
        return "basis must be 'session' or 'season'."
    if d["placement"] is None or d["placement"] < 1:
        return "placement must be 1 or more."
    if (d["source"] == "skills_type") != (d["skills_type"] is not None):
        return "skills_type is required for, and only allowed with, the skills_type source."
    if d["source"] in DIVISION_ONLY_SOURCES and d["scope"] != DIVISION:
        return "Teamwork ranking and finals awards are per division."
    if d["source"] == "finals" and d["basis"] != "session":
        return "Finals awards use the session's finals."
    return None


def normalized(d: dict) -> dict:
    """Trims the name and description; an empty description becomes None."""
    out = dict(d)
    out["name"] = (out.get("name") or "").strip()
    description = (out.get("description") or "").strip()
    out["description"] = description or None
    out["division_ids"] = list(out.get("division_ids") or [])
    return out


def event_division_ids(db: Session) -> list[int]:
    return list(db.execute(select(Division.id).order_by(Division.id)).scalars().all())


def slot_division_ids(db: Session, award: Award) -> list[int | None]:
    if award.scope == EVENT:
        return [None]
    all_ids = event_division_ids(db)
    if not award.division_ids:
        return all_ids
    return [i for i in all_ids if i in award.division_ids]


def session_awards(db: Session, session_id: int) -> list[Award]:
    return list(
        db.execute(
            select(Award).where(Award.session_id == session_id).order_by(Award.position, Award.id)
        ).scalars().all()
    )


def stored_winners(db: Session, award_id: int, division_id: int | None) -> list[AwardWinner]:
    division_filter = (
        AwardWinner.division_id.is_(None) if division_id is None else AwardWinner.division_id == division_id
    )
    return list(
        db.execute(
            select(AwardWinner).where(AwardWinner.award_id == award_id, division_filter).order_by(AwardWinner.id)
        ).scalars().all()
    )


@dataclass
class SlotState:
    division_id: int | None
    status: str
    team_ids: list[int] = field(default_factory=list)
    override_reason: str | None = None
    note: str | None = None
    moved_team_ids: list[int] = field(default_factory=list)


def _moved(db: Session, division_id: int | None, team_ids: list[int]) -> list[int]:
    if division_id is None:
        return []
    return [t for t in team_ids if (team := db.get(Team, t)) is not None and team.division_id != division_id]


def slot_state(db: Session, plugin: LoadedPlugin | None, award: Award, division_id: int | None) -> SlotState:
    rows = stored_winners(db, award.id, division_id)
    if rows:
        team_ids = [row.team_id for row in rows]
        origin = rows[0].origin
        status = {ORIGIN_JUDGED: "judged", ORIGIN_OVERRIDE: "overridden", ORIGIN_FINALIZED: "finalized"}[origin]
        return SlotState(
            division_id, status, team_ids,
            override_reason=rows[0].override_reason if origin == ORIGIN_OVERRIDE else None,
            moved_team_ids=_moved(db, division_id, team_ids),
        )
    if award.kind == JUDGED:
        return SlotState(division_id, "judged_pending")
    resolution = resolve(db, plugin, award, division_id)
    if not resolution.team_ids:
        return SlotState(division_id, "no_result", note=resolution.note)
    status = "provisional" if resolution.provisional else "resolved"
    return SlotState(division_id, status, list(resolution.team_ids), note=resolution.note)
