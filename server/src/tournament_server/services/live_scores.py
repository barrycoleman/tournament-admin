"""What displays may see of scores in progress, and pushing it to them
(live scoring design §7). Tasks 7 and 10 fill these in; until then every
hook is a no-op with its final signature, so callers can be wired now."""
from __future__ import annotations

from typing import Any


def on_switches_changed(app: Any, db: Any, session_id: int) -> None:
    """A session's live-score switch changed: re-evaluate its live matches."""
    return None


def on_draft_changed(app: Any, db: Any, match: Any) -> None:
    """A teamwork draft changed: push the match's live totals if allowed."""
    return None


def on_match_phase_changed(app: Any, db: Any, match: Any) -> None:
    """A match's clock moved: start or clear its live totals."""
    return None


def on_skills_changed(app: Any, db: Any, field_set_id: int) -> None:
    """A skills run or timer on this set changed: push its live scores."""
    return None
