from __future__ import annotations

from award_helpers import create_session
from schedule_helpers import schedule, set_playing_windows
from test_qualification_finalize import _finalize, _uneven_session


def _event_with_teams(client, count=4, plugin="example-game") -> tuple[int, list[int]]:
    client.post("/api/event", json={"name": "Regional"})
    client.post("/api/event/game-plugin", json={"name": plugin})
    session_id = client.post("/api/sessions", json={"label": "Saturday"}).json()["id"]
    teams = []
    for i in range(count):
        team_id = client.post("/api/teams", json={"number": str(i + 1), "name": f"Team {i + 1}"}).json()["id"]
        client.post(f"/api/sessions/{session_id}/participants", json={"team_id": team_id, "checked_in": True})
        teams.append(team_id)
    return session_id, teams


def test_active_session_switch_backs_up_first(client, backup_reasons):
    session_id, _ = _event_with_teams(client)
    reasons = backup_reasons(client)
    assert client.post("/api/event/active-session", json={"session_id": 99999}).status_code == 404
    assert reasons == []
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    assert reasons == ["before-active-session"]


def test_game_plugin_change_backs_up_only_on_a_real_change(client, backup_reasons):
    client.post("/api/event", json={"name": "Regional"})
    reasons = backup_reasons(client)
    assert client.post("/api/event/game-plugin?dry_run=true", json={"name": "example-game"}).status_code == 200
    assert reasons == []
    assert client.post("/api/event/game-plugin", json={"name": "example-game"}).status_code == 200
    assert reasons == ["before-game-plugin"]
    assert client.post("/api/event/game-plugin", json={"name": "example-game"}).status_code == 200  # no-op
    assert client.delete("/api/event/game-plugin?dry_run=true").status_code == 200
    assert reasons == ["before-game-plugin"]
    assert client.delete("/api/event/game-plugin").status_code == 200
    assert reasons == ["before-game-plugin", "before-game-plugin"]


def test_schedule_generate_and_clear_back_up_first(client, backup_reasons):
    session_id, _ = _event_with_teams(client)
    client.post("/api/fields", json={"session_id": session_id, "name": "Field 1"})
    set_playing_windows(client, session_id)
    reasons = backup_reasons(client)

    assert schedule(client, session_id, [("qualification", 1)], dry_run=True).status_code == 201
    assert reasons == []
    assert schedule(client, session_id, [("qualification", 1)]).status_code == 201
    assert reasons == ["before-schedule"]
    cleared = client.delete(
        "/api/schedule", params={"session_id": session_id, "round_type": "qualification"}
    )
    assert cleared.status_code == 200, cleared.text
    assert reasons == ["before-schedule", "before-clear-schedule"]


def test_qualification_and_finals_steps_back_up_first(cooperative_client, backup_reasons):
    client = cooperative_client
    s1, _, _, _ = _uneven_session(client)
    client.post("/api/fields", json={"session_id": s1, "name": "Field 1"})
    reasons = backup_reasons(client)

    assert _finalize(client, s1, {"7": 1, "8": 2}).status_code == 200
    started = client.post("/api/finals/start", json={"session_id": s1, "bracket_size": 2})
    assert started.status_code == 201, started.text
    assert client.delete(f"/api/finals/{started.json()['id']}").status_code == 204
    assert client.post(f"/api/sessions/{s1}/qualification/reopen").status_code == 200
    assert reasons == ["before-qualification", "before-finals", "before-finals", "before-qualification"]


def test_session_delete_backs_up_first(client, backup_reasons):
    session_id, _ = _event_with_teams(client)
    reasons = backup_reasons(client)
    assert client.delete(f"/api/sessions/{session_id}").status_code == 204
    assert reasons == ["before-delete-session"]


def test_awards_finalize_backs_up_only_when_confirmed(client, backup_reasons):
    client.post("/api/event", json={"name": "Regional"})
    session_id = create_session(client)
    reasons = backup_reasons(client)
    assert client.post(f"/api/sessions/{session_id}/awards/finalize", json={}).status_code == 200
    assert reasons == []
    assert client.post(f"/api/sessions/{session_id}/awards/finalize", json={"confirm": True}).status_code == 200
    assert reasons == ["before-awards-finalize"]


def test_risky_step_still_succeeds_when_the_snapshot_fails(client, tmp_path):
    session_id, _ = _event_with_teams(client)
    blocker = tmp_path / "a-file"
    blocker.write_text("x")
    client.app.state.backups.config_path.write_text(
        '{"allowed_directories": [], "backup_dirs": {"%s": "%s"}}'
        % (str((tmp_path / "test.db").resolve()), str(blocker))
    )
    assert client.post("/api/event/active-session", json={"session_id": session_id}).status_code == 200
    assert client.get("/api/backups").json()["last_error"]["message"]
