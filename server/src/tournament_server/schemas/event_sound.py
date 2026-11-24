from __future__ import annotations

from pydantic import BaseModel


class SoundRead(BaseModel):
    slot: str
    replaced: bool
    filename: str | None
    uploaded_at: str | None
