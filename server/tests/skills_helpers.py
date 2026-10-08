"""Shared setup for the skills API tests."""
from __future__ import annotations

from pathlib import Path

from fastapi.testclient import TestClient

SECOND_GAME = Path(__file__).parent / "fixtures" / "plugins" / "games" / "second-game"


def create_event(client, team_count: int = 3) -> list[int]:
    """An example-game event with teams numbered "1".."N"."""
    client.post("/api/event", json={"name": "League"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    return [
        client.post("/api/teams", json={"number": str(n), "name": f"Team {n}"}).json()["id"]
        for n in range(1, team_count + 1)
    ]


def create_session(client, label: str = "Saturday", checked_in=(), session_date: str | None = None) -> int:
    body = {"label": label}
    if session_date is not None:
        body["session_date"] = session_date
    session_id = client.post("/api/sessions", json=body).json()["id"]
    for team_id in checked_in:
        response = client.post(
            f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True}
        )
        assert response.status_code == 201, response.text
    return session_id


def enable_skills(client, attempts: dict[str, int] | None = None) -> None:
    response = client.put("/api/skills/settings", json={"enabled": True, "attempts": attempts or {}})
    assert response.status_code == 200, response.text


def admin_token(client) -> str:
    return client.headers["Authorization"].removeprefix("Bearer ")


def admitted_device_token(client) -> str:
    """Registers a device and admits it (as the admin `client`); returns its token."""
    raw = TestClient(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json() if d["friendly_name"] == device["friendly_name"]
    )
    assert client.post(f"/api/devices/{device_id}/admit").status_code == 200
    return device["device_token"]


def next_event(socket, name: str) -> dict:
    """The next message called `name`, skipping any others."""
    while True:
        message = socket.receive_json()
        if message["event"] == name:
            return message


def record_attempt(
    client,
    session_id: int,
    team_id: int,
    skills_type: str = "driver",
    objects: int = 5,
    parked: bool = False,
    headers: dict | None = None,
):
    """POSTs an example-game attempt: score = objects * 2 (+4 for a parked autonomous run)."""
    data: dict = {"objects_scored": objects}
    if skills_type == "autonomous":
        data["parked"] = parked
    return client.post(
        f"/api/sessions/{session_id}/skills/attempts",
        json={"team_id": team_id, "skills_type": skills_type, "data": data},
        headers=headers or {},
    )
