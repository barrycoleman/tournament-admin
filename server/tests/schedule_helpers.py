"""Shared setup for tests that generate schedules: every schedule now
needs a session timezone and at least one playing window."""

PLAY_DATE = "2026-11-07"
TZ = "America/Los_Angeles"
ALL_DAY = [{"date": PLAY_DATE, "start_time": "08:00", "end_time": "20:00"}]
DEFAULT_CYCLE = 300


def set_playing_windows(client, session_id: int, windows=ALL_DAY) -> None:
    client.patch(f"/api/sessions/{session_id}", json={"timezone": TZ})
    response = client.put(f"/api/sessions/{session_id}/playing-windows", json={"windows": windows})
    assert response.status_code == 200, response.text


def schedule(
    client,
    session_id: int,
    rounds,
    *,
    division_id: int | None = None,
    scheduler: str = "simple_random",
    dry_run: bool = False,
):
    """`rounds` is a list of (round_type, matches_per_team) or
    (round_type, matches_per_team, cycle_time_seconds) tuples."""
    body = {
        "session_id": session_id,
        "scheduler_plugin_name": scheduler,
        "rounds": [
            {
                "round_type": entry[0],
                "target_matches_per_team": entry[1],
                "cycle_time_seconds": entry[2] if len(entry) > 2 else DEFAULT_CYCLE,
            }
            for entry in rounds
        ],
        "dry_run": dry_run,
    }
    if division_id is not None:
        body["division_id"] = division_id
    return client.post("/api/schedule", json=body)
