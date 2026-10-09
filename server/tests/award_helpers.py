"""Shared setup for the awards tests."""
from __future__ import annotations

from contextlib import contextmanager


def setup_two_divisions(client, per_division: int = 3) -> tuple[int, int, dict[str, int]]:
    """An example-game event with Division 1 (teams A1..An) and Division 2 (B1..Bn)."""
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    first = client.get("/api/divisions").json()[0]["id"]
    second = client.post("/api/divisions", json={"name": "Division 2"}).json()["id"]
    teams: dict[str, int] = {}
    for division_id, prefix in ((first, "A"), (second, "B")):
        for n in range(1, per_division + 1):
            number = f"{prefix}{n}"
            response = client.post(
                "/api/teams", json={"number": number, "name": f"Team {number}", "division_id": division_id}
            )
            assert response.status_code == 201, response.text
            teams[number] = response.json()["id"]
    return first, second, teams


def create_session(client, label: str = "Saturday", session_date: str | None = None) -> int:
    body = {"label": label}
    if session_date is not None:
        body["session_date"] = session_date
    return client.post("/api/sessions", json=body).json()["id"]


def enter(client, session_id: int, *team_ids: int) -> None:
    """Gives each team a (checked-in) participation row in the session."""
    for team_id in team_ids:
        response = client.post(
            f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True}
        )
        assert response.status_code == 201, response.text


@contextmanager
def db_session(client):
    db = client.app.state.session_factory()
    try:
        yield db
    finally:
        db.close()
