"""Shared setup for the display-group tests."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select

from tournament_server.models.display import DisplayAssignment, DisplayGroup

BASE_TIME = dt.datetime(2026, 11, 7, 16, 0, tzinfo=dt.UTC)


def setup_event(client, game: str | None = "example-game") -> int:
    """Creates the event, picks its game and one active session; returns the session id."""
    client.post("/api/event", json={"name": "Display Event"})
    if game is not None:
        assert client.post("/api/event/game-plugin", json={"name": game}).status_code == 200
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    return session_id


def add_field_set(client, session_id: int, name: str = "Main Fields", fields=("Field 1", "Field 2")) -> dict:
    created = client.post("/api/field-sets", json={"session_id": session_id, "name": name})
    assert created.status_code == 201, created.text
    field_set_id = created.json()["id"]
    field_ids = []
    for field_name in fields:
        field = client.post(
            "/api/fields", json={"session_id": session_id, "field_set_id": field_set_id, "name": field_name}
        )
        assert field.status_code == 201, field.text
        field_ids.append(field.json()["id"])
    return {"id": field_set_id, "field_ids": field_ids}


def add_teams(client, count: int = 4, start: int = 101) -> list[int]:
    """Team numbers are unique per event: pass a different `start` to add a
    second batch in the same test."""
    ids = []
    for n in range(count):
        created = client.post(
            "/api/teams", json={"number": f"{start + n}A", "name": f"Team {n + 1}", "city": "Springfield"}
        )
        assert created.status_code == 201, created.text
        ids.append(created.json()["id"])
    return ids


def add_match(
    client,
    session_id: int,
    field_id: int | None,
    number: int,
    team_ids: list[int],
    *,
    minutes: int = 0,
    scheduled: bool = True,
    round_type: str = "qualification",
) -> dict:
    created = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": round_type,
            "match_number": number,
            "field_id": field_id,
            "scheduled_time": (BASE_TIME + dt.timedelta(minutes=minutes)).isoformat() if scheduled else None,
            "alliances": [
                {"station": "red", "team_ids": team_ids[:2]},
                {"station": "blue", "team_ids": team_ids[2:4]},
            ],
        },
    )
    assert created.status_code == 201, created.text
    return created.json()


def score_match(client, match: dict, high_balls=(3, 1)) -> None:
    for alliance, balls in zip(match["alliances"], high_balls):
        scored = client.post(
            f"/api/matches/{match['id']}/alliances/{alliance['id']}/score",
            json={"data": {"high_balls": balls, "low_balls": 0, "parked": False, "auto_winner": "tie"}},
        )
        assert scored.status_code == 200, scored.text


def groups(client, **filters) -> list[DisplayGroup]:
    with client.app.state.session_factory() as db:
        query = select(DisplayGroup)
        for key, value in filters.items():
            query = query.where(getattr(DisplayGroup, key) == value)
        return list(db.execute(query.order_by(DisplayGroup.id)).scalars().all())


def assignments(client) -> list[DisplayAssignment]:
    with client.app.state.session_factory() as db:
        return list(db.execute(select(DisplayAssignment).order_by(DisplayAssignment.id)).scalars().all())


def assign(client, session_id: int, group_id: int, device_id: int) -> None:
    with client.app.state.session_factory() as db:
        db.add(DisplayAssignment(session_id=session_id, device_id=device_id, group_id=group_id))
        db.commit()


def admin_token(client) -> str:
    return client.headers["Authorization"].removeprefix("Bearer ")
