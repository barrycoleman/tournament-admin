"""Scoresheet helpers shared by teamwork drafts and skills runs."""
from __future__ import annotations

from typing import Any


def sheet_with_defaults(schema: list[dict[str, Any]], data: dict[str, Any]) -> dict[str, Any]:
    """A complete sheet: every schema item at its default, with `data` (the
    items someone entered) laid over it. A draft or run holds only the items
    that changed, while the scoring page shows the rest at their defaults, so
    scores and stored sheets must count them the same way."""
    return {**{field["name"]: field["default"] for field in schema}, **data}
