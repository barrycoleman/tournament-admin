"""Shared setup for the skills run and skills timer tests."""
from __future__ import annotations

import datetime as dt

from sqlalchemy import select

from skills_helpers import create_event, create_session, enable_skills
from tournament_server.db import utc_now


def add_set(client, session_id: int, name: str, purpose: str = "skills", fields=("Skills 1", "Skills 2")) -> dict:
    created = client.post("/api/field-sets", json={"session_id": session_id, "name": name, "purpose": purpose})
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


def skills_event(client, attempts: dict[str, int] | None = None) -> dict:
    """An example-game event with skills on, teams "1".."3" (1 and 2 checked
    in), an active session, a skills set with two fields and a teamwork set
    with one."""
    teams = create_event(client)
    session_id = create_session(client, checked_in=teams[:2])
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    enable_skills(client, attempts)
    return {
        "teams": teams,
        "session_id": session_id,
        "set": add_set(client, session_id, "Skills Row A"),
        "teamwork": add_set(client, session_id, "Main Fields", purpose="teamwork", fields=("Field 1",)),
    }


def start_run(client, field_id: int, team_id: int, headers: dict | None = None, **body) -> dict:
    response = client.post(
        f"/api/fields/{field_id}/skills-run", json={"team_id": team_id, **body}, headers=headers or {}
    )
    assert response.status_code == 201, response.text
    return response.json()


def read_set(client, field_set_id: int) -> dict:
    response = client.get(f"/api/field-sets/{field_set_id}/skills")
    assert response.status_code == 200, response.text
    return response.json()


def runs_by_field(body: dict) -> dict[int, dict | None]:
    return {field["field_id"]: field["run"] for field in body["fields"]}


def run_on(client, field_set_id: int, field_id: int) -> dict | None:
    return runs_by_field(read_set(client, field_set_id))[field_id]


def run_length(client, skills_type: str) -> int:
    types = client.get("/api/skills/settings").json()["types"]
    return next(t["run_seconds"] for t in types if t["key"] == skills_type)


def expire(client, model, **where) -> None:
    """Moves a running timer's deadline one second into the past, straight in
    the test database (no real server is running against it)."""
    with client.app.state.session_factory() as db:
        row = db.execute(select(model).filter_by(**where)).scalars().one()
        row.deadline = utc_now() - dt.timedelta(seconds=1)
        db.commit()
