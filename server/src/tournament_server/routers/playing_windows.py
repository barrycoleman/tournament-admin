from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import delete
from sqlalchemy.orm import Session

from tournament_server.auth import require_admin
from tournament_server.deps import get_db
from tournament_server.models.playing_window import SessionPlayingWindow
from tournament_server.models.session import TournamentSession
from tournament_server.schemas.playing_window import PlayingWindowRead, PlayingWindowsReplace
from tournament_server.services.playing_windows import load_windows, validate_windows
from tournament_server.services.schedule_timing import block_utc_bounds

router = APIRouter(prefix="/api/sessions", tags=["playing-windows"])


def _read_models(windows: list[dict], timezone_name: str | None) -> list[PlayingWindowRead]:
    models = []
    for window in windows:
        start_utc = end_utc = None
        if timezone_name is not None:
            start_utc, end_utc = block_utc_bounds(window, timezone_name)
        models.append(PlayingWindowRead(**window, start_utc=start_utc, end_utc=end_utc))
    return models


def _get_session(db: Session, session_id: int) -> TournamentSession:
    session = db.get(TournamentSession, session_id)
    if session is None:
        raise HTTPException(status_code=404, detail="Session not found")
    return session


@router.get("/{session_id}/playing-windows", response_model=list[PlayingWindowRead])
def read_playing_windows(
    session_id: int,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> list[PlayingWindowRead]:
    session = _get_session(db, session_id)
    return _read_models(load_windows(db, session_id), session.timezone)


@router.put("/{session_id}/playing-windows", response_model=list[PlayingWindowRead])
def replace_playing_windows(
    session_id: int,
    payload: PlayingWindowsReplace,
    db: Session = Depends(get_db),
    _role: str = Depends(require_admin),
) -> list[PlayingWindowRead]:
    """Replaces every playing window at once. Matches already scheduled
    never move when the windows change; the Schedule tab flags rounds that
    now fall outside them."""
    session = _get_session(db, session_id)
    if session.timezone is None:
        raise HTTPException(
            status_code=422, detail="Set the session's timezone before adding playing times"
        )
    try:
        ordered = validate_windows([window.model_dump() for window in payload.windows])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    db.execute(delete(SessionPlayingWindow).where(SessionPlayingWindow.session_id == session_id))
    for window in ordered:
        db.add(SessionPlayingWindow(session_id=session_id, **window))
    db.commit()
    return _read_models(load_windows(db, session_id), session.timezone)
