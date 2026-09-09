from auth_helpers import bearer, login_as


def _setup_match(client):
    client.post("/api/event", json={"name": "Regional Qualifier"})
    client.post("/api/event/game-plugin", json={"name": "example-game"})
    session_id = client.post("/api/sessions", json={"label": "Session 1"}).json()["id"]
    t1 = client.post("/api/teams", json={"number": "1", "name": "Team One"}).json()["id"]
    t2 = client.post("/api/teams", json={"number": "2", "name": "Team Two"}).json()["id"]
    t3 = client.post("/api/teams", json={"number": "3", "name": "Team Three"}).json()["id"]
    t4 = client.post("/api/teams", json={"number": "4", "name": "Team Four"}).json()["id"]
    match = client.post(
        "/api/matches",
        json={
            "session_id": session_id,
            "round_type": "qualification",
            "match_number": 1,
            "field_id": None,
            "alliances": [
                {"station": "red", "team_ids": [t1, t2]},
                {"station": "blue", "team_ids": [t3, t4]},
            ],
        },
    ).json()
    red_id = next(a["id"] for a in match["alliances"] if a["station"] == "red")
    blue_id = next(a["id"] for a in match["alliances"] if a["station"] == "blue")
    return match["id"], red_id, blue_id


def test_submit_score(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
        headers={"X-Actor-Name": "shifty-squirrel"},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["computed_score"] == 5 * 3 + 2 * 1
    assert body["submitted_by_device"] == "shifty-squirrel"
    assert body["saved_at"] is not None


def test_resubmitting_score_updates_existing_record(client):
    match_id, red_id, blue_id = _setup_match(client)
    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 0, "auto_winner": "tie"}},
    )

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 17

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "scheduled"  # blue alliance hasn't scored yet


def test_submit_score_rejects_out_of_range_violations(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 999, "low_balls": 0, "auto_winner": "tie"}},
    )
    assert response.status_code == 422


def test_submit_score_force_overrides_violations(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={
            "data": {"high_balls": 999, "low_balls": 0, "auto_winner": "tie"},
            "force": True,
        },
    )
    assert response.status_code == 200


def test_no_show_zeroes_computed_score(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={
            "data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"},
            "no_show": True,
        },
    )
    assert response.status_code == 200
    assert response.json()["computed_score"] == 0


def test_match_marked_completed_once_both_alliances_scored(client):
    match_id, red_id, blue_id = _setup_match(client)
    client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": 5, "low_balls": 2, "auto_winner": "tie"}},
    )
    client.post(
        f"/api/matches/{match_id}/alliances/{blue_id}/score",
        json={"data": {"high_balls": 1, "low_balls": 1, "auto_winner": "tie"}},
    )

    match = client.get(f"/api/matches/{match_id}").json()
    assert match["status"] == "completed"


def test_submit_score_rejects_scoresheet_plugin_cannot_validate(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {"high_balls": "not-a-number", "low_balls": 0}},
    )
    assert response.status_code == 422


def test_submit_score_with_force_still_rejects_unscoreable_data(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={
            "data": {"high_balls": "not-a-number", "low_balls": 0},
            "force": True,
        },
    )
    assert response.status_code == 422


def test_submit_score_403s_for_attendee(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    attendee_token = login_as(raw, "attendee")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers=bearer(attendee_token),
    )
    assert response.status_code == 403


def test_submit_score_succeeds_for_scorer_and_referee(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)

    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    for role in ("scorer", "referee"):
        token = login_as(raw, role)
        response = raw.post(
            f"/api/matches/{match_id}/alliances/{red_id}/score",
            json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
            headers={**bearer(token), "X-Device-Token": device["device_token"]},
        )
        assert response.status_code == 200, f"{role} should be able to submit a score"


def test_pending_device_cannot_submit_score_as_scorer(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert response.status_code == 403


def test_missing_device_token_rejected_for_scorer(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers=bearer(scorer_token),
    )
    assert response.status_code == 401


def test_unknown_device_token_rejected_for_scorer(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": "not-a-real-token"},
    )
    assert response.status_code == 401


def test_idle_device_rejected_until_explicitly_re_admitted(client):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.scoring_device import ScoringDevice

    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")
    scorer_token = login_as(raw, "scorer")

    db = client.app.state.session_factory()
    row = db.get(ScoringDevice, device_id)
    row.last_seen_at = utc_now() - dt.timedelta(hours=2)
    db.commit()
    db.close()

    stale_response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert stale_response.status_code == 403

    # The rejected attempt above must NOT have silently revived the
    # device — a second, immediately-following identical attempt still
    # 403s, proving only an explicit re-admit (not mere retrying) restores
    # access.
    still_rejected = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert still_rejected.status_code == 403

    client.post(f"/api/devices/{device_id}/admit")
    fresh_response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert fresh_response.status_code == 200


def test_idle_device_not_revived_by_a_successful_non_scoring_request(client):
    import datetime as dt

    from tournament_server.db import utc_now
    from tournament_server.models.scoring_device import ScoringDevice

    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")
    scorer_token = login_as(raw, "scorer")

    db = client.app.state.session_factory()
    row = db.get(ScoringDevice, device_id)
    row.last_seen_at = utc_now() - dt.timedelta(hours=2)
    db.commit()
    db.close()

    successful_read = raw.get(
        "/api/divisions",
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert successful_read.status_code == 200

    listed = client.get("/api/devices").json()
    matched = next(d for d in listed if d["id"] == device_id)
    assert matched["status"] == "idle"

    still_rejected = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert still_rejected.status_code == 403


def test_revoked_device_cannot_submit_score(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")
    client.post(f"/api/devices/{device_id}/revoke")
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert response.status_code == 403


def test_admitted_device_attributes_the_score_by_friendly_name(client):
    match_id, red_id, blue_id = _setup_match(client)
    raw = client.__class__(client.app)
    device = raw.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")
    scorer_token = login_as(raw, "scorer")

    response = raw.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={**bearer(scorer_token), "X-Device-Token": device["device_token"]},
    )
    assert response.status_code == 200
    assert response.json()["submitted_by_device"] == device["friendly_name"]


def test_admin_bypasses_device_gate_entirely(client):
    match_id, red_id, blue_id = _setup_match(client)

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
    )
    assert response.status_code == 200


def test_admin_with_admitted_device_still_gets_device_attribution(client):
    # The subtle case: admin bypasses require_admitted_device's *rejection*,
    # but the dependency still *resolves* a present, valid device token —
    # so attribution stays accurate for an admin using a real device too,
    # it's not just "admin always falls back to the actor header."
    match_id, red_id, blue_id = _setup_match(client)
    device = client.post("/api/devices/register").json()
    device_id = next(
        d["id"] for d in client.get("/api/devices").json()
        if d["friendly_name"] == device["friendly_name"]
    )
    client.post(f"/api/devices/{device_id}/admit")

    response = client.post(
        f"/api/matches/{match_id}/alliances/{red_id}/score",
        json={"data": {}, "no_show": True, "dq": False, "sitting": False, "force": True},
        headers={"X-Device-Token": device["device_token"]},
    )
    assert response.status_code == 200
    assert response.json()["submitted_by_device"] == device["friendly_name"]
