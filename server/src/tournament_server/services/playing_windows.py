from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from tournament_server.models.playing_window import SessionPlayingWindow

MAX_WINDOWS = 50


def validate_windows(windows: list[dict]) -> list[dict]:
    """Returns the windows sorted by (date, start_time), or raises ValueError
    naming the first problem. Clock times are zero-padded HH:MM strings, so
    comparing them as strings compares them as times. A window ending
    exactly when the next one starts is allowed."""
    if len(windows) > MAX_WINDOWS:
        raise ValueError(f"A session can have at most {MAX_WINDOWS} playing windows")
    ordered = sorted(windows, key=lambda w: (w["date"], w["start_time"]))
    for window in ordered:
        if window["end_time"] <= window["start_time"]:
            raise ValueError(
                f"The playing window on {window['date'].isoformat()} starting at "
                f"{window['start_time']} must end after it starts"
            )
    for current, following in zip(ordered, ordered[1:]):
        if current["date"] == following["date"] and following["start_time"] < current["end_time"]:
            raise ValueError(
                f"Playing windows on {current['date'].isoformat()} overlap: "
                f"{current['start_time']}-{current['end_time']} and "
                f"{following['start_time']}-{following['end_time']}"
            )
    return ordered


def load_windows(db: Session, session_id: int) -> list[dict]:
    rows = db.execute(
        select(SessionPlayingWindow)
        .where(SessionPlayingWindow.session_id == session_id)
        .order_by(SessionPlayingWindow.date, SessionPlayingWindow.start_time)
    ).scalars().all()
    return [
        {"date": row.date, "start_time": row.start_time, "end_time": row.end_time}
        for row in rows
    ]
