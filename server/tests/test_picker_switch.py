from auth_helpers import bearer, login_as


def test_switch_tournament_requires_authentication(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    response = raw.post("/api/picker/switch")
    assert response.status_code == 401


def test_switch_tournament_403s_for_non_admin(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")
    response = raw.post("/api/picker/switch", headers=bearer(attendee_token))
    assert response.status_code == 403


def test_switch_tournament_clears_last_opened_path_and_restarts(client, monkeypatch):
    from tournament_server.picker_config import PickerConfig, load_config, save_config

    calls = []
    monkeypatch.setattr(
        "os.execve", lambda executable, args, env: calls.append((executable, args))
    )
    config_path = client.app.state.picker_config_path
    save_config(config_path, PickerConfig(allowed_directories=[], last_opened_path="/whatever.db"))

    client.post("/api/event", json={"name": "Regional Qualifier"})
    response = client.post("/api/picker/switch")

    assert response.status_code == 202
    assert len(calls) == 1
    assert load_config(config_path).last_opened_path is None
