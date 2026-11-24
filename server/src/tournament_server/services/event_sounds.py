from __future__ import annotations

from importlib import resources

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.db import utc_now
from tournament_server.models.event_sound import EventSound

SLOTS = ("beep", "start", "buzzer", "moment", "stop")
MAX_BYTES = 1_048_576


class SoundRejected(ValueError):
    pass


def detect_content_type(data: bytes) -> str | None:
    if data[:3] == b"ID3" or (len(data) >= 2 and data[0] == 0xFF and data[1] & 0xE0 == 0xE0):
        return "audio/mpeg"
    if data[:4] == b"OggS":
        return "audio/ogg"
    if data[:4] == b"RIFF" and data[8:12] == b"WAVE":
        return "audio/wav"
    return None


def validate_upload(data: bytes) -> str:
    if not data:
        raise SoundRejected("The sound file is empty.")
    if len(data) > MAX_BYTES:
        raise SoundRejected(f"The sound file is larger than the limit of {MAX_BYTES} bytes (1 MB).")
    content_type = detect_content_type(data)
    if content_type is None:
        raise SoundRejected("The sound must be an MP3, OGG or WAV file (limit 1 MB).")
    return content_type


def default_bytes(slot: str) -> bytes:
    return (resources.files("tournament_server") / "default_sounds" / f"{slot}.mp3").read_bytes()


def read_sound(row: EventSound | None, slot: str) -> dict:
    return {
        "slot": slot,
        "replaced": row is not None,
        "filename": row.filename if row else None,
        "uploaded_at": row.uploaded_at.isoformat() if row else None,
    }


def list_sounds(db: Session) -> list[dict]:
    rows = {r.slot: r for r in db.scalars(select(EventSound))}
    return [read_sound(rows.get(slot), slot) for slot in SLOTS]


def get_row(db: Session, slot: str) -> EventSound | None:
    return db.scalars(select(EventSound).where(EventSound.slot == slot)).first()


def replace_sound(db: Session, slot: str, filename: str, data: bytes) -> EventSound:
    content_type = validate_upload(data)
    row = get_row(db, slot)
    if row is None:
        row = EventSound(slot=slot)
        db.add(row)
    row.filename = (filename or f"{slot}")[:200]
    row.content_type = content_type
    row.data = data
    row.uploaded_at = utc_now()
    db.commit()
    return row


def restore_default(db: Session, slot: str) -> None:
    row = get_row(db, slot)
    if row is not None:
        db.delete(row)
        db.commit()
