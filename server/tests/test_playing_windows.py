SAT_MORNING = {"date": "2026-11-07", "start_time": "09:00", "end_time": "12:00"}
SAT_AFTERNOON = {"date": "2026-11-07", "start_time": "13:00", "end_time": "17:00"}
SUN = {"date": "2026-11-08", "start_time": "09:00", "end_time": "15:00"}


def _session(client, timezone: str | None = "America/Los_Angeles") -> int:
    client.post("/api/event", json={"name": "Regional Qualifier"})
    body = {"label": "Weekend", "session_date": "2026-11-07"}
    if timezone is not None:
        body["timezone"] = timezone
    return client.post("/api/sessions", json=body).json()["id"]


def _put(client, session_id, windows):
    return client.put(f"/api/sessions/{session_id}/playing-windows", json={"windows": windows})


def test_a_new_session_has_no_playing_windows(client):
    session_id = _session(client)
    response = client.get(f"/api/sessions/{session_id}/playing-windows")
    assert response.status_code == 200
    assert response.json() == []


def test_put_stores_windows_sorted_with_their_utc_bounds(client):
    session_id = _session(client)
    response = _put(client, session_id, [SUN, SAT_AFTERNOON, SAT_MORNING])
    assert response.status_code == 200, response.text
    assert response.json() == [
        {**SAT_MORNING, "start_utc": "2026-11-07T17:00:00Z", "end_utc": "2026-11-07T20:00:00Z"},
        {**SAT_AFTERNOON, "start_utc": "2026-11-07T21:00:00Z", "end_utc": "2026-11-08T01:00:00Z"},
        {**SUN, "start_utc": "2026-11-08T17:00:00Z", "end_utc": "2026-11-08T23:00:00Z"},
    ]
    assert client.get(f"/api/sessions/{session_id}/playing-windows").json() == response.json()


def test_put_replaces_rather_than_appends(client):
    session_id = _session(client)
    _put(client, session_id, [SAT_MORNING, SAT_AFTERNOON])
    _put(client, session_id, [SUN])
    windows = client.get(f"/api/sessions/{session_id}/playing-windows").json()
    assert [(w["date"], w["start_time"]) for w in windows] == [("2026-11-08", "09:00")]


def test_put_with_no_windows_clears_them(client):
    session_id = _session(client)
    _put(client, session_id, [SAT_MORNING])
    assert _put(client, session_id, []).json() == []


def test_adjacent_windows_and_same_times_on_different_days_are_allowed(client):
    session_id = _session(client)
    touching = {"date": "2026-11-07", "start_time": "12:00", "end_time": "13:00"}
    response = _put(client, session_id, [SAT_MORNING, touching, SAT_AFTERNOON, {**SAT_MORNING, "date": "2026-11-08"}])
    assert response.status_code == 200, response.text


def test_rejects_a_window_that_ends_before_it_starts(client):
    session_id = _session(client)
    response = _put(client, session_id, [{"date": "2026-11-07", "start_time": "12:00", "end_time": "09:00"}])
    assert response.status_code == 422
    assert "must end after it starts" in response.json()["detail"]


def test_rejects_overlapping_windows_on_the_same_day(client):
    session_id = _session(client)
    overlapping = {"date": "2026-11-07", "start_time": "11:00", "end_time": "14:00"}
    response = _put(client, session_id, [SAT_MORNING, overlapping])
    assert response.status_code == 422
    assert "overlap" in response.json()["detail"]


def test_rejects_an_invalid_clock_time(client):
    session_id = _session(client)
    response = _put(client, session_id, [{"date": "2026-11-07", "start_time": "09:00", "end_time": "24:00"}])
    assert response.status_code == 422


def test_rejects_more_than_fifty_windows(client):
    session_id = _session(client)
    windows = [
        {"date": f"2026-12-{day:02d}", "start_time": f"{hour:02d}:00", "end_time": f"{hour:02d}:30"}
        for day in range(1, 27)
        for hour in (9, 10)
    ]
    assert len(windows) == 52
    response = _put(client, session_id, windows)
    assert response.status_code == 422
    assert "at most 50" in response.json()["detail"]


def test_rejects_windows_for_a_session_without_a_timezone(client):
    session_id = _session(client, timezone=None)
    response = _put(client, session_id, [SAT_MORNING])
    assert response.status_code == 422
    assert "timezone" in response.json()["detail"]


def test_unknown_session_is_404(client):
    _session(client)
    assert client.get("/api/sessions/999/playing-windows").status_code == 404
    assert _put(client, 999, [SAT_MORNING]).status_code == 404


def test_playing_windows_require_the_admin_role(client):
    from tests.auth_helpers import bearer, login_as

    session_id = _session(client)
    token = login_as(client, "front_desk")
    response = client.get(f"/api/sessions/{session_id}/playing-windows", headers=bearer(token))
    assert response.status_code == 403
