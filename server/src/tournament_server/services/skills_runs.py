"""Skills runs and skills field-set timers (live scoring design §4.3, §4.4,
§6). Task 2 adds only the set timer's lifecycle. Nothing here commits."""
from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.field_set import SKILLS, FieldSet
from tournament_server.models.scoring_draft import SkillsSetTimer

SKILLS_SET_DETAIL = "This is a skills field set."


def ensure_set_timer(db: Session, field_set: FieldSet) -> SkillsSetTimer | None:
    """A skills set has exactly one timer row and a teamwork set none: this
    creates or deletes the row to match the set's purpose and returns the
    timer (None for a teamwork set). The timer's skills type stays null
    until it is chosen; readers fall back to the game's first type."""
    timer = db.execute(
        select(SkillsSetTimer).where(SkillsSetTimer.field_set_id == field_set.id)
    ).scalars().first()
    if field_set.purpose == SKILLS:
        if timer is None:
            timer = SkillsSetTimer(field_set_id=field_set.id)
            db.add(timer)
            db.flush()
        return timer
    if timer is not None:
        db.delete(timer)
        db.flush()
    return None
